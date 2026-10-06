import mongoose from 'mongoose';
import AuditLog from '../models/AuditLog';
import EtimeService, { EtimeSyncProgress, EtimeSyncResult } from './EtimeService';
import {
  AUTO_SYNC_GRACE_MS,
  ScheduleSlot,
  assessAutoSync,
  checkSyncRange,
  formatIsoDay,
  nextScheduledRun,
  parseDdMmYyyy,
} from './etimeSyncLogic';

/**
 * Every biometric sync — clicked by an admin or run by the scheduler — is a
 * "run" with a record the admin page can watch.
 *
 * ── Why runs are stored, not held in memory ─────────────────────────────────
 * The server runs as several processes. The request that starts a sync and the
 * request that asks "is it finished?" can land on different ones, so the
 * answer has to live in the database. Runs are kept in the existing audit log
 * collection (the cluster is at its collection limit, so a new one cannot be
 * created) and expire with it after 30 days.
 *
 * ── Why "stalled" exists ────────────────────────────────────────────────────
 * A run whose process restarts mid-sync never writes its ending. Without a
 * cut-off it would read "running" forever and the page would wait forever.
 */

export const SYNC_RUN_ACTION = 'ATTENDANCE_SYNC_RUN';
const STALLED_AFTER_MS = AUTO_SYNC_GRACE_MS;
const PROGRESS_WRITE_EVERY_MS = 1_500;

export type SyncTrigger = 'manual' | 'cron' | 'api';
export type SyncRunState = 'running' | 'success' | 'failure' | 'stalled';

export interface SyncRunView {
  id: string;
  state: SyncRunState;
  trigger: SyncTrigger;
  from: string | null; // yyyy-mm-dd
  to: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  stage: EtimeSyncProgress['stage'] | null;
  progress: { done: number; total: number } | null;
  result: Omit<EtimeSyncResult, 'updatedUserIds'> & { usersUpdated: number } | null;
  error: string | null;
}

function isoOf(ddmmyyyy: string): string | null {
  const parts = parseDdMmYyyy(ddmmyyyy);
  return parts ? formatIsoDay(parts) : null;
}

function toView(doc: any, now = Date.now()): SyncRunView {
  const meta = doc?.metadata || {};
  const startedAt = new Date(meta.startedAt || doc.createdAt);
  let state: SyncRunState = meta.state || (doc.status === 'failure' ? 'failure' : 'success');
  if (state === 'running' && now - startedAt.getTime() > STALLED_AFTER_MS) state = 'stalled';

  return {
    id: String(doc._id),
    state,
    trigger: meta.trigger || 'manual',
    from: isoOf(meta.fromDate),
    to: isoOf(meta.toDate),
    startedAt: startedAt.toISOString(),
    finishedAt: meta.finishedAt ? new Date(meta.finishedAt).toISOString() : null,
    durationMs: typeof meta.durationMs === 'number' ? meta.durationMs : null,
    stage: meta.stage || null,
    progress: meta.progress || null,
    result: meta.result || null,
    error: doc.errorMessage || null,
  };
}

function summarize(result: EtimeSyncResult) {
  const { updatedUserIds, ...rest } = result;
  return { ...rest, usersUpdated: updatedUserIds.length };
}

/** Creates the run record and performs the sync, updating the record as it goes. */
async function execute(
  runId: mongoose.Types.ObjectId,
  fromDate: string,
  toDate: string,
): Promise<EtimeSyncResult> {
  const startedAt = Date.now();
  let lastWrite = 0;

  const onProgress = (progress: EtimeSyncProgress) => {
    const now = Date.now();
    const finalStep = progress.done === progress.total;
    if (!finalStep && now - lastWrite < PROGRESS_WRITE_EVERY_MS) return;
    lastWrite = now;
    AuditLog.updateOne(
      { _id: runId },
      {
        $set: {
          'metadata.stage': progress.stage,
          'metadata.progress': { done: progress.done, total: progress.total },
        },
      },
    ).catch(() => {});
  };

  try {
    const result = await EtimeService.syncAttendance(fromDate, toDate, { onProgress });
    await AuditLog.updateOne(
      { _id: runId },
      {
        $set: {
          status: 'success',
          'metadata.state': 'success',
          'metadata.finishedAt': new Date(),
          'metadata.durationMs': Date.now() - startedAt,
          'metadata.result': summarize(result),
        },
      },
    );
    return result;
  } catch (error: any) {
    await AuditLog.updateOne(
      { _id: runId },
      {
        $set: {
          status: 'failure',
          errorMessage: error?.message || String(error),
          'metadata.state': 'failure',
          'metadata.finishedAt': new Date(),
          'metadata.durationMs': Date.now() - startedAt,
        },
      },
    ).catch(() => {});
    throw error;
  }
}

async function createRun(fromDate: string, toDate: string, trigger: SyncTrigger, userId?: string) {
  const doc = await AuditLog.create({
    action: SYNC_RUN_ACTION,
    entity: 'Attendance',
    ...(userId && mongoose.Types.ObjectId.isValid(userId) ? { userId } : {}),
    metadata: {
      state: 'running',
      trigger,
      fromDate,
      toDate,
      startedAt: new Date(),
      stage: 'fetching',
    },
  });
  return doc._id as mongoose.Types.ObjectId;
}

/**
 * Starts a sync in the background and returns its id straight away.
 *
 * Asking for a range that is already being synced returns that run instead of
 * starting a second one — two admins clicking at once, or one admin clicking
 * twice, should watch the same work.
 */
export async function startSyncRun(params: {
  fromDate: string;
  toDate: string;
  trigger: SyncTrigger;
  userId?: string;
}): Promise<{ runId: string; reused: boolean }> {
  const range = checkSyncRange(params.fromDate, params.toDate);
  if (!range.ok) throw Object.assign(new Error(range.message), { statusCode: 400 });

  const inFlight = await AuditLog.findOne({
    action: SYNC_RUN_ACTION,
    'metadata.state': 'running',
    'metadata.fromDate': params.fromDate,
    'metadata.toDate': params.toDate,
    createdAt: { $gte: new Date(Date.now() - STALLED_AFTER_MS) },
  })
    .sort({ createdAt: -1 })
    .lean();
  if (inFlight) return { runId: String(inFlight._id), reused: true };

  const runId = await createRun(params.fromDate, params.toDate, params.trigger, params.userId);
  execute(runId, params.fromDate, params.toDate).catch((error) => {
    console.error(`[AttendanceSync] Run ${runId} failed: ${error?.message || error}`);
  });
  return { runId: String(runId), reused: false };
}

/** Runs a sync to completion (for the scheduler), recording it like any other run. */
export async function runSyncAndRecord(params: {
  fromDate: string;
  toDate: string;
  trigger: SyncTrigger;
  userId?: string;
}): Promise<EtimeSyncResult> {
  const range = checkSyncRange(params.fromDate, params.toDate);
  if (!range.ok) throw new Error(range.message);
  const runId = await createRun(params.fromDate, params.toDate, params.trigger, params.userId);
  return execute(runId, params.fromDate, params.toDate);
}

export async function getSyncRun(runId: string): Promise<SyncRunView | null> {
  if (!mongoose.Types.ObjectId.isValid(runId)) return null;
  const doc = await AuditLog.findOne({ _id: runId, action: SYNC_RUN_ACTION }).lean();
  return doc ? toView(doc) : null;
}

/**
 * What the admin page shows about syncing: the schedule, whether the
 * scheduler is actually running, and the latest runs.
 *
 * Scheduler health is read from the AUTO_SYNC_ATTENDANCE_* entries the cron
 * job has always written, so it has history from before this endpoint existed.
 */
export async function getSyncOverview(schedule: Array<ScheduleSlot & { label: string }>) {
  const now = new Date();
  const latest = (action: string) =>
    AuditLog.findOne({ action }).sort({ createdAt: -1 }).select('createdAt metadata errorMessage').lean();

  const [lastStart, lastComplete, lastFailure, runs] = await Promise.all([
    latest('AUTO_SYNC_ATTENDANCE_START'),
    latest('AUTO_SYNC_ATTENDANCE_COMPLETE'),
    latest('AUTO_SYNC_ATTENDANCE_FAILED'),
    AuditLog.find({ action: SYNC_RUN_ACTION }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);

  const health = assessAutoSync(now, schedule, {
    lastStart: (lastStart as any)?.createdAt,
    lastComplete: (lastComplete as any)?.createdAt,
    lastFailure: (lastFailure as any)?.createdAt,
  });

  const completeMeta: any = (lastComplete as any)?.metadata || {};

  return {
    now: now.toISOString(),
    auto: {
      schedule: schedule.map((slot) => slot.label),
      status: health.status,
      expectedSince: health.expectedSince?.toISOString() || null,
      nextRunAt: nextScheduledRun(now, schedule)?.toISOString() || null,
      lastStartedAt: (lastStart as any)?.createdAt || null,
      lastCompletedAt: (lastComplete as any)?.createdAt || null,
      lastCompleted: lastComplete
        ? {
            from: isoOf(completeMeta.fromDate),
            to: isoOf(completeMeta.toDate),
            processed: completeMeta.processed ?? null,
            written: completeMeta.written ?? null,
            failed: completeMeta.failed ?? null,
          }
        : null,
      lastFailedAt: (lastFailure as any)?.createdAt || null,
      lastError: (lastFailure as any)?.errorMessage || null,
    },
    runs: runs.map((doc) => toView(doc, now.getTime())),
  };
}
