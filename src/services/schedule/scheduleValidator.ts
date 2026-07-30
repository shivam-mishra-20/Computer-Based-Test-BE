/**
 * Centralized schedule validation engine.
 *
 * This module owns HOW schedules are checked; schedulePolicy.ts owns WHICH
 * arrangements this institute allows. Nothing here hardcodes an institute
 * assumption — every judgement routes through the policy, so a different
 * workflow is a policy change, not a code change.
 *
 * All three entry points that can create or change a schedule evaluate the
 * SAME rules through this engine:
 *   - POST /api/schedule           (manual single entry)
 *   - PUT  /api/schedule/:id       (manual edit)
 *   - POST /api/schedule/bulk[/validate]  (AI import review + commit)
 * They previously carried three separate copies of the logic, which is how they
 * came to disagree about what a conflict even is.
 *
 * The engine is pure and synchronous: callers fetch the candidate sessions they
 * care about (from the request, from Mongo, or both) and hand them in. That
 * keeps the rules unit-testable and keeps query shape out of the rule layer.
 */
import { normalizeClassValue } from '../../config/studentBatchConfig';
import { getSchedulePolicy, RuleSeverity, SchedulePolicy } from './schedulePolicy';

export interface ScheduleSession {
  /** Draft rows carry tempId; persisted rows carry _id. Either may be absent. */
  tempId?: string;
  id?: string;
  classLevel: string;
  /** Primary batch label. Kept for messages and single-batch rows. */
  batch?: string;
  /** Full batch list when a row covers several batches at once. */
  batches?: string[];
  startTimeSlot: string;
  endTimeSlot: string;
  roomNumber: number | null;
  teacherId?: string;
  teacherName?: string;
  /** Set by the AI import when a field was uncertain. */
  needsReview?: boolean;
}

export interface ValidationIssue {
  tempId?: string;
  field?: string;
  severity: 'error' | 'warning';
  message: string;
  /** Stable identifier of the rule that produced this, for logs and UI. */
  rule: string;
}

function minutes(time: string): number {
  const [h, m] = String(time || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}

/** Proper overlap, not exact-start match — back-to-back slots (3:30-4:30, 4:30-5:30) never overlap. */
export function timeRangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const as = minutes(aStart), ae = minutes(aEnd), bs = minutes(bStart), be = minutes(bEnd);
  if ([as, ae, bs, be].some((n) => Number.isNaN(n))) return false;
  return as < be && bs < ae;
}

export function isValidTimeString(s: unknown): s is string {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** Room number, or null when it is outside the institute's configured range. */
export function clampRoomNumber(raw: unknown, policy: SchedulePolicy = getSchedulePolicy()): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  const { min, max } = policy.roomNumberRange;
  return rounded >= min && rounded <= max ? rounded : null;
}

function normalizeBatchLabel(b: unknown): string {
  return String(b || '').trim().toLowerCase();
}

/** Every batch a session covers, normalized. Empty when the row has no batch. */
function batchSet(s: ScheduleSession): Set<string> {
  const all = [
    ...(Array.isArray(s.batches) ? s.batches : []),
    ...(s.batch ? [s.batch] : []),
  ]
    .map(normalizeBatchLabel)
    .filter(Boolean);
  return new Set(all);
}

function sameClass(a: ScheduleSession, b: ScheduleSession): boolean {
  const an = normalizeClassValue(a.classLevel) || String(a.classLevel || '').trim();
  const bn = normalizeClassValue(b.classLevel) || String(b.classLevel || '').trim();
  return !!an && an === bn;
}

/** No batch in common — "different batches" in the policy's sense. */
function batchesAreDisjoint(a: ScheduleSession, b: ScheduleSession): boolean {
  const as = batchSet(a);
  const bs = batchSet(b);
  if (!as.size || !bs.size) return false; // an unbatched row is not "a different batch"
  for (const x of as) if (bs.has(x)) return false;
  return true;
}

export function sessionLabel(s: ScheduleSession): string {
  return `Class ${s.classLevel}${s.batch ? ' ' + s.batch : ''}`;
}

/**
 * The same real-world session seen twice: identical class, identical batch(es)
 * and an identical time range. Happens whenever an already-saved day is
 * re-imported or re-reviewed, and when a row is compared against its own
 * persisted copy. Never a conflict.
 */
function isSameSession(a: ScheduleSession, b: ScheduleSession): boolean {
  if (!sameClass(a, b)) return false;
  const as = batchSet(a);
  const bs = batchSet(b);
  if (as.size !== bs.size) return false;
  for (const x of as) if (!bs.has(x)) return false;
  return a.startTimeSlot === b.startTimeSlot && a.endTimeSlot === b.endTimeSlot;
}

/**
 * INSTITUTE RULE (policy.allowCombinedBatchSessions): one class whose batches
 * sit together in one room at one time is a combined session, not a clash.
 *
 *   11th JEE B1  3:30-4:30  Archit sir  Room 4
 *   11th JEE B2  3:30-4:30  Archit sir  Room 4   -> valid, not a conflict
 *
 * Requires the SAME room by default, which is what keeps the exemption honest:
 * the same teacher against two batches in two DIFFERENT rooms is not combined
 * teaching, it is one person in two places, and stays a conflict.
 */
export function isCombinedBatchSession(
  a: ScheduleSession,
  b: ScheduleSession,
  policy: SchedulePolicy = getSchedulePolicy()
): boolean {
  if (!policy.allowCombinedBatchSessions) return false;
  if (!sameClass(a, b)) return false;
  if (!batchesAreDisjoint(a, b)) return false;
  if (policy.combinedSessionRequiresSameRoom) {
    if (a.roomNumber === null || b.roomNumber === null) return false;
    if (a.roomNumber !== b.roomNumber) return false;
  }
  return true;
}

function push(
  issues: ValidationIssue[],
  severity: RuleSeverity,
  issue: Omit<ValidationIssue, 'severity'>
): void {
  if (severity === 'off') return;
  issues.push({ ...issue, severity });
}

/**
 * Resource conflicts between one session and the sessions it might compete
 * with. `others` must already exclude the session itself.
 */
export function findSessionConflicts(
  entry: ScheduleSession,
  others: ScheduleSession[],
  policy: SchedulePolicy = getSchedulePolicy()
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const other of others) {
    if (!timeRangesOverlap(entry.startTimeSlot, entry.endTimeSlot, other.startTimeSlot, other.endTimeSlot)) {
      continue;
    }
    if (isSameSession(entry, other)) continue;

    const combined = isCombinedBatchSession(entry, other, policy);

    // A combined session shares its room by definition — that is the whole
    // arrangement — so the room rule does not apply to this pair.
    if (!combined && entry.roomNumber !== null && entry.roomNumber === other.roomNumber) {
      push(issues, policy.roomDoubleBooking, {
        tempId: entry.tempId,
        field: 'roomNumber',
        rule: 'roomDoubleBooking',
        message: `Room ${entry.roomNumber} is already used by ${sessionLabel(other)} at an overlapping time (${other.startTimeSlot}-${other.endTimeSlot}).`,
      });
    }

    const teacherShared = !!entry.teacherId && !!other.teacherId && entry.teacherId === other.teacherId;
    const teacherExempt = combined && policy.combinedSessionSharesTeacher;
    if (teacherShared && !teacherExempt) {
      push(issues, policy.teacherDoubleBooking, {
        tempId: entry.tempId,
        field: 'teacherId',
        rule: 'teacherDoubleBooking',
        message: `${entry.teacherName || 'This teacher'} is already assigned to ${sessionLabel(other)} at an overlapping time (${other.startTimeSlot}-${other.endTimeSlot}).`,
      });
    }
  }

  return issues;
}

/** Per-row field checks (shape, not conflicts). Severities come from policy. */
export function validateSessionFields(
  entry: ScheduleSession,
  policy: SchedulePolicy = getSchedulePolicy()
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const tempId = entry.tempId;

  if (!entry.classLevel) {
    push(issues, 'error', { tempId, field: 'classLevel', rule: 'classRequired', message: 'Class is required.' });
  }

  const validStart = isValidTimeString(entry.startTimeSlot);
  const validEnd = isValidTimeString(entry.endTimeSlot);
  if (!validStart || !validEnd) {
    push(issues, 'error', {
      tempId, field: 'startTimeSlot', rule: 'timeRequired',
      message: 'A valid start and end time are required.',
    });
  } else if (minutes(entry.endTimeSlot) <= minutes(entry.startTimeSlot)) {
    push(issues, 'error', {
      tempId, field: 'endTimeSlot', rule: 'timeOrder',
      message: 'End time must be after start time.',
    });
  }

  if (entry.roomNumber === null) {
    push(issues, 'error', {
      tempId, field: 'roomNumber', rule: 'roomRange',
      message: `Room number must be between ${policy.roomNumberRange.min} and ${policy.roomNumberRange.max}.`,
    });
  }

  if (!entry.teacherId && !entry.teacherName) {
    push(issues, policy.missingTeacher, {
      tempId, field: 'teacherName', rule: 'missingTeacher',
      message: 'No teacher assigned — will be saved as TBA.',
    });
  }
  if (!entry.batch && !(entry.batches && entry.batches.length)) {
    push(issues, policy.missingBatch, {
      tempId, field: 'batch', rule: 'missingBatch',
      message: 'No batch matched — kept as free text.',
    });
  }
  if (entry.needsReview) {
    push(issues, policy.aiFlaggedRow, {
      tempId, rule: 'aiFlaggedRow',
      message: 'This row still has AI-flagged fields worth double-checking.',
    });
  }

  return issues;
}

/**
 * Validate a whole draft set: each row's fields, each row against its
 * siblings, and each row against what is already saved.
 */
export function validateSessionSet(
  entries: ScheduleSession[],
  existing: ScheduleSession[] = [],
  policy: SchedulePolicy = getSchedulePolicy()
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  entries.forEach((entry, idx) => {
    issues.push(...validateSessionFields(entry, policy));

    if (!isValidTimeString(entry.startTimeSlot) || !isValidTimeString(entry.endTimeSlot)) return;

    const siblings = entries.filter((_, i) => i !== idx);
    issues.push(...findSessionConflicts(entry, siblings, policy));
    if (existing.length) {
      issues.push(...findSessionConflicts(entry, existing, policy));
    }
  });

  return issues;
}

export function hasBlockingIssue(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
