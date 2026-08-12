import type { Model } from 'mongoose';
import Question from '../models/Question';
import { getClassQuestionModel } from '../models/ClassQuestion';

/**
 * Which collection holds a given set of questions.
 *
 * ── The rule, copied from the institute exam flow ────────────────────────────
 * Questions are NOT stored in one global bank. They live in per-class
 * collections — `class_11`, `class_12` — created by `getClassQuestionModel()`,
 * and the shared `Question` collection is only the fallback for content with no
 * class at all.
 *
 * `attemptService` encodes this in three places (start, serve, grade):
 *
 *     if (exam.classLevel) {
 *       questions = await getClassQuestionModel(exam.classLevel).find(...)
 *     } else {
 *       questions = await Question.find(...)
 *     }
 *
 * That flow demonstrably works — students attempt, submit and are graded
 * correctly — so it is the source of truth, and this helper is that exact rule
 * with nothing added.
 *
 * ── Why the public side needs it spelled out ─────────────────────────────────
 * A public test outlives the exam it came from, so it cannot look up an
 * `exam.classLevel` at read time. It records which bank its question ids belong
 * to (`PublicTest.questionBank`) at the moment the ids are chosen, and every
 * later read goes through here with that value. Deriving the bank from the
 * test's own `classLevel` instead would be wrong twice over: that field is a
 * DISCOVERY tag an author may edit or clear, and changing it would silently
 * repoint the paper at a collection its ids do not exist in.
 *
 * Institute code is untouched — this is a new helper, not a change to the
 * existing three call sites.
 */

/**
 * The model to read questions from.
 *
 * `classLevel` accepts anything `formatClassCollection` understands — "11",
 * "Class 11", "class_11" — because it is the same normaliser the institute
 * flow uses. Empty or missing means the shared collection.
 */
export function resolveQuestionModel(classLevel?: string | null): Model<any> {
  const value = (classLevel ?? '').toString().trim();
  if (!value) return Question as unknown as Model<any>;
  return getClassQuestionModel(value) as unknown as Model<any>;
}

/**
 * Load questions by id from the right collection.
 *
 * Returns whatever exists; the caller decides what a shortfall means. Nothing
 * here writes, so a promotion or a grading pass can never modify, duplicate or
 * delete a question.
 */
export async function findQuestionsByIds(
  ids: unknown[],
  classLevel?: string | null,
  projection?: string,
): Promise<any[]> {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const model = resolveQuestionModel(classLevel);
  const query = model.find({ _id: { $in: ids } });
  if (projection) query.select(projection);
  return query.lean();
}
