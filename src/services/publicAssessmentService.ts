import mongoose from 'mongoose';
import Question, { type IQuestion } from '../models/Question';
import PublicTest, { type IPublicMarkingScheme, type IPublicTest } from '../models/PublicTest';
import type { IPublicAnswer, IPublicAttempt } from '../models/PublicAttempt';
import { gradeObjective } from './attemptService';
import { GRADABILITY_FIELDS, cloneSections, isAutoGradable } from '../utils/publicAssessment';
import { findQuestionsByIds } from '../utils/questionSource';

/**
 * Public assessment engine: snapshots, grading and promotion.
 *
 * ── Grading is server-authoritative ──────────────────────────────────────────
 * The client sends choices only. Every mark is computed here from the question
 * bank's own key, so a tampered request cannot change a score. `scoreAwarded`
 * and `isCorrect` on a submitted answer are always written by this file.
 *
 * ── Reuse ────────────────────────────────────────────────────────────────────
 * `gradeObjective()` from attemptService is used unchanged — it is a pure
 * function over (question, answer) covering single-choice, true/false,
 * multi-select, integer and fill. What is NOT reused is
 * `examEvaluationService.gradeAttemptRaw`, which is coupled to Exam sections,
 * per-exam answer-key overrides and teacher manual scores; the ~30 lines of
 * marking-scheme application are reimplemented here against the public shape.
 */

// ─── Snapshot ────────────────────────────────────────────────────────────────

const shuffle = <T>(items: T[]): T[] => {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/**
 * Freeze the paper a learner will see.
 *
 * Order is resolved ONCE, at start, and stored — a resumed attempt must show
 * the same questions in the same order, and re-shuffling on every resume would
 * let a learner reroll a hard paper.
 */
export function buildSnapshot(test: IPublicTest, questions: IQuestion[]) {
  const byId = new Map(questions.map((q) => [String(q._id), q]));
  const questionOrder: mongoose.Types.ObjectId[] = [];
  const optionOrderByQuestion: Record<string, string[]> = {};

  for (const section of test.sections || []) {
    const ids = (section.questionIds || []).filter((id) => byId.has(String(id)));

    /**
     * Questions are laid out SUBJECT BY SUBJECT, and shuffling happens inside
     * each subject rather than across the whole section.
     *
     * A promoted 75-question paper mixes Physics, Chemistry and Maths in one
     * section. Shuffling that flat list interleaved them, so the palette showed
     * Physics at positions 3, 4, 6, 7, 11… — technically the true order, but a
     * paper nobody would set and a question list nobody can navigate. Every
     * real mock runs one subject at a time.
     *
     * Subjects appear in the order they first occur in the authored list, so an
     * author who ordered the paper deliberately still gets their order. Only
     * the INTERLEAVING is removed; the author's shuffle intent is preserved
     * within each subject.
     */
    const subjectOrder: string[] = [];
    const bySubject = new Map<string, typeof ids>();
    for (const id of ids) {
      const q = byId.get(String(id));
      const subject = ((q?.tags?.subject || (q as any)?.subject || '') as string).trim() || 'General';
      if (!bySubject.has(subject)) {
        bySubject.set(subject, [] as typeof ids);
        subjectOrder.push(subject);
      }
      bySubject.get(subject)!.push(id);
    }

    const ordered = subjectOrder.flatMap((subject) => {
      const group = bySubject.get(subject)!;
      return section.shuffleQuestions ? shuffle(group) : group;
    });
    questionOrder.push(...ordered);

    if (section.shuffleOptions) {
      for (const id of ordered) {
        const q = byId.get(String(id));
        if (q?.options?.length) {
          optionOrderByQuestion[String(id)] = shuffle(q.options.map((o) => String(o._id)));
        }
      }
    }
  }

  return { questionOrder, optionOrderByQuestion };
}

/**
 * Questions in the attempt's frozen order, ready to serve or grade.
 *
 * `questionBank` is REQUIRED in practice even though it is optional in the
 * signature: questions live in per-class collections, so omitting it reads the
 * shared `Question` collection and finds nothing for a paper built from
 * class_11. Callers pass `test.questionBank`.
 */
export async function loadSnapshotQuestions(
  attempt: IPublicAttempt,
  projection?: string,
  questionBank?: string | null,
) {
  const ids = attempt.snapshot?.questionOrder ?? [];
  if (ids.length === 0) return [];

  const found = await findQuestionsByIds(ids, questionBank, projection);

  // Restore the snapshot order — Mongo returns $in results in storage order.
  const byId = new Map(found.map((q: any) => [String(q._id), q]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean) as any[];
}

/**
 * Apply a snapshot's option ordering to a sanitised question.
 *
 * Kept separate from sanitisation so shuffling can never be the thing that
 * accidentally reintroduces an answer-key field.
 */
export function applyOptionOrder<T extends { _id: string; options?: { _id: string }[] }>(
  question: T,
  optionOrder?: Record<string, string[]>,
): T {
  const order = optionOrder?.[question._id];
  if (!order || !question.options) return question;
  const byId = new Map(question.options.map((o) => [o._id, o]));
  const reordered = order.map((id) => byId.get(id)).filter(Boolean) as typeof question.options;
  // Any option missing from the stored order (bank edited mid-attempt) is
  // appended rather than dropped — losing an option would break the question.
  const seen = new Set(order);
  const extras = question.options.filter((o) => !seen.has(o._id));
  return { ...question, options: [...reordered, ...extras] };
}

// ─── Grading ─────────────────────────────────────────────────────────────────

export interface GradedResult {
  totalScore: number;
  maxScore: number;
  percentage: number;
  correctCount: number;
  incorrectCount: number;
  unattemptedCount: number;
  answers: IPublicAnswer[];
  bySubject: {
    subject: string;
    correct: number;
    total: number;
    score: number;
  }[];
  byDifficulty: { difficulty: string; correct: number; total: number }[];
}

const hasResponse = (a?: IPublicAnswer): boolean =>
  !!a && (!!a.chosenOptionId || (typeof a.textAnswer === 'string' && a.textAnswer.trim() !== ''));

/**
 * Grade a whole attempt against the live question bank.
 *
 * Iterates the SNAPSHOT rather than the submitted answers, so unattempted
 * questions still contribute their `unattempted` mark and their share of the
 * maximum. Grading the answer list alone would silently shrink the paper for
 * anyone who skipped questions.
 *
 * Questions with no answer key cannot be auto-graded. They are excluded from
 * both the score and the maximum rather than being marked wrong — scoring a
 * learner zero for an essay nobody read would be a false result.
 *
 * The test is `isAutoGradable`, the SAME predicate the promotion gate uses, and
 * that shared use is the point: if the gate accepted a paper on the strength of
 * a question the grader then skipped, the paper's maximum would silently shrink
 * and every learner's percentage would be computed against a different total
 * than the author configured. Checking the type LABEL in one place and the
 * actual KEY in the other is exactly how those two drift apart.
 */
export function gradeAttempt(
  attempt: IPublicAttempt,
  questions: IQuestion[],
  scheme: IPublicMarkingScheme,
): GradedResult {
  const byId = new Map(questions.map((q) => [String(q._id), q]));
  const answerByQid = new Map((attempt.answers || []).map((a) => [String(a.questionId), a]));

  const subjectAgg = new Map<string, { correct: number; total: number; score: number }>();
  const difficultyAgg = new Map<string, { correct: number; total: number }>();

  let totalScore = 0;
  let maxScore = 0;
  let correctCount = 0;
  let incorrectCount = 0;
  let unattemptedCount = 0;

  const graded: IPublicAnswer[] = [];

  for (const qid of attempt.snapshot?.questionOrder ?? []) {
    const key = String(qid);
    const question = byId.get(key);
    if (!question) continue; // removed from the bank mid-attempt

    if (!isAutoGradable(question)) continue; // see doc comment

    maxScore += scheme.correct;

    const subject = question.tags?.subject || 'Other';
    const difficulty = question.tags?.difficulty || 'medium';
    const s = subjectAgg.get(subject) ?? { correct: 0, total: 0, score: 0 };
    const d = difficultyAgg.get(difficulty) ?? { correct: 0, total: 0 };
    s.total += 1;
    d.total += 1;

    const answer = answerByQid.get(key);

    if (!hasResponse(answer)) {
      unattemptedCount += 1;
      totalScore += scheme.unattempted;
      s.score += scheme.unattempted;
      if (answer) {
        /**
         * `isCorrect` is left UNDEFINED, never false.
         *
         * A question the learner opened, spent time on, or flagged still has a
         * stored answer row even with no response — and stamping it `false`
         * made it indistinguishable from a genuine wrong answer. The review
         * screen counted those rows as wrong, so a paper with 4 wrong and 68
         * skipped advertised "Wrong 10".
         *
         * Undefined is the honest value: this question was not answered, so
         * there is no correctness to report. `scoreAwarded` still records the
         * unattempted mark, which is a real fact about the score.
         */
        graded.push({
          ...answer,
          isCorrect: undefined,
          scoreAwarded: scheme.unattempted,
        });
      }
      subjectAgg.set(subject, s);
      difficultyAgg.set(difficulty, d);
      continue;
    }

    const outcome = gradeObjective(question, answer as any);
    const isCorrect = !!outcome?.isCorrect;
    const award = isCorrect ? scheme.correct : scheme.incorrect;

    totalScore += award;
    s.score += award;

    if (isCorrect) {
      correctCount += 1;
      s.correct += 1;
      d.correct += 1;
    } else {
      incorrectCount += 1;
    }

    graded.push({
      ...(answer as IPublicAnswer),
      isCorrect,
      scoreAwarded: award,
    });
    subjectAgg.set(subject, s);
    difficultyAgg.set(difficulty, d);
  }

  // A negative marking scheme can drive a total below zero; clamping keeps the
  // percentage meaningful and matches how students read a scorecard.
  const clamped = Math.max(totalScore, 0);

  return {
    totalScore,
    maxScore,
    percentage: maxScore > 0 ? Math.round((clamped / maxScore) * 10000) / 100 : 0,
    correctCount,
    incorrectCount,
    unattemptedCount,
    answers: graded,
    bySubject: Array.from(subjectAgg.entries())
      .map(([subject, v]) => ({ subject, ...v }))
      .sort((a, b) => b.total - a.total),
    byDifficulty: ['easy', 'medium', 'hard']
      .filter((k) => difficultyAgg.has(k))
      .map((k) => ({ difficulty: k, ...difficultyAgg.get(k)! })),
  };
}

// ─── Promotion ───────────────────────────────────────────────────────────────

export interface PromotionInput {
  examId: string;
  actorId: string;
  /** Public-facing overrides; the institute exam's own fields are never edited. */
  overrides?: {
    title?: string;
    description?: string;
    kind?: IPublicTest['kind'];
    board?: string[];
    classLevel?: string;
    subject?: string;
    exam?: string;
    examType?: string;
    difficulty?: IPublicTest['difficulty'];
  };
}

/**
 * Promote an institute exam into a public test.
 *
 * ── Why this is a COPY, never a flag ─────────────────────────────────────────
 * Marking an Exam "also public" would put institute content one forgotten
 * filter away from the public API, and any later edit by a teacher would
 * silently change what the public sees. Promotion therefore reads the exam and
 * writes a brand-new PublicTest: the two diverge from that moment on, and the
 * institute exam is never mutated.
 *
 * The source is recorded in `duplicatedFrom` for provenance and the action is
 * logged, so "how did this become public?" always has an answer.
 *
 * Questions are shared by reference — they are a common bank, and copying them
 * would fragment it and detach the public paper from later bank corrections.
 */
/**
 * An exam that cannot be promoted, as opposed to something going wrong.
 *
 * Carries a marker so the route can answer 422 rather than 500 without
 * string-matching the message — which goes stale as soon as the wording gains
 * a count, and silently turns a real refusal into a server error.
 */
function promotionRefusal(message: string): Error & { isPromotionRefusal: true } {
  const error = new Error(message) as Error & { isPromotionRefusal: true };
  error.isPromotionRefusal = true;
  return error;
}

export async function promoteExamToPublicTest(input: PromotionInput) {
  const Exam = (await import('../models/Exam')).default;

  const exam = await Exam.findById(input.examId).lean();
  if (!exam) throw promotionRefusal('Exam not found');

  const sections = cloneSections((exam as any).sections);
  const questionIds = sections.flatMap((s: any) => s.questionIds || []);

  if (questionIds.length === 0) {
    throw promotionRefusal('This exam has no questions to promote');
  }

  // Refuse silently-unscoreable papers at the boundary rather than letting a
  // learner discover it at submit time.
  /**
   * Resolve from the SAME collection the institute exam flow reads.
   *
   * Questions live in per-class collections (`class_11`, …), keyed by the
   * exam's own classLevel — see utils/questionSource.ts. Reading the shared
   * `Question` collection instead found nothing, which is why a perfectly valid
   * 75-question exam reported all 75 as missing.
   *
   * GRADABILITY_FIELDS must be selected too — `isAutoGradable` reads the answer
   * key, and a projection of `type` alone makes every question look ungradable.
   */
  const questionBank = (exam as any).classLevel as string | undefined;
  const questions = await findQuestionsByIds(
    questionIds,
    questionBank,
    `${GRADABILITY_FIELDS} tags.subject tags.difficulty`,
  );

  /**
   * Two distinct failures, reported distinctly.
   *
   * These used to share one message ("no auto-gradable questions"), which sent
   * authors hunting for a marking problem when the real fault was that the
   * exam's questions no longer resolve in the bank. An error that names the
   * wrong cause costs more time than no error at all.
   */
  if (questions.length === 0) {
    throw promotionRefusal(
      `None of this exam's ${questionIds.length} question(s) could be found in ${
        questionBank ? `the Class ${questionBank} question bank` : 'the shared question bank'
      }. They may have been deleted since the exam was built.`,
    );
  }

  const gradable = questions.filter(isAutoGradable);
  if (gradable.length === 0) {
    throw promotionRefusal(
      `None of this exam's ${questions.length} question(s) have an answer key, so the paper cannot be graded automatically. Mark a correct option (or fill in the answer) on at least one question first.`,
    );
  }

  const o = input.overrides ?? {};
  const inferredSubjects = Array.from(
    new Set(questions.map((q: any) => q.tags?.subject).filter(Boolean)),
  );

  const created = await PublicTest.create({
    title: o.title ?? (exam as any).title,
    description: o.description ?? (exam as any).description,
    kind: o.kind ?? 'MOCK',
    sections,
    markingScheme: {
      correct: (exam as any).markingScheme?.correct ?? 1,
      incorrect: (exam as any).markingScheme?.incorrect ?? 0,
      unattempted: (exam as any).markingScheme?.unattempted ?? 0,
    },
    durationMins: (exam as any).totalDurationMins ?? 30,
    board: o.board ?? [],
    // The institute exam's classLevel is a label like "Class 10"; the public
    // side stores digits only, matching learnerProfile.classLevel.
    classLevel: o.classLevel ?? normalizePublicClass((exam as any).classLevel),
    subject: o.subject ?? (inferredSubjects.length === 1 ? inferredSubjects[0] : undefined),
    exam: o.exam,
    examType: o.examType,
    difficulty: o.difficulty ?? 'mixed',
    // Always lands as a draft. Promotion must never publish institute content
    // to the world in one step.
    status: 'draft',
    instructions: (exam as any).instructions,
    // The collection these ids came from. Without it the public attempt player
    // would look them up in the wrong place and serve an empty paper.
    questionBank,
    createdBy: new mongoose.Types.ObjectId(input.actorId),
    duplicatedFrom: (exam as any)._id,
  });

  console.log(
    `[PromoteExam] exam=${input.examId} -> publicTest=${created._id} by=${input.actorId} (draft)`,
  );

  return created;
}

/**
 * Duplicate a public test into an independent copy.
 *
 * Verified by scripts/verify-public-assessment.ts: section subdocument ids are
 * dropped so the copy owns its own, and mutating the copy cannot reach the
 * original.
 */
export async function duplicatePublicTest(testId: string, actorId: string) {
  const source = await PublicTest.findById(testId).lean();
  if (!source) throw new Error('Test not found');

  const copy = await PublicTest.create({
    ...source,
    _id: undefined,
    title: `${source.title} (copy)`,
    sections: cloneSections(source.sections as any),
    status: 'draft',
    seriesId: undefined,
    orderInSeries: undefined,
    createdBy: new mongoose.Types.ObjectId(actorId),
    duplicatedFrom: source._id,
    createdAt: undefined,
    updatedAt: undefined,
  } as any);

  console.log(`[DuplicateTest] ${testId} -> ${copy._id} by=${actorId} (draft)`);
  return copy;
}

/** "Class 10" / "10th" / 10 → "10". Null when unrecognised. */
export function normalizePublicClass(input?: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  const match = String(input).match(/(\d{1,2})/);
  if (!match) return undefined;
  const value = String(Number(match[1]));
  return ['6', '7', '8', '9', '10', '11', '12'].includes(value) ? value : undefined;
}
