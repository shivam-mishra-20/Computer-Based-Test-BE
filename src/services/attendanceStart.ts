/**
 * From which day a STUDENT can be absent.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * Absence is inferred: a working day (Mon–Sat, minus holidays, up to today)
 * with no qualifying punch. That inference is only meaningful while the person
 * is enrolled, and the data model has no admission or enrolment date. So a
 * student's absences count from the EARLIEST evidence that they were at the
 * institute: the day their account was created or the day of their first-ever
 * attendance record, whichever is earlier (decided 2026-10-16).
 *
 *   - A student who joined on the 20th is no longer "absent" on the 1st–19th.
 *   - A legacy account created after its biometric history began still counts
 *     from its first punch, so no real absence disappears.
 *   - Working days, holidays, Sundays and the present rule are unchanged; only
 *     days before that start are dropped from a student's working days.
 *
 * ── Students only ───────────────────────────────────────────────────────────
 * Staff are deliberately unaffected: their absences feed the deduction summary
 * used for pay, and that rule is not changed here (decided 2026-10-16).
 *
 * ── Effect on history ───────────────────────────────────────────────────────
 * Nothing is stored: every report is computed when it is asked for, so a
 * regenerated report for an earlier month shows fewer absences for students
 * who joined during it. Reports already exported or printed are not altered.
 */

import mongoose from 'mongoose';

/** yyyy-mm-dd in server-local time — the same conversion every report uses. */
export function localYmd(date: Date): string {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The earlier of two possibly-missing dates, as yyyy-mm-dd; null when neither is known. */
export function activeFromYmd(
  createdAt: Date | string | null | undefined,
  firstRecord: Date | string | null | undefined,
): string | null {
  const times = [createdAt, firstRecord]
    .map((v) =>
      v === null || v === undefined || v === '' ? NaN : new Date(v).getTime(),
    )
    .filter((t) => Number.isFinite(t));
  if (!times.length) return null;
  return localYmd(new Date(Math.min(...times)));
}

/** A student's working days from their start; everyone else's unchanged. */
export function workingDatesFor(
  workingDates: readonly string[],
  role: string | null | undefined,
  activeFrom: string | null,
): string[] {
  if (role !== 'student' || !activeFrom) return [...workingDates];
  return workingDates.filter((day) => day >= activeFrom);
}

/**
 * Each student's start, for many at once: two queries whatever the number of
 * people. Non-students get null (their working days are never bounded).
 */
export async function studentStarts(
  users: ReadonlyArray<{
    _id: unknown;
    role?: string | null;
    createdAt?: Date | string | null;
  }>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const students = users.filter((u) => u.role === 'student');
  for (const u of users) out.set(String(u._id), null);
  if (!students.length) return out;

  const Attendance = (await import('../models/Attendance')).default;
  const objectIds = students
    .map((u) => String(u._id))
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  const firsts: Array<{ _id: unknown; first: Date }> =
    await Attendance.aggregate([
      { $match: { studentId: { $in: objectIds } } },
      {
        $group: { _id: { $toString: '$studentId' }, first: { $min: '$date' } },
      },
    ]);
  const firstById = new Map(firsts.map((f) => [String(f._id), f.first]));
  for (const u of students)
    out.set(
      String(u._id),
      activeFromYmd(u.createdAt ?? null, firstById.get(String(u._id)) ?? null),
    );
  return out;
}
