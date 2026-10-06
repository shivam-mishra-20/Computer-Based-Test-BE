import axios from 'axios';
import User from '../models/User';
import Attendance from '../models/Attendance';
import AuditLog from '../models/AuditLog';
import SocketService from './SocketService';
import {
  EtimePunch,
  PunchDay,
  checkSyncRange,
  dayNeedsWrite,
  formatDdMmYyyy,
  groupPunchesByDay,
  idempotencyKeyFor,
  isNoDataMessage,
  splitIntoWindows,
  storedDateFor,
} from './etimeSyncLogic';

// The API returns data wrapped in an object with PunchData array
interface EtimeResponse {
  Error: boolean;
  Msg: string;
  IsAdmin?: boolean;
  PunchData: EtimePunch[];
}

export interface EtimeSyncProgress {
  stage: 'fetching' | 'saving';
  /** Windows fetched so far while fetching; records handled so far while saving. */
  done: number;
  total: number;
}

export interface EtimeSyncResult {
  /** Device days that belong to a known user (written + unchanged + failed). */
  processed: number;
  failed: number;
  /** Users whose stored attendance actually changed in this sync. */
  updatedUserIds: string[];
  written: number;
  unchanged: number;
  totalPunches: number;
  skippedPunches: number;
  unmatched: number;
  unmatchedCodes: string[];
  windows: number;
  errors: string[];
}

const REQUEST_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = [2_000, 5_000];
const WINDOW_DAYS = 31;
const WRITE_CONCURRENCY = 8;
const LOOKUP_CHUNK = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pulls punches from eTimeOffice and stores one attendance record per person
 * per day.
 *
 * The sync finishes its own writes before it returns. Earlier it handed every
 * day to an in-memory queue that slept 100 ms per record, so the caller could
 * only guess when the data had landed — and a month-to-date sync took minutes.
 * Now the result describes what is actually in the database.
 */
class EtimeService {
  private static instance: EtimeService;
  private baseUrl: string;
  // Basic Auth credentials for eTimeOffice API
  private basicAuthUsername: string = 'AbhigyanGurukul:AbhigyanGurukul:ABGU4698@:true';
  private basicAuthPassword: string = ''; // Empty password as per API requirements

  private constructor() {
    this.baseUrl = process.env.ETIME_API_URL || 'https://api.etimeoffice.com/api';
  }

  public static getInstance(): EtimeService {
    if (!EtimeService.instance) {
      EtimeService.instance = new EtimeService();
    }
    return EtimeService.instance;
  }

  /**
   * Get Basic Auth header for eTimeOffice API
   * Username: AbhigyanGurukul:AbhigyanGurukul:ABGU4698@:true
   * Password: (empty)
   */
  private getBasicAuthHeader(): string {
    const credentials = Buffer.from(`${this.basicAuthUsername}:${this.basicAuthPassword}`).toString('base64');
    return `Basic ${credentials}`;
  }

  /** One window from the device, retried on failure. "No data" is an empty window. */
  private async fetchWindow(fromDate: string, toDate: string): Promise<EtimePunch[]> {
    const apiUrl = `${this.baseUrl}/DownloadPunchData`;
    const params = {
      Empcode: 'ALL',
      FromDate: `${fromDate}_00:00`,
      ToDate: `${toDate}_23:59`,
    };

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) {
        console.warn(`[Etime] Retrying ${fromDate}–${toDate} (attempt ${attempt + 1}): ${lastError?.message}`);
        await sleep(RETRY_DELAYS_MS[attempt - 1]);
      }
      try {
        const response = await axios.get<EtimeResponse>(apiUrl, {
          params,
          headers: { Authorization: this.getBasicAuthHeader() },
          timeout: REQUEST_TIMEOUT_MS,
        });
        if (response.data?.Error) {
          if (isNoDataMessage(response.data.Msg)) return [];
          throw new Error(`eTimeOffice API Error: ${response.data.Msg}`);
        }
        return Array.isArray(response.data?.PunchData) ? response.data.PunchData : [];
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw new Error(
      `Could not read punches for ${fromDate} to ${toDate} from the device service: ${lastError?.message}`,
    );
  }

  /**
   * Fetch attendance for a date range and store it.
   * @param fromDate Format: dd/mm/yyyy
   * @param toDate Format: dd/mm/yyyy
   */
  public async syncAttendance(
    fromDate: string,
    toDate: string,
    options: { onProgress?: (progress: EtimeSyncProgress) => void } = {},
  ): Promise<EtimeSyncResult> {
    const report = options.onProgress || (() => {});
    console.log(`[Etime] Sync ${fromDate} to ${toDate}`);

    try {
      const range = checkSyncRange(fromDate, toDate);
      if (!range.ok) throw new Error(range.message);

      // ── 1. Read the device, a month at a time ───────────────────────────
      const windows = splitIntoWindows(range.from, range.to, WINDOW_DAYS);
      const punches: EtimePunch[] = [];
      report({ stage: 'fetching', done: 0, total: windows.length });
      for (let i = 0; i < windows.length; i += 1) {
        const window = windows[i];
        const batch = await this.fetchWindow(formatDdMmYyyy(window.from), formatDdMmYyyy(window.to));
        punches.push(...batch);
        report({ stage: 'fetching', done: i + 1, total: windows.length });
      }
      console.log(`[Etime] ${punches.length} punches in ${windows.length} window(s)`);

      // ── 2. One day per person, matched to a user by employee code ───────
      const { days, skipped } = groupPunchesByDay(punches);

      const potentialUsers = await User.find({ empCode: { $exists: true, $ne: null } })
        .select('_id empCode')
        .lean();
      const userMap = new Map<string, string>();
      potentialUsers.forEach((u: any) => {
        if (u.empCode) userMap.set(String(u.empCode).trim(), String(u._id));
      });

      const matched: Array<{ day: PunchDay; userId: string; key: string }> = [];
      const unmatchedCodes = new Set<string>();
      let unmatched = 0;
      for (const day of days) {
        const userId = userMap.get(day.code);
        if (!userId) {
          unmatched += 1;
          unmatchedCodes.add(day.code);
          continue;
        }
        matched.push({ day, userId, key: idempotencyKeyFor(day) });
      }

      // ── 3. Compare with what is stored, in a few large reads ────────────
      const existing = new Map<string, any>();
      for (let i = 0; i < matched.length; i += LOOKUP_CHUNK) {
        const keys = matched.slice(i, i + LOOKUP_CHUNK).map((item) => item.key);
        const rows = await Attendance.find({ idempotencyKey: { $in: keys } })
          .select('idempotencyKey studentId date status clockIn clockOut metadata.punchCount')
          .lean();
        rows.forEach((row: any) => existing.set(row.idempotencyKey, row));
      }

      const pending = matched.filter(({ day, userId, key }) =>
        dayNeedsWrite(existing.get(key), {
          studentId: userId,
          date: storedDateFor(day.datePart),
          status: 'present',
          clockIn: day.clockIn,
          clockOut: day.clockOut,
          punchCount: day.punchCount,
        }),
      );
      const unchanged = matched.length - pending.length;

      // ── 4. Write only what changed ──────────────────────────────────────
      let written = 0;
      let failed = 0;
      let handled = 0;
      const errors: string[] = [];
      const updatedUserIds = new Set<string>();
      report({ stage: 'saving', done: 0, total: pending.length });

      for (let i = 0; i < pending.length; i += WRITE_CONCURRENCY) {
        const slice = pending.slice(i, i + WRITE_CONCURRENCY);
        const outcomes = await Promise.allSettled(
          slice.map(({ day, userId, key }) => this.writeDay(day, userId, key)),
        );
        outcomes.forEach((outcome, index) => {
          if (outcome.status === 'fulfilled') {
            written += 1;
            updatedUserIds.add(slice[index].userId);
          } else {
            failed += 1;
            if (errors.length < 5) {
              errors.push(`${slice[index].key}: ${outcome.reason?.message || outcome.reason}`);
            }
          }
        });
        handled += slice.length;
        report({ stage: 'saving', done: handled, total: pending.length });
      }

      const result: EtimeSyncResult = {
        processed: matched.length,
        failed,
        updatedUserIds: Array.from(updatedUserIds),
        written,
        unchanged,
        totalPunches: punches.length,
        skippedPunches: skipped,
        unmatched,
        unmatchedCodes: Array.from(unmatchedCodes).slice(0, 20),
        windows: windows.length,
        errors,
      };

      console.log(
        `[Etime] Done: ${matched.length} days (${written} written, ${unchanged} unchanged, ${failed} failed), ` +
          `${unmatched} days with unknown employee codes`,
      );

      await AuditLog.create({
        action: 'SYNC_ETIME',
        status: failed > 0 && written === 0 ? 'failure' : 'success',
        entity: 'System',
        metadata: {
          fromDate,
          toDate,
          totalPunches: punches.length,
          groupsProcessed: days.length,
          processed: matched.length,
          written,
          unchanged,
          failed,
          unmatched,
        },
      });

      return result;
    } catch (error: any) {
      console.error('Etime Sync Error:', error.message);
      await AuditLog.create({
        action: 'SYNC_ETIME',
        status: 'failure',
        entity: 'System',
        errorMessage: error.message,
        metadata: { fromDate, toDate },
      }).catch(() => {});
      throw error;
    }
  }

  /**
   * The same upsert the attendance worker always made for these records, so a
   * day stored by an earlier sync is updated in place rather than duplicated.
   */
  private async writeDay(day: PunchDay, userId: string, key: string): Promise<void> {
    const updateDoc = {
      studentId: userId,
      date: storedDateFor(day.datePart),
      status: 'present',
      markedBy: userId,
      source: 'external',
      idempotencyKey: key,
      metadata: {
        punchCount: day.punchCount,
        firstPunchTime: day.firstPunchTime,
        lastPunchTime: day.lastPunchTime,
        apiName: day.apiName,
        mFlag: day.mFlag,
      },
      clockIn: day.clockIn,
      ...(day.clockOut && { clockOut: day.clockOut }),
    };

    const attendance = await Attendance.findOneAndUpdate(
      { idempotencyKey: key },
      { $set: updateDoc },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    try {
      SocketService.emitToUser(userId, 'attendance_update', attendance);
    } catch {
      // A missed live update is not a failed save; the record is stored.
    }
  }
}

export default EtimeService.getInstance();
