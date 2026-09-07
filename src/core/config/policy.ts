/**
 * Policy resolution, with platform defaults that ARE today's hardcoded values.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 * `PLATFORM_DEFAULTS` is a transcription of what the schemas and services do
 * right now. An organization with no OrgPolicy document therefore behaves
 * byte-identically to production today, and a partially configured one gets its
 * own value for what it set and the legacy value for everything else.
 *
 * That per-FIELD fallback matters more than it looks: an all-or-nothing policy
 * document would force an institute changing one marking scheme to restate
 * every attendance threshold, and the first one they got wrong would look like
 * a platform bug.
 *
 * These defaults are duplicated from the model schemas rather than imported,
 * because a Mongoose `default:` is not readable as a value without instantiating
 * a document. `scripts/safety/org-config.test.ts` asserts they still match, so
 * the duplication cannot drift silently.
 */

import { currentOrgId, withoutTenantScope } from '../tenancy/context';
import type {
  IExamPolicy,
  IGradingPolicy,
  IAttendancePolicy,
  ILeavePolicy,
  IBatchPolicy,
  ILocalePolicy,
} from '../../models/OrgPolicy';

export interface ResolvedPolicy {
  exam: Required<Omit<IExamPolicy, 'markingScheme'>> & {
    markingScheme: { correct: number; incorrect: number; unattempted: number };
  };
  grading: Required<IGradingPolicy>;
  attendance: Required<IAttendancePolicy>;
  leave: Required<ILeavePolicy>;
  batch: Required<IBatchPolicy>;
  locale: Required<ILocalePolicy>;
  /** Which sections came from the database rather than the defaults. */
  configured: string[];
}

/**
 * Today's behaviour, transcribed.
 *
 *   exam.*        models/Exam.ts       markingScheme 1/0/0, submitLockPercent 50,
 *                                      shuffleQuestions true, shuffleOptions false
 *   exam.violationThreshold            cbt-exam web player: 10
 *   attendance.*  models/AttendanceRule.ts
 *   locale.*      models/Exam.ts schedule.timezone 'Asia/Kolkata'
 *   batch.*       services/batchConfigService.ts MERGED_BATCH_NAME
 */
export const PLATFORM_DEFAULTS: Omit<ResolvedPolicy, 'configured'> = {
  exam: {
    markingScheme: { correct: 1, incorrect: 0, unattempted: 0 },
    submitLockPercent: 50,
    defaultDurationMins: 60,
    lateEntryMins: 0,
    shuffleQuestions: true,
    shuffleOptions: false,
    antiCheat: false,
    violationThreshold: 10,
  },
  grading: {
    passPercentage: 33,
    gradeBands: [
      { grade: 'A+', minPercent: 90 },
      { grade: 'A', minPercent: 80 },
      { grade: 'B', minPercent: 70 },
      { grade: 'C', minPercent: 60 },
      { grade: 'D', minPercent: 50 },
      { grade: 'E', minPercent: 33 },
      { grade: 'F', minPercent: 0 },
    ],
  },
  attendance: {
    officialInTime: '10:30',
    officialOutTime: '19:30',
    graceMinutes: 0,
    fullDayMinHours: 9,
    partialFullDayMinHours: 8,
    halfTimeRequiredHours: 4,
    lateDeductionPct: 0,
  },
  leave: {
    annualQuota: 12,
    requiresApproval: true,
  },
  batch: {
    // Abhigyan's existing rule, now expressed as data rather than as three
    // predicate functions naming two specific batch labels.
    mergeRules: [{ merge: ['Advanced', 'Basic'], into: 'Advanced/Basic' }],
  },
  locale: {
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    language: 'English',
  },
};

/** Shallow-merge a stored section over its defaults, dropping undefined. */
function mergeSection<T extends Record<string, unknown>>(
  defaults: T,
  stored: Partial<T> | undefined,
): { value: T; configured: boolean } {
  if (!stored || typeof stored !== 'object') return { value: defaults, configured: false };

  const merged = { ...defaults } as Record<string, unknown>;
  let touched = false;
  for (const [key, value] of Object.entries(stored)) {
    // A stored `undefined` or `null` means "not set", not "set to nothing" —
    // otherwise a partially filled form would blank out defaults it never
    // showed the user.
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    merged[key] = value;
    touched = true;
  }
  return { value: merged as T, configured: touched };
}

export async function getOrgPolicy(orgId?: string | null): Promise<ResolvedPolicy> {
  const org = orgId ?? currentOrgId();

  if (!org) {
    return { ...PLATFORM_DEFAULTS, configured: [] };
  }

  const stored = (await withoutTenantScope('config:read-policy', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OrgPolicy = require('../../models/OrgPolicy').default;
    return OrgPolicy.findOne({ orgId: org }).lean();
  })) as Record<string, unknown> | null;

  if (!stored) return { ...PLATFORM_DEFAULTS, configured: [] };

  const configured: string[] = [];

  const exam = mergeSection(PLATFORM_DEFAULTS.exam, stored.exam as never);
  if (exam.configured) configured.push('exam');

  // markingScheme is nested, so it needs its own merge — otherwise setting only
  // `incorrect: -1` would drop `correct` and every paper would score zero.
  const storedMarking = (stored.exam as { markingScheme?: Record<string, number> } | undefined)
    ?.markingScheme;
  if (storedMarking) {
    exam.value.markingScheme = {
      ...PLATFORM_DEFAULTS.exam.markingScheme,
      ...Object.fromEntries(
        Object.entries(storedMarking).filter(([, v]) => typeof v === 'number'),
      ),
    } as { correct: number; incorrect: number; unattempted: number };
  }

  const grading = mergeSection(PLATFORM_DEFAULTS.grading, stored.grading as never);
  if (grading.configured) configured.push('grading');

  const attendance = mergeSection(PLATFORM_DEFAULTS.attendance, stored.attendance as never);
  if (attendance.configured) configured.push('attendance');

  const leave = mergeSection(PLATFORM_DEFAULTS.leave, stored.leave as never);
  if (leave.configured) configured.push('leave');

  const batch = mergeSection(PLATFORM_DEFAULTS.batch, stored.batch as never);
  if (batch.configured) configured.push('batch');

  const locale = mergeSection(PLATFORM_DEFAULTS.locale, stored.locale as never);
  if (locale.configured) configured.push('locale');

  return {
    exam: exam.value,
    grading: grading.value,
    attendance: attendance.value,
    leave: leave.value,
    batch: batch.value,
    locale: locale.value,
    configured,
  };
}
