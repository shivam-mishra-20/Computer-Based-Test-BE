/**
 * Daily Working Hours — the computation behind the report.
 *
 * A reporting layer over three systems that already exist. It stores nothing
 * and decides nothing; it joins what is already recorded and does the arithmetic
 * in one place so the API, the teacher view and the admin view cannot disagree.
 *
 *   Working hours  — `Attendance.clockIn` → `clockOut`, exactly as the biometric
 *                    sync (EtimeService) recorded it.
 *   Class hours    — the teacher's `Schedule` rows for that date, overlapped
 *                    with the punch window.
 *   Non-class      — working hours minus class hours.
 *   EOD status     — the existing `EOD.status` state machine, untouched.
 *
 * ── Two rules that are easy to get wrong ────────────────────────────────────
 * 1. Class hours are a UNION, never a sum. One combined session serving several
 *    batches is stored as several Schedule rows at the same time in the same
 *    room (that is valid per the schedule policy engine), so adding their
 *    durations would report two hours of teaching for one hour of class.
 * 2. Non-class time is not idle time. It is simply presence that no scheduled
 *    class covers — preparation, marking, doubt-solving and meetings all live
 *    there. The report names it neutrally and draws no conclusion from it.
 */

import mongoose from 'mongoose';

// ─── Interval primitives ─────────────────────────────────────────────────────

/** A half-open minute range within a single day: [start, end). */
export type Interval = [number, number];

/** Merge overlapping/adjacent ranges so totals never double-count. */
export function mergeIntervals(input: Interval[]): Interval[] {
  const clean = input
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .map(([s, e]) => [s, e] as Interval)
    .sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const [s, e] of clean) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const left = mergeIntervals(a);
  const right = mergeIntervals(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i][0], right[j][0]);
    const end = Math.min(left[i][1], right[j][1]);
    if (end > start) out.push([start, end]);
    if (left[i][1] < right[j][1]) i += 1;
    else j += 1;
  }
  return out;
}

export function totalMinutes(list: Interval[]): number {
  return mergeIntervals(list).reduce((sum, [s, e]) => sum + (e - s), 0);
}

/** "HH:MM" → minutes since midnight, or null when missing/malformed. */
export function timeToMinutes(value?: string | null): number | null {
  if (!value || typeof value !== 'string' || value === '--:--') return null;
  const trimmed = value.trim();
  if (!/^\d{1,2}:\d{2}$/.test(trimmed)) return null;
  const [h, m] = trimmed.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/**
 * Build an interval from a start/end pair.
 *
 * An end at or before the start becomes a one-hour block rather than a
 * zero-length one — the same choice `resolveEndTimeSlot` makes in
 * scheduleRoutes, for the same reason: a zero-length row overlaps nothing and
 * silently disappears from the figure it should have moved.
 */
export function toInterval(start?: string | null, end?: string | null): Interval | null {
  const s = timeToMinutes(start);
  if (s === null) return null;
  const e = timeToMinutes(end);
  if (e === null || e <= s) return [s, Math.min(s + 60, 24 * 60)];
  return [s, e];
}

// ─── Date helpers ────────────────────────────────────────────────────────────

/**
 * Local-time YYYY-MM-DD.
 *
 * Local, not UTC, because every write path in this codebase that stores a "day"
 * does `setHours(0,0,0,0)` in server-local time (EOD, custom Schedule). Reading
 * them back the same way is the only interpretation that round trips, and it is
 * what `absentCalculationService` and `AttendanceController` already do.
 */
export function toYMD(value: Date | string): string {
  const d = new Date(value);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseDateOnly(value: string, endOfDay: boolean): Date | null {
  const normalized = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const [y, m, d] = normalized.split('-').map(Number);
  const parsed = endOfDay
    ? new Date(y, m - 1, d, 23, 59, 59, 999)
    : new Date(y, m - 1, d, 0, 0, 0, 0);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== y ||
    parsed.getMonth() + 1 !== m ||
    parsed.getDate() !== d
  ) {
    return null;
  }
  return parsed;
}

export function eachDate(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(23, 59, 59, 999);
  while (cursor <= end) {
    out.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

// ─── Teacher identity ────────────────────────────────────────────────────────

/**
 * Resolves the several identifiers this platform uses for one teacher.
 *
 * `Attendance.studentId` is a Mongo ObjectId, `EOD.teacherId` is
 * `firebaseUid || _id`, and `Schedule.teacherId` may be an ObjectId, a Firebase
 * UID, or — for rows created before the picker existed — the teacher's NAME.
 * Joining on any single one of them silently drops classes from the report.
 *
 * A name shared by two teachers is recorded as ambiguous and deliberately not
 * resolved: crediting the wrong person's hours is worse than crediting nobody.
 */
export class TeacherIdentityIndex {
  private byAlias = new Map<string, string>();
  private ambiguous = new Set<string>();

  constructor(users: Array<{ _id: any; name?: string; firebaseUid?: string }>) {
    for (const user of users) {
      const id = String(user._id);
      this.add(id, id);
      if (user.firebaseUid) this.add(String(user.firebaseUid), id);
      if (user.name) this.add(`name:${String(user.name).trim().toLowerCase()}`, id);
    }
  }

  private add(alias: string, userId: string): void {
    if (!alias) return;
    const existing = this.byAlias.get(alias);
    if (existing && existing !== userId) {
      this.ambiguous.add(alias);
      return;
    }
    this.byAlias.set(alias, userId);
  }

  resolve(rawId?: string | null, rawName?: string | null): string | null {
    const id = rawId ? String(rawId).trim() : '';
    if (id && !this.ambiguous.has(id)) {
      const direct = this.byAlias.get(id);
      if (direct) return direct;
      const asName = `name:${id.toLowerCase()}`;
      if (!this.ambiguous.has(asName) && this.byAlias.has(asName)) {
        return this.byAlias.get(asName) as string;
      }
    }
    const name = rawName ? `name:${String(rawName).trim().toLowerCase()}` : '';
    if (name && !this.ambiguous.has(name) && this.byAlias.has(name)) {
      return this.byAlias.get(name) as string;
    }
    return null;
  }
}

// ─── Schedule validity ───────────────────────────────────────────────────────

/**
 * The dates a stored weekly slot actually applied to.
 *
 * `from` falls back to `createdAt` when no `effectiveFrom` is set: a slot cannot
 * have applied before the row existed, and projecting today's timetable back
 * over past months would invent class hours that were never scheduled.
 */
export function scheduleWindow(doc: {
  effectiveFrom?: Date | string | null;
  effectiveTo?: Date | string | null;
  createdAt?: Date | string | null;
}): { from: string | null; to: string | null } {
  return {
    from: doc.effectiveFrom
      ? toYMD(doc.effectiveFrom)
      : doc.createdAt
        ? toYMD(doc.createdAt)
        : null,
    to: doc.effectiveTo ? toYMD(doc.effectiveTo) : null,
  };
}

/** Whether a weekly slot's validity window covers a given local YYYY-MM-DD. */
export function scheduleAppliesOn(
  window: { from: string | null; to: string | null },
  dateKey: string
): boolean {
  if (window.from && dateKey < window.from) return false;
  if (window.to && dateKey > window.to) return false;
  return true;
}

// ─── Report shapes ───────────────────────────────────────────────────────────

/** Mirrors the existing `EOD.status` enum, plus the absence of a document. */
export type EodStatus = 'NOT_SUBMITTED' | 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ReportClass {
  scheduleId: string;
  subject: string;
  classLevel: string;
  batch: string;
  roomNumber: number | null;
  startTime: string;
  endTime: string;
  scheduleType: 'regular' | 'custom';
  /** Scheduled length of this class, before any overlap with the punch window. */
  scheduledMinutes: number;
  /** How much of it falls inside the punch window — what it contributes. */
  countedMinutes: number;
}

export interface DailyHoursRow {
  userId: string;
  teacherName: string;
  empCode: string | null;
  date: string;
  weekday: number;
  isWorkingDay: boolean;
  holidayName: string | null;
  inTime: string | null;
  outTime: string | null;
  punchCount: number;
  /** True when a punch-in exists but no usable punch-out. */
  missingPunchOut: boolean;
  /** True when a punch-out exists but no punch-in. */
  missingPunchIn: boolean;
  /**
   * Attendance was recorded but the working window cannot be measured from it —
   * a punch is missing, or the pair does not form a forward interval. Working
   * hours are reported as zero and the row is shown as incomplete; nothing is
   * ever estimated to fill the gap.
   */
  incomplete: boolean;
  workingMinutes: number;
  classMinutes: number;
  nonClassMinutes: number;
  /** Union of every scheduled class, whether or not the teacher was punched in. */
  scheduledMinutes: number;
  /** Scheduled time that fell outside the punch window, so it is not class hours. */
  scheduledOutsideWindowMinutes: number;
  /** True when classes overlap, so per-class minutes sum to more than the union. */
  hasOverlappingClasses: boolean;
  classes: ReportClass[];
  eodStatus: EodStatus;
  eodSubmittedAt: string | null;
}

export interface BuildRowInput {
  user: { _id: any; name?: string; empCode?: string };
  date: Date;
  isWorkingDay: boolean;
  holidayName: string | null;
  attendance: { clockIn: string | null; clockOut: string | null; punchCount: number } | null;
  schedule: Array<{
    scheduleId: string;
    subject: string;
    classLevel: string;
    batch: string;
    roomNumber: number | null;
    startTime: string;
    endTime: string;
    scheduleType: 'regular' | 'custom';
  }>;
  eodDoc: { status?: string; submittedAt?: Date | string } | null;
}

/** One teacher, one day: the arithmetic behind a single report row. */
export function buildDailyHoursRow(input: BuildRowInput): DailyHoursRow {
  const { user, date, isWorkingDay, holidayName, attendance, schedule, eodDoc } = input;

  const clockIn = attendance ? attendance.clockIn : null;
  const clockOut = attendance ? attendance.clockOut : null;
  const inMinutes = timeToMinutes(clockIn);
  const outMinutes = timeToMinutes(clockOut);

  // Working hours need BOTH punches, forming a forward interval. Anything less
  // is reported as incomplete: the row shows zero and says so, rather than
  // guessing a missing end time or silently reading as a zero-hour day.
  const usablePair = inMinutes !== null && outMinutes !== null && outMinutes > inMinutes;
  const missingPunchOut = inMinutes !== null && !usablePair;
  const missingPunchIn = outMinutes !== null && inMinutes === null;
  const hasAttendance = inMinutes !== null || outMinutes !== null;
  const incomplete = hasAttendance && !usablePair;

  const presence: Interval[] = usablePair ? [[inMinutes as number, outMinutes as number]] : [];
  const workingMinutes = totalMinutes(presence);

  const classIntervals: Interval[] = [];
  let perClassSum = 0;
  const classes: ReportClass[] = schedule.map((item) => {
    const interval = toInterval(item.startTime, item.endTime);
    const scheduledMinutes = interval ? interval[1] - interval[0] : 0;
    const countedMinutes = interval ? totalMinutes(intersectIntervals([interval], presence)) : 0;
    if (interval) classIntervals.push(interval);
    perClassSum += scheduledMinutes;
    return { ...item, scheduledMinutes, countedMinutes };
  });

  const scheduledUnion = mergeIntervals(classIntervals);
  const scheduledMinutes = totalMinutes(scheduledUnion);
  // Class hours are the part of the roster the teacher was actually present for,
  // which keeps non-class hours at or above zero by construction.
  const classMinutes = totalMinutes(intersectIntervals(scheduledUnion, presence));

  const eodStatus: EodStatus = !eodDoc
    ? 'NOT_SUBMITTED'
    : eodDoc.status === 'approved'
      ? 'APPROVED'
      : eodDoc.status === 'rejected'
        ? 'REJECTED'
        : 'PENDING';

  return {
    userId: String(user._id),
    teacherName: user.name || 'Unknown',
    empCode: user.empCode || null,
    date: toYMD(date),
    weekday: date.getDay(),
    isWorkingDay,
    holidayName,
    inTime: clockIn,
    outTime: clockOut,
    punchCount: attendance ? attendance.punchCount || 0 : 0,
    missingPunchOut,
    missingPunchIn,
    incomplete,
    workingMinutes,
    classMinutes,
    nonClassMinutes: Math.max(0, workingMinutes - classMinutes),
    scheduledMinutes,
    scheduledOutsideWindowMinutes: Math.max(0, scheduledMinutes - classMinutes),
    hasOverlappingClasses: perClassSum > scheduledMinutes,
    classes: classes.sort((a, b) => a.startTime.localeCompare(b.startTime)),
    eodStatus,
    eodSubmittedAt:
      eodDoc && eodDoc.submittedAt ? new Date(eodDoc.submittedAt).toISOString() : null,
  };
}

// ─── Loading ─────────────────────────────────────────────────────────────────

export interface DailyHoursOptions {
  from: Date;
  to: Date;
  /** Restrict to one teacher. Always set for a teacher viewing their own report. */
  userId?: string;
}

/**
 * Build the whole report in five queries, regardless of range or headcount.
 *
 * Per-teacher-per-day lookups are what make a month-long report unusable, so
 * everything is fetched once and joined in memory.
 */
export async function buildDailyHoursReport(options: DailyHoursOptions): Promise<{
  teachers: Array<{ userId: string; name: string; empCode: string | null }>;
  rows: DailyHoursRow[];
}> {
  const User = require('../models/User').default;
  const Holiday = require('../models/Holiday').default;
  const Attendance = require('../models/Attendance').default;
  const Schedule = require('../models/Schedule').default;
  const EOD = require('../models/EOD').default;

  const { from, to, userId } = options;
  // ── Query scope ───────────────────────────────────────────────────────────
  // This branch is a single-institute deployment: it has no `src/core/tenancy`
  // layer, and every other query in it is likewise unscoped. The
  // multi-organization branches substitute `tenantScope()` here.
  //
  // Deliberately a constant rather than a guarded `require`: esbuild bundles
  // relative requires statically, so referencing a module this branch does not
  // contain fails `npm run build` outright rather than degrading at runtime.
  // Keeping the name and every spread site identical makes adopting the real
  // scope a one-line change per query when the tenancy layer lands here.
  const scope: Record<string, never> = {};

  const userQuery: any = { role: 'teacher', ...scope };
  if (userId) {
    // Fail CLOSED. Dropping an unusable id would silently widen a teacher's
    // own report to every teacher on the roll — the one direction this scope
    // must never fail in.
    if (!mongoose.Types.ObjectId.isValid(userId)) return { teachers: [], rows: [] };
    userQuery._id = new mongoose.Types.ObjectId(userId);
  }
  const teachers = await User.find(userQuery)
    .select('name empCode firebaseUid')
    .sort({ name: 1 })
    .lean();

  if (teachers.length === 0) return { teachers: [], rows: [] };

  const identity = new TeacherIdentityIndex(teachers);
  const objectIds = teachers.map((t: any) => t._id);

  // Absent days are never "future absences", so attendance stops at today.
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  const effectiveTo = to > todayEnd ? todayEnd : to;

  const [holidays, attRows, regularSchedules, customSchedules, eods] = await Promise.all([
    Holiday.find({ ...scope, date: { $gte: from, $lte: to } }).lean(),
    // Same grouping the attendance admin views use: first punch of the day is
    // the clock-in, last is the clock-out.
    Attendance.aggregate([
      { $match: { studentId: { $in: objectIds }, date: { $gte: from, $lte: effectiveTo } } },
      { $sort: { date: 1, clockIn: 1 } },
      {
        $group: {
          _id: {
            studentId: '$studentId',
            day: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          },
          studentId: { $first: '$studentId' },
          date: { $first: '$date' },
          clockIn: { $first: '$clockIn' },
          lastPunchClockIn: { $last: '$clockIn' },
          actualClockOut: { $last: '$clockOut' },
          punchCount: { $sum: 1 },
        },
      },
    ]),
    // Retired slots are included: a class that ran last term still happened, and
    // `effectiveTo` bounds it to the dates it applied to.
    Schedule.find({
      ...scope,
      scheduleType: 'regular',
      $or: [{ isActive: true }, { effectiveTo: { $exists: true, $ne: null } }],
    })
      .select(
        'subject classLevel batch batches roomNumber startTimeSlot endTimeSlot dayOfWeek teacherId teacherName scheduleType effectiveFrom effectiveTo createdAt'
      )
      .lean(),
    Schedule.find({
      ...scope,
      scheduleType: 'custom',
      date: { $gte: from, $lte: to },
      $or: [{ isActive: true }, { effectiveTo: { $exists: true, $ne: null } }],
    })
      .select(
        'subject classLevel batch batches roomNumber startTimeSlot endTimeSlot date teacherId teacherName scheduleType'
      )
      .lean(),
    EOD.find({ ...scope, date: { $gte: from, $lte: to } })
      .select('teacherId teacherName date status submittedAt')
      .lean(),
  ]);

  // ── Calendar: Mon–Sat working, Sunday off, Holiday overrides either way ────
  const holidayType = new Map<string, string>();
  const holidayName = new Map<string, string>();
  holidays.forEach((h: any) => {
    holidayType.set(toYMD(h.date), h.type);
    if (h.type === 'holiday') holidayName.set(toYMD(h.date), h.name || 'Holiday');
  });

  const dates = eachDate(from, to);
  const workingDates = new Set<string>();
  for (const date of dates) {
    const key = toYMD(date);
    const type = holidayType.get(key);
    const isHoliday = type === 'holiday' ? true : type === 'working' ? false : date.getDay() === 0;
    if (!isHoliday) workingDates.add(key);
    else if (!holidayName.has(key)) holidayName.set(key, 'Weekly off');
  }

  // ── Attendance by user + day ──────────────────────────────────────────────
  const attendanceByKey = new Map<
    string,
    { clockIn: string | null; clockOut: string | null; punchCount: number }
  >();
  attRows.forEach((r: any) => {
    const clockIn = r.clockIn && r.clockIn !== '--:--' ? r.clockIn : null;
    // When a day has several punch rows and no explicit clock-out, the last
    // punch stands in for one — but ONLY when it is actually later than the
    // first. Duplicate punches at the same minute are a device artefact, and
    // accepting one reports a clock-out that never happened and, worse, hides
    // the day from the missing-punch-out flag. Zero-padded HH:MM compares
    // correctly as a string.
    const standInOut =
      r.punchCount > 1 &&
      r.lastPunchClockIn &&
      r.lastPunchClockIn !== '--:--' &&
      clockIn &&
      String(r.lastPunchClockIn) > String(clockIn)
        ? r.lastPunchClockIn
        : null;
    const clockOut =
      r.actualClockOut && r.actualClockOut !== '--:--' ? r.actualClockOut : standInOut;
    attendanceByKey.set(`${String(r.studentId)}|${toYMD(r.date)}`, {
      clockIn,
      clockOut,
      punchCount: r.punchCount || 1,
    });
  });

  // ── Roster expanded onto real dates ───────────────────────────────────────
  const scheduleByKey = new Map<string, BuildRowInput['schedule']>();
  const push = (teacherKey: string, dateKey: string, doc: any) => {
    const key = `${teacherKey}|${dateKey}`;
    const list = scheduleByKey.get(key) || [];
    list.push({
      scheduleId: String(doc._id),
      subject: String(doc.subject || ''),
      classLevel: String(doc.classLevel || ''),
      batch: String(doc.batch || (Array.isArray(doc.batches) ? doc.batches.join(', ') : '')),
      roomNumber: Number.isFinite(doc.roomNumber) ? Number(doc.roomNumber) : null,
      startTime: String(doc.startTimeSlot || ''),
      endTime: String(doc.endTimeSlot || ''),
      scheduleType: doc.scheduleType,
    });
    scheduleByKey.set(key, list);
  };

  for (const doc of regularSchedules as any[]) {
    const resolved = identity.resolve(doc.teacherId, doc.teacherName);
    if (!resolved) continue;
    const window = scheduleWindow(doc);
    for (const date of dates) {
      if (date.getDay() !== doc.dayOfWeek) continue;
      const key = toYMD(date);
      if (!scheduleAppliesOn(window, key)) continue;
      push(resolved, key, doc);
    }
  }
  for (const doc of customSchedules as any[]) {
    const resolved = identity.resolve(doc.teacherId, doc.teacherName);
    if (!resolved) continue;
    push(resolved, toYMD(doc.date), doc);
  }

  // ── EOD by user + day ─────────────────────────────────────────────────────
  const eodByKey = new Map<string, any>();
  for (const doc of eods as any[]) {
    const resolved = identity.resolve(doc.teacherId, doc.teacherName);
    if (!resolved) continue;
    eodByKey.set(`${resolved}|${toYMD(doc.date)}`, doc);
  }

  // ── Rows ──────────────────────────────────────────────────────────────────
  const todayKey = toYMD(new Date());
  const rows: DailyHoursRow[] = [];
  for (const user of teachers as any[]) {
    const key = String(user._id);
    for (const date of dates) {
      const dateKey = toYMD(date);
      // A day that has not happened yet is not a gap in the record.
      if (dateKey > todayKey) continue;
      rows.push(
        buildDailyHoursRow({
          user,
          date,
          isWorkingDay: workingDates.has(dateKey),
          holidayName: holidayName.get(dateKey) || null,
          attendance: attendanceByKey.get(`${key}|${dateKey}`) || null,
          schedule: (scheduleByKey.get(`${key}|${dateKey}`) || [])
            .slice()
            .sort((a, b) => a.startTime.localeCompare(b.startTime)),
          eodDoc: eodByKey.get(`${key}|${dateKey}`) || null,
        })
      );
    }
  }

  // Newest first, then teacher name — the order both views read in.
  rows.sort((a, b) => {
    const byDate = b.date.localeCompare(a.date);
    return byDate !== 0 ? byDate : a.teacherName.localeCompare(b.teacherName);
  });

  return {
    teachers: teachers.map((t: any) => ({
      userId: String(t._id),
      name: t.name,
      empCode: t.empCode || null,
    })),
    rows,
  };
}
