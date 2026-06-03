import mongoose from 'mongoose';
import AttendanceRule, { IAttendanceRule, UserType } from '../models/AttendanceRule';

// ─── Public types ─────────────────────────────────────────────────────────────

export type DayType = 'full_day' | 'partial_full_day' | 'half_day' | 'absent';

/** Canonical attendance status strings returned in API and stored in reports. */
export type AttendanceStatus =
  | 'FULL_DAY'
  | 'PARTIAL_FULL_DAY'
  | 'HALF_DAY'
  | 'ABSENT';

/**
 * Semantic deduction reason code.
 * Used by the payroll module to group and explain deductions without encoding
 * monetary amounts — the system is intentionally salary-independent.
 */
export type DeductionReason =
  | 'FULL_DAY'                      // No deduction
  | 'FULL_DAY_LATE_ARRIVAL'         // Full hours worked but late (late-only deduction applied)
  | 'WORKED_BETWEEN_8_AND_9_HOURS'  // Full-time partial full day
  | 'WORKED_LESS_THAN_8_HOURS'      // Full-time half day
  | 'LATE_ARRIVAL'                  // Half-time: late by 1+ minute
  | 'INSUFFICIENT_HOURS'            // Half-time: worked fewer than required hours
  | 'NO_CHECK_IN';                  // Absent — no punch record

export interface EffectiveRule {
  userType: UserType;
  officialInTime: string;
  officialOutTime: string;
  graceMinutes: number;
  fullDayMinHours: number;
  partialFullDayMinHours: number;
  halfTimeRequiredHours: number;
  lateDeductionPct: number;
  partialFullDayDeductionPct: number;
  halfDayDeductionPct: number;
  halfTimeLateDeductionPct: number;
  source: 'user' | 'role' | 'default';
  ruleId?: string;
}

export interface DayClassification {
  // ── Existing fields (backward-compatible) ──────────────────────────────────
  workingMinutes: number;
  dayType: DayType;
  isLate: boolean;
  lateMinutes: number;
  /** Admin-configured deduction percentage (0–100). Kept for display. */
  deductionPct: number;
  deductionReasons: string[];

  // ── Deduction Unit fields (salary-independent) ────────────────────────────
  /**
   * Canonical attendance status for this day.
   * Used in reports and downstream payroll processing.
   */
  attendanceStatus: AttendanceStatus;

  /**
   * Day-fraction deduction unit (0 = no deduction, 1 = full day deducted).
   * Derived from deductionPct / 100 so admin-configured percentages
   * are the single source of truth.
   *
   * Typical values:
   *   0    – Full Day (no deduction)
   *   0.25 – Partial Full Day (¼ day)
   *   0.50 – Half Day or Half-Time Late (½ day)
   *   1.00 – Absent (full day)
   */
  deductionUnit: number;

  /**
   * Semantic reason code explaining why the deduction unit was applied.
   * Suitable for payroll breakdowns and audit trails.
   */
  deductionReason: DeductionReason;

  /** Employee type resolved from the effective rule. */
  employeeType: 'full_time' | 'half_time';

  /**
   * Required working hours for this employee (from rule).
   * full_time → fullDayMinHours (default 9)
   * half_time → halfTimeRequiredHours (default 4)
   */
  requiredWorkingHours: number;
}

// ─── System defaults (no rule configured) ────────────────────────────────────

export const SYSTEM_DEFAULT_RULE: EffectiveRule = {
  userType: 'full_time',
  officialInTime: '10:30',
  officialOutTime: '19:30',
  graceMinutes: 0,
  fullDayMinHours: 9,
  partialFullDayMinHours: 8,
  halfTimeRequiredHours: 4,
  lateDeductionPct: 0,
  partialFullDayDeductionPct: 25,
  halfDayDeductionPct: 50,
  halfTimeLateDeductionPct: 50,
  source: 'default',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert "HH:MM" to minutes since midnight. Returns 0 on invalid input. */
export function parseTimeToMinutes(time: string | null | undefined): number {
  if (!time || typeof time !== 'string') return 0;
  const [hStr, mStr] = time.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return 0;
  return h * 60 + m;
}

/** Format minutes as "Xh Ym" display string. */
export function formatMinutes(totalMinutes: number): string {
  if (totalMinutes <= 0) return '0h 0m';
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Validate "HH:MM" format. */
export function isValidTimeString(t: string): boolean {
  return /^\d{2}:\d{2}$/.test(t) && parseTimeToMinutes(t) >= 0;
}

function dbRuleToEffective(rule: IAttendanceRule, source: 'user' | 'role'): EffectiveRule {
  return {
    userType: rule.userType,
    officialInTime: rule.officialInTime,
    officialOutTime: rule.officialOutTime,
    graceMinutes: rule.graceMinutes,
    fullDayMinHours: rule.fullDayMinHours,
    partialFullDayMinHours: rule.partialFullDayMinHours,
    halfTimeRequiredHours: rule.halfTimeRequiredHours,
    lateDeductionPct: rule.lateDeductionPct,
    partialFullDayDeductionPct: rule.partialFullDayDeductionPct,
    halfDayDeductionPct: rule.halfDayDeductionPct,
    halfTimeLateDeductionPct: rule.halfTimeLateDeductionPct,
    source,
    ruleId: String(rule._id),
  };
}

/**
 * Derive the deduction unit from a percentage.
 * 25 → 0.25, 50 → 0.50, 100 → 1.00, 0 → 0
 */
function pctToUnit(pct: number): number {
  // Round to two decimal places to avoid floating-point noise.
  return Math.round(pct) / 100;
}

/**
 * Assemble the final DayClassification from the computed base fields plus the rule.
 * All new salary-independent fields are derived here in one place.
 */
function buildClassification(base: {
  workingMinutes: number;
  dayType: DayType;
  isLate: boolean;
  lateMinutes: number;
  deductionPct: number;
  deductionReasons: string[];
  rule: EffectiveRule;
}): DayClassification {
  const { workingMinutes, dayType, isLate, lateMinutes, deductionPct, deductionReasons, rule } = base;

  const attendanceStatus: AttendanceStatus =
    dayType === 'full_day' ? 'FULL_DAY' :
    dayType === 'partial_full_day' ? 'PARTIAL_FULL_DAY' :
    dayType === 'half_day' ? 'HALF_DAY' : 'ABSENT';

  const deductionUnit = pctToUnit(deductionPct);

  let deductionReason: DeductionReason;
  if (dayType === 'absent') {
    deductionReason = 'NO_CHECK_IN';
  } else if (rule.userType === 'half_time') {
    if (dayType === 'full_day') {
      deductionReason = isLate ? 'LATE_ARRIVAL' : 'FULL_DAY';
    } else {
      // half_day for half-time: prefer LATE_ARRIVAL when late because that's
      // the trigger; INSUFFICIENT_HOURS when short on time but on-time.
      deductionReason = isLate ? 'LATE_ARRIVAL' : 'INSUFFICIENT_HOURS';
    }
  } else {
    // full_time
    if (dayType === 'full_day') {
      deductionReason = (isLate && deductionPct > 0) ? 'FULL_DAY_LATE_ARRIVAL' : 'FULL_DAY';
    } else if (dayType === 'partial_full_day') {
      deductionReason = 'WORKED_BETWEEN_8_AND_9_HOURS';
    } else {
      deductionReason = 'WORKED_LESS_THAN_8_HOURS';
    }
  }

  const requiredWorkingHours =
    rule.userType === 'half_time' ? rule.halfTimeRequiredHours : rule.fullDayMinHours;

  return {
    workingMinutes,
    dayType,
    isLate,
    lateMinutes,
    deductionPct,
    deductionReasons,
    attendanceStatus,
    deductionUnit,
    deductionReason,
    employeeType: rule.userType,
    requiredWorkingHours,
  };
}

// ─── Rule lookup ──────────────────────────────────────────────────────────────

/**
 * Return the effective rule for a single user.
 * Priority: user-specific rule > role-level rule > system default.
 */
export async function getEffectiveRule(
  userId: string,
  role: string
): Promise<EffectiveRule> {
  if (!mongoose.Types.ObjectId.isValid(userId)) return { ...SYSTEM_DEFAULT_RULE };

  const [userRule, roleRule] = await Promise.all([
    AttendanceRule.findOne({ userId: new mongoose.Types.ObjectId(userId) }).lean(),
    AttendanceRule.findOne({ role, userId: { $exists: false } }).lean(),
  ]);

  if (userRule) return dbRuleToEffective(userRule as IAttendanceRule, 'user');
  if (roleRule) return dbRuleToEffective(roleRule as IAttendanceRule, 'role');
  return { ...SYSTEM_DEFAULT_RULE };
}

/**
 * Efficiently load rules for many users in two queries.
 * Returns userId → EffectiveRule map.
 */
export async function getEffectiveRulesBulk(
  userIds: string[],
  userRoles: Map<string, string>
): Promise<Map<string, EffectiveRule>> {
  if (userIds.length === 0) return new Map();

  const validIds = userIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
  const objectIds = validIds.map((id) => new mongoose.Types.ObjectId(id));
  const roles = Array.from(new Set(Array.from(userRoles.values())));

  const [userRules, roleRules] = await Promise.all([
    AttendanceRule.find({ userId: { $in: objectIds } }).lean(),
    AttendanceRule.find({ role: { $in: roles }, userId: { $exists: false } }).lean(),
  ]);

  const userRuleMap = new Map<string, EffectiveRule>();
  (userRules as IAttendanceRule[]).forEach((r) =>
    userRuleMap.set(String(r.userId), dbRuleToEffective(r, 'user'))
  );

  const roleRuleMap = new Map<string, EffectiveRule>();
  (roleRules as IAttendanceRule[]).forEach((r) =>
    roleRuleMap.set(r.role!, dbRuleToEffective(r, 'role'))
  );

  const result = new Map<string, EffectiveRule>();
  userIds.forEach((uid) => {
    if (userRuleMap.has(uid)) {
      result.set(uid, userRuleMap.get(uid)!);
    } else {
      const role = userRoles.get(uid) || 'teacher';
      result.set(uid, roleRuleMap.get(role) ?? { ...SYSTEM_DEFAULT_RULE });
    }
  });

  return result;
}

// ─── Core classification ──────────────────────────────────────────────────────

/**
 * Classify a single day's attendance given clock times and the employee's rule.
 *
 * Pure / synchronous — call getEffectiveRule(s) once before looping over days.
 *
 * Returns both the legacy `deductionPct` field (for backward compatibility)
 * and the new salary-independent `deductionUnit` / `attendanceStatus` /
 * `deductionReason` fields.
 */
export function classifyDay(
  clockIn: string | null | undefined,
  clockOut: string | null | undefined,
  rule: EffectiveRule
): DayClassification {
  const hasClockIn = Boolean(clockIn) && clockIn !== '--:--';

  if (!hasClockIn) {
    return buildClassification({
      workingMinutes: 0,
      dayType: 'absent',
      isLate: false,
      lateMinutes: 0,
      deductionPct: 100,
      deductionReasons: ['No check-in recorded'],
      rule,
    });
  }

  const clockInMinutes = parseTimeToMinutes(clockIn!);
  const officialInMinutes = parseTimeToMinutes(rule.officialInTime);
  const lateThreshold = officialInMinutes + rule.graceMinutes;

  const isLate = clockInMinutes > lateThreshold;
  const lateMinutes = isLate ? clockInMinutes - officialInMinutes : 0;
  const reasons: string[] = [];
  if (isLate) {
    reasons.push(`Late by ${lateMinutes} min (in at ${clockIn}, official ${rule.officialInTime})`);
  }

  const hasClockOut = Boolean(clockOut) && clockOut !== '--:--';
  const workingMinutes = hasClockOut
    ? Math.max(0, parseTimeToMinutes(clockOut!) - clockInMinutes)
    : 0;

  // ── Half-time logic ────────────────────────────────────────────────────────
  if (rule.userType === 'half_time') {
    const reqMin = rule.halfTimeRequiredHours * 60;

    if (workingMinutes >= reqMin) {
      // Completed hours; deduction only if late.
      const deductionPct = isLate ? rule.halfTimeLateDeductionPct : 0;
      if (isLate && deductionPct > 0) {
        reasons.push(`Half-time late deduction: ${deductionPct}%`);
      }
      return buildClassification({
        workingMinutes, dayType: 'full_day', isLate, lateMinutes,
        deductionPct, deductionReasons: reasons, rule,
      });
    }

    // Insufficient hours (or no clock-out)
    const hoursWorked = formatMinutes(workingMinutes);
    reasons.push(
      workingMinutes > 0
        ? `Short hours: ${hoursWorked} of ${rule.halfTimeRequiredHours}h required`
        : 'No check-out recorded'
    );
    const deductionPct = Math.min(
      100,
      Math.max(rule.halfDayDeductionPct, isLate ? rule.halfTimeLateDeductionPct : 0)
    );
    return buildClassification({
      workingMinutes, dayType: 'half_day', isLate, lateMinutes,
      deductionPct, deductionReasons: reasons, rule,
    });
  }

  // ── Full-time logic ────────────────────────────────────────────────────────
  const fullDayMin = rule.fullDayMinHours * 60;
  const partialMin = rule.partialFullDayMinHours * 60;

  if (workingMinutes >= fullDayMin) {
    const deductionPct = isLate ? rule.lateDeductionPct : 0;
    if (isLate && rule.lateDeductionPct > 0) {
      reasons.push(`Late deduction: ${rule.lateDeductionPct}%`);
    }
    return buildClassification({
      workingMinutes, dayType: 'full_day', isLate, lateMinutes,
      deductionPct, deductionReasons: reasons, rule,
    });
  }

  if (workingMinutes >= partialMin) {
    reasons.push(
      `Partial day: ${formatMinutes(workingMinutes)} (need ${rule.fullDayMinHours}h for full day)`
    );
    const deductionPct = Math.min(
      100,
      rule.partialFullDayDeductionPct + (isLate ? rule.lateDeductionPct : 0)
    );
    if (isLate && rule.lateDeductionPct > 0) reasons.push(`+ late deduction: ${rule.lateDeductionPct}%`);
    return buildClassification({
      workingMinutes, dayType: 'partial_full_day', isLate, lateMinutes,
      deductionPct, deductionReasons: reasons, rule,
    });
  }

  // Half-day
  reasons.push(
    workingMinutes > 0
      ? `Half day: ${formatMinutes(workingMinutes)} (need ${rule.partialFullDayMinHours}h minimum)`
      : 'No check-out recorded'
  );
  const deductionPct = Math.min(
    100,
    rule.halfDayDeductionPct + (isLate ? rule.lateDeductionPct : 0)
  );
  if (isLate && rule.lateDeductionPct > 0) reasons.push(`+ late deduction: ${rule.lateDeductionPct}%`);
  return buildClassification({
    workingMinutes, dayType: 'half_day', isLate, lateMinutes,
    deductionPct, deductionReasons: reasons, rule,
  });
}
