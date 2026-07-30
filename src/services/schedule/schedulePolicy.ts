/**
 * Institute scheduling policy — the single source of truth for WHICH schedule
 * arrangements this institute considers legal.
 *
 * Everything here is a business decision, not a technical one. The validation
 * engine (scheduleValidator.ts) contains no institute-specific assumptions of
 * its own; it only asks this policy. To support a different institute or a
 * changed workflow, flip a value here (or set the env var) — never edit the
 * rule engine or a route.
 */

function bool(v: string | undefined, fallback: boolean): boolean {
  const s = (v ?? '').trim().toLowerCase();
  if (!s) return fallback;
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}
function int(v: string | undefined, fallback: number): number {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Severity a rule reports at. 'off' disables the rule entirely. */
export type RuleSeverity = 'error' | 'warning' | 'off';

export interface SchedulePolicy {
  /**
   * THE institute-specific rule this engine was built for. When a single class
   * splits into batches, those batches legitimately sit together in ONE room at
   * the SAME time (e.g. 11th JEE B1 and 11th JEE B2, both "Archit sir, Room 4").
   * Generic school-scheduling logic calls that a room double-booking; here it is
   * a combined session and entirely valid.
   */
  allowCombinedBatchSessions: boolean;

  /**
   * Whether a combined session is also allowed to share one teacher. True here:
   * a combined session IS one teacher taking both batches together, so flagging
   * the shared teacher would reject the very arrangement above.
   */
  combinedSessionSharesTeacher: boolean;

  /**
   * Whether the batches must be in the SAME room to count as combined. Keep
   * true: it is what makes the rule safe. One teacher listed against two
   * batches in two DIFFERENT rooms is not a combined session — that teacher
   * would have to be in two places at once, and stays a real conflict.
   */
  combinedSessionRequiresSameRoom: boolean;

  /** Two different classes in one room at overlapping times. */
  roomDoubleBooking: RuleSeverity;

  /** One teacher in two places at overlapping times. */
  teacherDoubleBooking: RuleSeverity;

  /** Booking a teacher who has an approved (non half-day) leave that day. */
  teacherOnApprovedLeave: RuleSeverity;

  /** Physical rooms available to schedule into. */
  roomNumberRange: { min: number; max: number };

  /** A row with neither teacherId nor teacherName — saved as TBA. */
  missingTeacher: RuleSeverity;

  /** A row whose batch text matched no configured batch — kept as free text. */
  missingBatch: RuleSeverity;

  /** A row the AI import flagged as uncertain. */
  aiFlaggedRow: RuleSeverity;
}

export const schedulePolicy: SchedulePolicy = {
  allowCombinedBatchSessions: bool(process.env.SCHEDULE_ALLOW_COMBINED_BATCHES, true),
  combinedSessionSharesTeacher: bool(process.env.SCHEDULE_COMBINED_SHARES_TEACHER, true),
  combinedSessionRequiresSameRoom: bool(process.env.SCHEDULE_COMBINED_REQUIRES_SAME_ROOM, true),

  roomDoubleBooking: bool(process.env.SCHEDULE_BLOCK_ROOM_DOUBLE_BOOKING, true) ? 'error' : 'off',
  teacherDoubleBooking: bool(process.env.SCHEDULE_BLOCK_TEACHER_DOUBLE_BOOKING, true) ? 'error' : 'off',
  teacherOnApprovedLeave: bool(process.env.SCHEDULE_BLOCK_TEACHER_ON_LEAVE, true) ? 'error' : 'off',

  roomNumberRange: {
    min: int(process.env.SCHEDULE_ROOM_MIN, 1),
    max: int(process.env.SCHEDULE_ROOM_MAX, 11),
  },

  missingTeacher: 'warning',
  missingBatch: 'warning',
  aiFlaggedRow: 'warning',
};

/** Read the active policy. A function (not a bare export) so callers can never
 *  capture a stale copy, and so a future DB-backed policy is a drop-in here. */
export function getSchedulePolicy(): SchedulePolicy {
  return schedulePolicy;
}
