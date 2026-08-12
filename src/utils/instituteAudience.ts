/**
 * Institute audience isolation.
 *
 * Public learners are self-registered accounts that use Abhigyan as a learning
 * platform. They carry `role: 'student'` (see the AccountType comment in
 * models/User.ts for why a 4th role was rejected) but they are NOT enrolled at
 * the institute. They must never appear in any query that answers the question
 * "which students belong to the institute / to this class / to this batch".
 *
 * Concretely, they must stay out of:
 *   class rosters · batch rosters · attendance · homework audiences ·
 *   exam audiences · exam notifications · general institute notifications ·
 *   leaderboards · room allocation · teacher student lists · assigned
 *   materials · schedules · syllabus targets · attendance cron · admin
 *   institute counts.
 *
 * ── Why `$ne` and not `$eq: 'INSTITUTE_STUDENT'` ────────────────────────────
 * Every user document that existed before this feature has no `accountType`
 * field at all. In MongoDB `{ field: { $ne: X } }` matches documents where the
 * field is missing, whereas `{ field: X }` does not. Using `$ne` therefore
 * keeps every legacy account inside every institute audience with no backfill
 * migration and no risk of an institute student silently disappearing from a
 * roster. That property is the whole reason this is safe to ship.
 *
 * ── The invariant this file depends on ──────────────────────────────────────
 * A PUBLIC_LEARNER never has root `classLevel` / `batch` / `board` set; those
 * selections live in `learnerProfile`. So even a query this helper was never
 * applied to cannot match a learner *by class or batch*. This filter is the
 * second line of defence, not the only one.
 */

/** Matches institute students only. Legacy rows (no accountType) are included. */
export const INSTITUTE_ACCOUNT_CLAUSE = {
  accountType: { $ne: 'PUBLIC_LEARNER' as const },
};

/**
 * Base filter for "an institute student".
 *
 * Spread it into an existing query, or pass extra clauses:
 *   User.find(instituteStudentFilter({ classLevel: '10' }))
 */
export function instituteStudentFilter<T extends Record<string, any>>(
  extra?: T,
): { role: 'student'; accountType: { $ne: 'PUBLIC_LEARNER' } } & T {
  return {
    role: 'student',
    ...INSTITUTE_ACCOUNT_CLAUSE,
    ...((extra || {}) as T),
  } as any;
}

/**
 * Add the institute-account clause to a query object that already narrows by
 * role (or deliberately spans several roles) — mutates and returns it, so it
 * drops into the common `const query: any = {...}; ...; User.find(query)` shape
 * used across this codebase.
 */
export function applyInstituteAudience<T extends Record<string, any>>(query: T): T {
  (query as any).accountType = { $ne: 'PUBLIC_LEARNER' };
  return query;
}

/** True when the given user document is a self-registered public learner. */
export function isPublicLearner(user?: { accountType?: string } | null): boolean {
  return user?.accountType === 'PUBLIC_LEARNER';
}
