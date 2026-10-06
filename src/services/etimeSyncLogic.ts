/**
 * The decisions behind a biometric (eTimeOffice) attendance sync, with no I/O.
 *
 * Everything here is a pure function so it can be checked without a database,
 * a network or a clock: `scripts/safety/attendance-sync.test.ts` runs it.
 *
 * ── Why the sync is shaped like this ────────────────────────────────────────
 * The device API is asked for one window at a time, never more than a month,
 * because one slow or failed request for a long range used to lose the whole
 * range. Each window can be retried on its own.
 *
 * Records are compared with what is already stored before anything is written.
 * A month-to-date sync re-reads every day of the month four times a day, and
 * almost all of those days have not changed. Writing only the changed ones is
 * what lets a sync finish in seconds, and it is also what makes "this person's
 * attendance was updated" true when we say it.
 */

export interface EtimePunch {
  Name: string;
  Empcode: string;
  PunchDate: string; // "13/01/2026 10:56:00"
  M_Flag: string | null;
}

export interface DayParts {
  year: number;
  month: number; // 1-12
  day: number;
}

/** "13/01/2026" → { year: 2026, month: 1, day: 13 }, or null if it is not a real date. */
export function parseDdMmYyyy(value: string): DayParts | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value || '').trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function partsToUtc(parts: DayParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function utcToParts(ms: number): DayParts {
  const date = new Date(ms);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function formatDdMmYyyy(parts: DayParts): string {
  return `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}/${parts.year}`;
}

export function formatIsoDay(parts: DayParts): string {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Inclusive number of days from `from` to `to` ("01/10/2026"–"01/10/2026" is 1). */
export function daysInRange(from: DayParts, to: DayParts): number {
  return Math.round((partsToUtc(to) - partsToUtc(from)) / DAY_MS) + 1;
}

export const MAX_SYNC_RANGE_DAYS = 366;

/** `from`/`to` are set when `ok`; `message` says what is wrong when not. */
export interface RangeCheck {
  ok: boolean;
  message: string;
  from: DayParts;
  to: DayParts;
  days: number;
}

/** Validates a requested sync range in the API's dd/mm/yyyy format. */
export function checkSyncRange(fromDate: string, toDate: string): RangeCheck {
  const from = parseDdMmYyyy(fromDate);
  const to = parseDdMmYyyy(toDate);
  const refuse = (message: string): RangeCheck => ({ ok: false, message, from, to, days: 0 });
  if (!from || !to) return refuse('Invalid date. Use real dates in dd/mm/yyyy format.');
  const days = daysInRange(from, to);
  if (days < 1) return refuse('The start date is after the end date.');
  if (days > MAX_SYNC_RANGE_DAYS) {
    return refuse(`That range is ${days} days. Fetch at most ${MAX_SYNC_RANGE_DAYS} days at a time.`);
  }
  return { ok: true, message: '', from, to, days };
}

/**
 * Cuts an inclusive range into consecutive windows of at most `maxDays` days.
 * The windows cover every day exactly once, in order.
 */
export function splitIntoWindows(
  from: DayParts,
  to: DayParts,
  maxDays = 31,
): Array<{ from: DayParts; to: DayParts }> {
  const windows: Array<{ from: DayParts; to: DayParts }> = [];
  const end = partsToUtc(to);
  let cursor = partsToUtc(from);
  while (cursor <= end) {
    const windowEnd = Math.min(cursor + (maxDays - 1) * DAY_MS, end);
    windows.push({ from: utcToParts(cursor), to: utcToParts(windowEnd) });
    cursor = windowEnd + DAY_MS;
  }
  return windows;
}

/** The device API answers "no data" as an error; that is an empty window, not a failure. */
export function isNoDataMessage(message: string | null | undefined): boolean {
  return /no\s*(record|data|punch)/i.test(String(message || ''));
}

export interface PunchDay {
  /** Trimmed employee code, as on the device. */
  code: string;
  /** dd/mm/yyyy, as on the device. */
  datePart: string;
  /** HH:mm of the first punch of the day. */
  clockIn: string;
  /** HH:mm of the last punch, only when there is more than one punch. */
  clockOut?: string;
  punchCount: number;
  firstPunchTime: string;
  lastPunchTime: string;
  apiName: string;
  mFlag: string | null;
}

/**
 * One entry per employee per day: first punch is clock-in, last punch is
 * clock-out. Punches with no code or an unreadable timestamp are counted, not
 * guessed at.
 */
export function groupPunchesByDay(punches: EtimePunch[]): { days: PunchDay[]; skipped: number } {
  const groups = new Map<string, Array<{ punch: EtimePunch; time: string; datePart: string }>>();
  let skipped = 0;

  for (const punch of punches || []) {
    const code = String(punch?.Empcode ?? '').trim();
    const [datePart, timePart] = String(punch?.PunchDate ?? '').trim().split(/\s+/);
    if (!code || !parseDdMmYyyy(datePart || '') || !/^\d{1,2}:\d{2}/.test(timePart || '')) {
      skipped += 1;
      continue;
    }
    const time = /^\d:/.test(timePart) ? `0${timePart}` : timePart; // "9:05:00" sorts after "10:00"
    const key = `${code}_${datePart}`;
    const list = groups.get(key) || [];
    list.push({ punch, time, datePart });
    groups.set(key, list);
  }

  const days: PunchDay[] = [];
  groups.forEach((list, key) => {
    list.sort((a, b) => a.time.localeCompare(b.time));
    const first = list[0];
    const last = list.length > 1 ? list[list.length - 1] : null;
    days.push({
      code: key.slice(0, key.lastIndexOf('_')),
      datePart: first.datePart,
      clockIn: first.time.substring(0, 5),
      clockOut: last ? last.time.substring(0, 5) : undefined,
      punchCount: list.length,
      firstPunchTime: first.punch.PunchDate,
      lastPunchTime: (last || first).punch.PunchDate,
      apiName: first.punch.Name,
      mFlag: first.punch.M_Flag ?? null,
    });
  });
  return { days, skipped };
}

/** The id that makes a re-sync update a day instead of duplicating it. */
export function idempotencyKeyFor(day: Pick<PunchDay, 'code' | 'datePart'>): string {
  return `etime-${day.code}-${day.datePart}`;
}

/** Midnight UTC of the punch day — the same instant every earlier sync stored. */
export function storedDateFor(datePart: string): Date {
  const parts = parseDdMmYyyy(datePart);
  if (!parts) throw new Error(`Unreadable punch date: ${datePart}`);
  return new Date(`${formatIsoDay(parts)}T00:00:00.000Z`);
}

export interface StoredDay {
  studentId?: unknown;
  date?: Date | string | null;
  status?: string | null;
  clockIn?: string | null;
  clockOut?: string | null;
  metadata?: { punchCount?: number } | null;
}

export interface NextDay {
  studentId: string;
  date: Date;
  status: string;
  clockIn: string;
  clockOut?: string;
  punchCount: number;
}

/**
 * Would writing `next` change what is stored?
 *
 * A missing clock-out on `next` never counts as a change: the write only sets
 * clockOut when there is one, so an existing value would be kept anyway.
 */
export function dayNeedsWrite(existing: StoredDay | null | undefined, next: NextDay): boolean {
  if (!existing) return true;
  if (String(existing.studentId ?? '') !== next.studentId) return true;
  const storedTime = existing.date ? new Date(existing.date).getTime() : NaN;
  if (storedTime !== next.date.getTime()) return true;
  if ((existing.status || '') !== next.status) return true;
  if ((existing.clockIn || '') !== next.clockIn) return true;
  if (next.clockOut && (existing.clockOut || '') !== next.clockOut) return true;
  if (Number(existing.metadata?.punchCount ?? -1) !== next.punchCount) return true;
  return false;
}

/* ── Automatic sync health ───────────────────────────────────────────────── */

/**
 * The range a scheduled sync asks for: from the 1st of the month that
 * YESTERDAY falls in, to today — both in India time, whatever the server's
 * clock is set to.
 *
 * Starting from yesterday's month means the 3 AM run on the 1st still collects
 * the last evening of the month before, instead of starting fresh and leaving
 * those punches behind.
 */
export function autoSyncRange(now: Date): { fromDate: string; toDate: string } {
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const today = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
  const yesterday = new Date(today - DAY_MS);
  const from = { year: yesterday.getUTCFullYear(), month: yesterday.getUTCMonth() + 1, day: 1 };
  return { fromDate: formatDdMmYyyy(from), toDate: formatDdMmYyyy(utcToParts(today)) };
}

export interface ScheduleSlot {
  hour: number; // IST
  minute: number;
}

const IST_OFFSET_MS = 330 * 60 * 1000; // India has no daylight saving

/** The scheduled run instants (as real UTC instants) around `now`, newest last. */
function slotInstants(now: Date, slots: ScheduleSlot[], daysBack: number, daysForward: number): number[] {
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const base = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
  const instants: number[] = [];
  for (let offset = -daysBack; offset <= daysForward; offset += 1) {
    for (const slot of slots) {
      const istWallClock = base + offset * DAY_MS + (slot.hour * 60 + slot.minute) * 60 * 1000;
      instants.push(istWallClock - IST_OFFSET_MS);
    }
  }
  return instants.sort((a, b) => a - b);
}

export function nextScheduledRun(now: Date, slots: ScheduleSlot[]): Date | null {
  if (slots.length === 0) return null;
  const next = slotInstants(now, slots, 0, 1).find((instant) => instant > now.getTime());
  return next === undefined ? null : new Date(next);
}

/** How long a scheduled run is given to finish before it is expected to have reported. */
export const AUTO_SYNC_GRACE_MS = 30 * 60 * 1000;

export type AutoSyncStatus = 'ok' | 'running' | 'failing' | 'stalled' | 'missed';

export interface AutoSyncEvents {
  lastStart?: Date | null;
  lastComplete?: Date | null;
  lastFailure?: Date | null;
}

/**
 * Is the automatic sync doing its job?
 *
 * Judged against the most recent slot that should have FINISHED by now (a slot
 * less than the grace period ago may legitimately still be running):
 *   ok       a run completed after that slot
 *   failing  a run started after it and failed
 *   running  a run started recently and has not reported yet
 *   stalled  a run started after it and never reported (the process likely died)
 *   missed   nothing ran at all — the scheduler is not running on the server
 */
export function assessAutoSync(now: Date, slots: ScheduleSlot[], events: AutoSyncEvents): {
  status: AutoSyncStatus;
  expectedSince: Date | null;
} {
  const cutoff = now.getTime() - AUTO_SYNC_GRACE_MS;
  const expected = slotInstants(now, slots, 2, 0).filter((instant) => instant <= cutoff).pop();
  if (expected === undefined) return { status: 'missed', expectedSince: null };

  const at = (value?: Date | null) => (value ? new Date(value).getTime() : -Infinity);
  const start = at(events.lastStart);
  const complete = at(events.lastComplete);
  const failure = at(events.lastFailure);
  const expectedSince = new Date(expected);

  // A run that is in progress right now is newer than its own last report.
  if (start > Math.max(complete, failure) && now.getTime() - start < AUTO_SYNC_GRACE_MS) {
    return { status: 'running', expectedSince };
  }
  if (complete >= expected && complete >= failure) return { status: 'ok', expectedSince };
  if (failure >= expected) return { status: 'failing', expectedSince };
  if (start >= expected) return { status: 'stalled', expectedSince };
  return { status: 'missed', expectedSince };
}
