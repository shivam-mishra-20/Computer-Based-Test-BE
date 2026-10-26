/**
 * "Your result is out" for ONLINE exams — once per student per exam.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Written tests already announce their marks (offlineResultsController →
 * "New Result Available"). Publishing an online exam's results flipped
 * `Attempt.resultPublished` and told nobody, so a student learned of it only
 * by opening Results.
 *
 * ── Who is told ─────────────────────────────────────────────────────────────
 * Exactly the students whose attempt at THIS exam is now visible to them:
 * submitted (`submittedAt` set) AND `resultPublished`. Not a student who never
 * submitted, not one still mid-attempt, not anyone outside the exam. The query
 * runs in the publisher's request, so the tenancy layer scopes it to their
 * organization as well, and `sendStudentNotifications` drops any account that
 * is not an institute account.
 *
 * ── Once, whatever happens ──────────────────────────────────────────────────
 * The students to notify are CLAIMED first: one atomic `$addToSet` on the
 * exam's evaluation record returns the list as it was before, and only ids
 * that were not already on it are ours to notify. Two publishes racing, a
 * client retry, the bulk-publish loop, or unpublish → republish therefore
 * cannot notify anyone twice. The trade-off is deliberate: if the send fails
 * after the claim, that student is not retried (at most once, never twice) —
 * the result itself is unaffected and visible in the app either way.
 *
 * ── What the notification carries ───────────────────────────────────────────
 * The exam title and its id. Never a score, percentage, rank or anyone else's
 * data: the app fetches the result through the authenticated API, where the
 * publication rules are enforced.
 */

import { Types } from 'mongoose';
import Attempt from '../models/Attempt';
import Exam from '../models/Exam';
import ExamEvaluation from '../models/ExamEvaluation';

/** The event name both apps route on (legacy: lib/notificationRoutes.ts; platform app: notificationRouting.ts). */
export const EXAM_RESULT_EVENT = 'exam_result';

/**
 * Of the students whose result is now visible, the ones not told yet.
 * Pure — the decision the database claim makes, checkable without one.
 */
export function newlyEntitled(
  visibleUserIds: Iterable<unknown>,
  alreadyNotified: Iterable<unknown>,
): string[] {
  const told = new Set([...alreadyNotified].map(String));
  const out: string[] = [];
  for (const raw of visibleUserIds) {
    const id = String(raw ?? '').trim();
    if (!id || told.has(id)) continue;
    told.add(id);
    out.push(id);
  }
  return out;
}

/** The message, with nothing in it the server would withhold before publication. */
export function resultNotificationPayload(exam: {
  _id: unknown;
  title?: string | null;
}) {
  const title = String(exam.title ?? '').trim() || 'your exam';
  return {
    title: 'Result published',
    body: `Your result for ${title} is now available.`,
    data: { type: EXAM_RESULT_EVENT, examId: String(exam._id) },
  };
}

/**
 * Notify every student whose result for `examId` is published and who has not
 * been told yet. With `attemptId`, only that attempt's student is considered
 * (the per-attempt publish endpoint). Never throws: a notification problem must
 * not undo or fail a publish.
 */
export async function notifyPublishedResults(
  examId: string,
  opts: { attemptId?: string } = {},
): Promise<{ notified: number }> {
  try {
    if (!Types.ObjectId.isValid(examId)) return { notified: 0 };
    const exam = await Exam.findById(examId).select('title').lean();
    if (!exam) return { notified: 0 };

    const filter: Record<string, unknown> = {
      examId: new Types.ObjectId(examId),
      submittedAt: { $ne: null },
      resultPublished: true,
    };
    if (opts.attemptId) {
      if (!Types.ObjectId.isValid(opts.attemptId)) return { notified: 0 };
      filter._id = new Types.ObjectId(opts.attemptId);
    }
    const visible = await Attempt.find(filter).select('userId').lean();
    const candidates = newlyEntitled(
      visible.map((a) => a.userId),
      [],
    );
    if (candidates.length === 0) return { notified: 0 };

    // The evaluation record is where the claim lives; make sure there is one
    // (the per-attempt publish can run before the review screen ever opened).
    const { ensureEvaluation } = await import('./examEvaluationService');
    await ensureEvaluation(examId);
    const before = await ExamEvaluation.findOneAndUpdate(
      { examId: new Types.ObjectId(examId) },
      { $addToSet: { resultsNotifiedUserIds: { $each: candidates } } },
      { new: false },
    )
      .select('resultsNotifiedUserIds')
      .lean();
    const ours = newlyEntitled(
      candidates,
      (before as { resultsNotifiedUserIds?: string[] } | null)
        ?.resultsNotifiedUserIds ?? [],
    );
    if (ours.length === 0) return { notified: 0 };

    const { title, body, data } = resultNotificationPayload(
      exam as { _id: unknown; title?: string },
    );
    const { sendStudentNotifications } = await import('./notificationService');
    await sendStudentNotifications(ours, title, body, data, 'exam');
    return { notified: ours.length };
  } catch (error) {
    console.error(
      '[resultNotifications] could not notify published results:',
      (error as Error)?.message ?? error,
    );
    return { notified: 0 };
  }
}
