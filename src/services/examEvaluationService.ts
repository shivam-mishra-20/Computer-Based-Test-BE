import { Types } from 'mongoose';
import Exam, { IExam } from '../models/Exam';
import Attempt from '../models/Attempt';
import Question, { IQuestion } from '../models/Question';
import User from '../models/User';
import ExamEvaluation, {
  IExamEvaluation,
  ReviewState,
  OverrideMode,
  IEvaluationVersion,
  IMarkingScheme,
  IQuestionMarks,
} from '../models/ExamEvaluation';
import ReviewAuditLog, { ReviewAuditAction } from '../models/ReviewAuditLog';
import { getClassQuestionModel } from '../models/ClassQuestion';
import { sanitizeQuestion } from '../utils/exam';
import { gradeObjective, isSubjectiveType } from './attemptService';

const DEFAULT_SCHEME: IMarkingScheme = { correct: 1, incorrect: 0, unattempted: 0 };

// The marking scheme lives on the Exam (set at build time) and is the single
// source of truth for grading + review. Reading it here guarantees the scheme a
// teacher chose during creation always reflects in the test and the review,
// instead of a stale per-evaluation copy.
function examScheme(exam: any): IMarkingScheme {
  const ms = exam?.markingScheme;
  return ms && (ms.correct !== undefined || ms.incorrect !== undefined || ms.unattempted !== undefined)
    ? { correct: ms.correct ?? 1, incorrect: ms.incorrect ?? 0, unattempted: ms.unattempted ?? 0 }
    : { ...DEFAULT_SCHEME };
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Resolve the marks for one question: a per-question override wins over the
// test-level marking scheme, field by field.
function marksForQuestion(qid: string, scheme: IMarkingScheme, questionMarks?: Map<string, IQuestionMarks>) {
  const m = questionMarks?.get(qid);
  return {
    correct: m?.correct ?? scheme.correct,
    incorrect: m?.incorrect ?? scheme.incorrect,
    unattempted: m?.unattempted ?? scheme.unattempted,
  };
}

// Base total = sum of each question's "correct" marks (objective and the max a
// subjective answer can earn).
export function computeBaseMax(
  orderedQids: string[],
  qmap: Map<string, IQuestion>,
  scheme: IMarkingScheme,
  questionMarks?: Map<string, IQuestionMarks>
): number {
  let max = 0;
  for (const qid of orderedQids) {
    if (!qmap.get(qid)) continue;
    max += marksForQuestion(qid, scheme, questionMarks).correct;
  }
  return round2(max);
}

// ── Question loading ─────────────────────────────────────────────────────────
async function loadExamQuestionMap(exam: IExam): Promise<Map<string, IQuestion>> {
  const qids = exam.sections.flatMap((s) => s.questionIds);
  let questions: IQuestion[];
  if (exam.classLevel) {
    const ClassQuestionModel = getClassQuestionModel(exam.classLevel);
    questions = await ClassQuestionModel.find({ _id: { $in: qids } });
  } else {
    questions = await Question.find({ _id: { $in: qids } });
  }
  return new Map<string, IQuestion>(questions.map((q) => [(q as any)._id.toString(), q]));
}

// Apply an exam-scoped answer-key correction to a question WITHOUT mutating the
// shared question bank. Returns a plain object safe to pass to the grader.
function applyAnswerKeyOverride(q: IQuestion, override?: { optionIds?: string[]; correctText?: string }): IQuestion {
  if (!override) return q;
  const clone: any = typeof (q as any).toObject === 'function' ? (q as any).toObject() : { ...(q as any) };
  if (Array.isArray(override.optionIds) && clone.options) {
    const correct = new Set(override.optionIds.map((id) => id.toString()));
    clone.options = clone.options.map((o: any) => ({ ...o, isCorrect: correct.has(o._id.toString()) }));
  }
  if (override.correctText !== undefined && override.correctText !== null) {
    clone.correctAnswerText = override.correctText;
  }
  return clone as IQuestion;
}

// ── Score math ───────────────────────────────────────────────────────────────
export interface RawScore {
  rawTotalScore: number;
  rawMaxScore: number;
}

/**
 * Re-grade one attempt from scratch: objective answers are graded against the
 * current answer key (exam override → bank fallback); subjective answers keep
 * their stored (teacher/AI) score. Mutates the attempt's answer `isCorrect` /
 * `scoreAwarded` so downstream readers (analytics) stay consistent.
 */
export function gradeAttemptRaw(
  attempt: any,
  orderedQids: string[],
  qmap: Map<string, IQuestion>,
  answerKeyOverrides: Map<string, { optionIds?: string[]; correctText?: string }> | undefined,
  scheme: IMarkingScheme,
  questionMarks?: Map<string, IQuestionMarks>
): RawScore {
  let rawTotal = 0;
  let rawMax = 0;
  // Iterate the full exam (not just answered questions) so "not attempted"
  // marks and the per-question max are applied even when there is no answer.
  for (const qid of orderedQids) {
    const q = qmap.get(qid);
    if (!q) continue;
    const m = marksForQuestion(qid, scheme, questionMarks);
    rawMax += m.correct;
    const ans = attempt.answers.find((a: any) => a.questionId.toString() === qid);

    // Teacher's manual per-question mark wins over everything (objective OR
    // subjective) and must persist across recomputes. Only a real number counts
    // as "set"; undefined/null means fall back to automatic grading below.
    if (ans && typeof ans.manualScore === 'number' && !Number.isNaN(ans.manualScore)) {
      ans.scoreAwarded = ans.manualScore;
      ans.isCorrect = ans.manualScore > 0;
      rawTotal += ans.manualScore;
      continue;
    }

    // Subjective: keep the teacher-awarded marks (0..correct); default 0.
    if (isSubjectiveType((q as any).type)) {
      rawTotal += typeof ans?.scoreAwarded === 'number' ? ans.scoreAwarded : 0;
      continue;
    }

    const attempted = !!(ans && (ans.chosenOptionId || (ans.textAnswer != null && String(ans.textAnswer) !== '')));
    if (!attempted) {
      if (ans) {
        ans.scoreAwarded = m.unattempted;
        ans.isCorrect = false;
      }
      rawTotal += m.unattempted;
      continue;
    }

    const effQ = applyAnswerKeyOverride(q, answerKeyOverrides?.get(qid));
    const graded = gradeObjective(effQ as IQuestion, ans);
    const isCorrect = !!graded?.isCorrect;
    if (ans) {
      ans.isCorrect = isCorrect;
      ans.scoreAwarded = isCorrect ? m.correct : m.incorrect;
    }
    rawTotal += isCorrect ? m.correct : m.incorrect;
  }
  return { rawTotalScore: round2(rawTotal), rawMaxScore: round2(rawMax) };
}

/** Apply the test-level total-marks override to a raw score. Idempotent. */
export function applyOverride(
  raw: RawScore,
  evaluation: Pick<IExamEvaluation, 'totalMarksOverride' | 'overrideMode'>
): { totalScore: number; maxScore: number; percentage: number } {
  const override = evaluation.totalMarksOverride;
  const { rawTotalScore, rawMaxScore } = raw;
  let totalScore = rawTotalScore;
  let maxScore = rawMaxScore;
  if (override !== null && override !== undefined && override > 0) {
    if (evaluation.overrideMode === 'denominator') {
      maxScore = override;
      totalScore = rawTotalScore;
    } else {
      // proportional rescale (default)
      const factor = rawMaxScore > 0 ? override / rawMaxScore : 0;
      totalScore = round2(rawTotalScore * factor);
      maxScore = override;
    }
  }
  // Negative marking can drive a raw total below zero; the displayed percentage
  // is floored at 0 (the signed score itself is preserved for ranking).
  const percentage = maxScore > 0 ? Math.max(0, round2((totalScore / maxScore) * 100)) : 0;
  return { totalScore: round2(totalScore), maxScore: round2(maxScore), percentage };
}

// ── Evaluation record helpers ────────────────────────────────────────────────
export async function ensureEvaluation(examId: string | Types.ObjectId): Promise<IExamEvaluation> {
  const id = new Types.ObjectId(examId);
  let evaluation = await ExamEvaluation.findOne({ examId: id });
  if (!evaluation) {
    // Seed the grading scheme from the exam's build-time marking scheme so the
    // same +N / -M / 0 logic chosen at creation flows into review/grading.
    const exam = await Exam.findById(id).select('markingScheme');
    const ms = (exam as any)?.markingScheme;
    const seeded =
      ms && (ms.correct !== undefined || ms.incorrect !== undefined || ms.unattempted !== undefined)
        ? { correct: ms.correct ?? 1, incorrect: ms.incorrect ?? 0, unattempted: ms.unattempted ?? 0 }
        : undefined;
    evaluation = await ExamEvaluation.create({
      examId: id,
      reviewState: 'draft',
      ...(seeded ? { markingScheme: seeded } : {}),
      versions: [{ version: 1, event: 'created', reviewState: 'draft', at: new Date() }],
    });
  }
  return evaluation;
}

function pushVersion(
  evaluation: IExamEvaluation,
  event: IEvaluationVersion['event'],
  by?: Types.ObjectId,
  note?: string
) {
  evaluation.versions.push({
    version: (evaluation.versions.length || 0) + 1,
    event,
    reviewState: evaluation.reviewState,
    totalMarks: evaluation.totalMarksOverride ?? evaluation.baseTotalMarks,
    note,
    by,
    at: new Date(),
    stats: {
      totalAttempts: evaluation.stats.totalAttempts,
      avgScore: evaluation.stats.avgScore,
      avgPercentage: evaluation.stats.avgPercentage,
      highest: evaluation.stats.highest,
      lowest: evaluation.stats.lowest,
    },
  });
}

async function writeAudit(entry: {
  examId: Types.ObjectId;
  action: ReviewAuditAction;
  actorId?: string;
  attemptId?: Types.ObjectId | string;
  questionId?: string;
  studentId?: Types.ObjectId | string;
  field?: string;
  oldValue?: any;
  newValue?: any;
  note?: string;
  meta?: Record<string, any>;
}) {
  let actorName: string | undefined;
  if (entry.actorId) {
    const u = await User.findById(entry.actorId).select('name').lean();
    actorName = (u as any)?.name;
  }
  await ReviewAuditLog.create({
    examId: entry.examId,
    attemptId: entry.attemptId ? new Types.ObjectId(entry.attemptId) : undefined,
    questionId: entry.questionId,
    studentId: entry.studentId ? new Types.ObjectId(entry.studentId) : undefined,
    actorId: entry.actorId ? new Types.ObjectId(entry.actorId) : undefined,
    actorName,
    action: entry.action,
    field: entry.field,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
    note: entry.note,
    meta: entry.meta,
  });
}

// ── The propagation engine ───────────────────────────────────────────────────
/**
 * Recompute every submitted attempt for an exam: re-grade against the current
 * answer key, apply the total-marks override, recompute percentages, assign
 * per-test ranks, and refresh the cached evaluation stats. Idempotent — always
 * derives from the immutable raw scores so repeated calls never drift.
 */
export async function recomputeExamResults(
  examId: string | Types.ObjectId,
  opts: { actorId?: string; logAction?: ReviewAuditAction; note?: string } = {}
): Promise<IExamEvaluation> {
  const id = new Types.ObjectId(examId);
  const exam = await Exam.findById(id);
  if (!exam) throw new Error('Exam not found');
  const evaluation = await ensureEvaluation(id);
  const qmap = await loadExamQuestionMap(exam);
  const orderedQids = exam.sections.flatMap((s) => s.questionIds.map((q) => q.toString()));
  const scheme = examScheme(exam);
  const qMarks = evaluation.questionMarks as Map<string, IQuestionMarks> | undefined;
  const baseMax = computeBaseMax(orderedQids, qmap, scheme, qMarks);
  evaluation.baseTotalMarks = baseMax;

  const attempts = await Attempt.find({ examId: id, submittedAt: { $ne: null } });

  // 1) Re-grade (with marking scheme + answer-key overrides) and rescale each attempt.
  const overrides = evaluation.answerKeyOverrides as Map<string, { optionIds?: string[]; correctText?: string }> | undefined;
  const computed = attempts.map((a) => {
    const raw = gradeAttemptRaw(a, orderedQids, qmap, overrides, scheme, qMarks);
    const eff = applyOverride(raw, evaluation);
    a.rawTotalScore = raw.rawTotalScore;
    a.rawMaxScore = raw.rawMaxScore;
    a.totalScore = eff.totalScore;
    a.maxScore = eff.maxScore;
    a.percentage = eff.percentage;
    return a;
  });

  // 2) Standard competition ranking (1,2,2,4) by effective score desc.
  const ranked = [...computed].sort((x, y) => (y.totalScore || 0) - (x.totalScore || 0));
  let lastScore: number | null = null;
  let lastRank = 0;
  ranked.forEach((a, idx) => {
    const score = a.totalScore || 0;
    if (lastScore === null || score < lastScore) {
      lastRank = idx + 1;
      lastScore = score;
    }
    a.rankInTest = lastRank;
  });

  // 2b) Percentile (0-100): the % of the cohort this attempt scored strictly
  // higher than. Top unique scorer ≈ 100, lowest = 0. Persisted per attempt.
  const N = computed.length;
  const allScores = computed.map((a) => a.totalScore || 0);
  computed.forEach((a) => {
    const score = a.totalScore || 0;
    const numBelow = allScores.reduce((acc, s) => (s < score ? acc + 1 : acc), 0);
    a.percentile = N > 0 ? round2((numBelow / N) * 100) : 0;
  });

  // 3) Persist all attempts in one batch.
  if (computed.length) {
    await Attempt.bulkWrite(
      computed.map((a) => ({
        updateOne: {
          filter: { _id: a._id },
          update: {
            $set: {
              answers: a.answers,
              rawTotalScore: a.rawTotalScore,
              rawMaxScore: a.rawMaxScore,
              totalScore: a.totalScore,
              maxScore: a.maxScore,
              percentage: a.percentage,
              rankInTest: a.rankInTest,
              percentile: a.percentile,
            },
          },
        },
      }))
    );
  }

  // 4) Refresh cached stats + distribution.
  const totalAttempts = computed.length;
  const pendingReviews = computed.filter((a) => !a.resultPublished).length;
  const gradedAttempts = computed.filter((a) => a.resultPublished || a.status === 'graded').length;
  const scores = computed.map((a) => a.totalScore || 0);
  const percents = computed.map((a) => a.percentage || 0);
  const avgScore = totalAttempts ? round2(scores.reduce((s, v) => s + v, 0) / totalAttempts) : 0;
  const avgPercentage = totalAttempts ? round2(percents.reduce((s, v) => s + v, 0) / totalAttempts) : 0;
  const distribution: Record<string, number> = {};
  for (let b = 0; b < 10; b++) distribution[`${b * 10}-${b * 10 + 10}`] = 0;
  for (const p of percents) {
    const bucket = Math.min(9, Math.max(0, Math.floor(p / 10)));
    distribution[`${bucket * 10}-${bucket * 10 + 10}`] += 1;
  }

  evaluation.stats = {
    totalAttempts,
    pendingReviews,
    gradedAttempts,
    avgScore,
    avgPercentage,
    highest: scores.length ? Math.max(...scores) : 0,
    lowest: scores.length ? Math.min(...scores) : 0,
    distribution,
    lastRecomputedAt: new Date(),
  };

  if (opts.logAction) {
    pushVersion(evaluation, 'recompute', opts.actorId ? new Types.ObjectId(opts.actorId) : undefined, opts.note);
  }
  await evaluation.save();

  if (opts.logAction) {
    await writeAudit({
      examId: id,
      action: opts.logAction,
      actorId: opts.actorId,
      note: opts.note,
      meta: { totalAttempts, avgPercentage },
    });
  }

  return evaluation;
}

// ── Test-level mutations ─────────────────────────────────────────────────────
export async function setTotalMarks(
  examId: string,
  newTotal: number | null,
  mode: OverrideMode,
  actorId?: string
): Promise<IExamEvaluation> {
  const evaluation = await ensureEvaluation(examId);
  const previous = evaluation.totalMarksOverride ?? null;
  const wasPublished = evaluation.reviewState === 'published' || evaluation.reviewState === 'republished';

  evaluation.totalMarksOverride = newTotal;
  if (mode) evaluation.overrideMode = mode;
  await evaluation.save();

  await writeAudit({
    examId: new Types.ObjectId(examId),
    action: 'total_marks_changed',
    actorId,
    field: 'totalMarks',
    oldValue: previous,
    newValue: newTotal,
    meta: { mode: evaluation.overrideMode },
  });

  const updated = await recomputeExamResults(examId, { actorId });
  // A change after publishing auto-propagates to students and is recorded as a
  // republish event (the "Republished After Changes" state).
  if (wasPublished) {
    updated.reviewState = 'republished';
    updated.publishedAt = new Date();
    if (actorId) updated.publishedBy = new Types.ObjectId(actorId);
    pushVersion(updated, 'total_marks_changed', actorId ? new Types.ObjectId(actorId) : undefined, 'Total marks changed after publish');
    await updated.save();
  } else {
    pushVersion(updated, 'total_marks_changed', actorId ? new Types.ObjectId(actorId) : undefined);
    await updated.save();
  }
  return updated;
}

export async function setAnswerKey(
  examId: string,
  questionId: string,
  key: { optionIds?: string[]; correctText?: string } | null,
  actorId?: string
): Promise<IExamEvaluation> {
  const evaluation = await ensureEvaluation(examId);
  const wasPublished = evaluation.reviewState === 'published' || evaluation.reviewState === 'republished';
  const previous = evaluation.answerKeyOverrides?.get(questionId) || null;

  if (key === null) {
    evaluation.answerKeyOverrides.delete(questionId);
  } else {
    evaluation.answerKeyOverrides.set(questionId, key);
  }
  await evaluation.save();

  await writeAudit({
    examId: new Types.ObjectId(examId),
    action: 'answer_key_changed',
    actorId,
    questionId,
    field: 'answerKey',
    oldValue: previous,
    newValue: key,
  });

  const updated = await recomputeExamResults(examId, { actorId });
  if (wasPublished) {
    updated.reviewState = 'republished';
    updated.publishedAt = new Date();
    if (actorId) updated.publishedBy = new Types.ObjectId(actorId);
    pushVersion(updated, 'answer_key_changed', actorId ? new Types.ObjectId(actorId) : undefined, 'Answer key changed after publish');
  } else {
    pushVersion(updated, 'answer_key_changed', actorId ? new Types.ObjectId(actorId) : undefined);
  }
  await updated.save();
  return updated;
}

export async function setMarkingScheme(
  examId: string,
  scheme: { correct: number; incorrect: number; unattempted: number },
  actorId?: string
): Promise<IExamEvaluation> {
  const exam = await Exam.findById(examId).select('markingScheme');
  if (!exam) throw new Error('Exam not found');
  const prev = (exam as any).markingScheme;
  const previous = prev
    ? { correct: prev.correct, incorrect: prev.incorrect, unattempted: prev.unattempted }
    : undefined;
  const next = {
    correct: Number(scheme.correct) || 0,
    incorrect: Number(scheme.incorrect) || 0,
    unattempted: Number(scheme.unattempted) || 0,
  };
  // Persist on the Exam (single source of truth) so the change is reflected in
  // the test, future attempts and the review alike — never reset to default.
  await Exam.findByIdAndUpdate(examId, { markingScheme: next });

  const evaluation = await ensureEvaluation(examId);
  const wasPublished = evaluation.reviewState === 'published' || evaluation.reviewState === 'republished';

  await writeAudit({
    examId: new Types.ObjectId(examId),
    action: 'marking_scheme_changed',
    actorId,
    field: 'markingScheme',
    oldValue: previous,
    newValue: next,
  });

  const updated = await recomputeExamResults(examId, { actorId });
  if (wasPublished) {
    updated.reviewState = 'republished';
    updated.publishedAt = new Date();
    if (actorId) updated.publishedBy = new Types.ObjectId(actorId);
    pushVersion(updated, 'marking_scheme_changed', actorId ? new Types.ObjectId(actorId) : undefined, 'Marking scheme changed after publish');
  } else {
    pushVersion(updated, 'marking_scheme_changed', actorId ? new Types.ObjectId(actorId) : undefined);
  }
  await updated.save();
  return updated;
}

export async function setQuestionMarks(
  examId: string,
  questionId: string,
  marks: { correct?: number; incorrect?: number; unattempted?: number } | null,
  actorId?: string
): Promise<IExamEvaluation> {
  const evaluation = await ensureEvaluation(examId);
  const wasPublished = evaluation.reviewState === 'published' || evaluation.reviewState === 'republished';
  const previous = evaluation.questionMarks?.get(questionId) || null;

  if (marks === null) {
    evaluation.questionMarks.delete(questionId);
  } else {
    const clean: IQuestionMarks = {};
    if (marks.correct !== undefined && marks.correct !== null) clean.correct = Number(marks.correct);
    if (marks.incorrect !== undefined && marks.incorrect !== null) clean.incorrect = Number(marks.incorrect);
    if (marks.unattempted !== undefined && marks.unattempted !== null) clean.unattempted = Number(marks.unattempted);
    evaluation.questionMarks.set(questionId, clean);
  }
  await evaluation.save();

  await writeAudit({
    examId: new Types.ObjectId(examId),
    action: 'question_marks_changed',
    actorId,
    questionId,
    field: 'questionMarks',
    oldValue: previous,
    newValue: marks,
  });

  const updated = await recomputeExamResults(examId, { actorId });
  if (wasPublished) {
    updated.reviewState = 'republished';
    updated.publishedAt = new Date();
    if (actorId) updated.publishedBy = new Types.ObjectId(actorId);
    pushVersion(updated, 'question_marks_changed', actorId ? new Types.ObjectId(actorId) : undefined, 'Per-question marks changed after publish');
  } else {
    pushVersion(updated, 'question_marks_changed', actorId ? new Types.ObjectId(actorId) : undefined);
  }
  await updated.save();
  return updated;
}

/** Adjust one subjective answer's score, then recompute the whole test. */
export async function adjustSubjectiveScore(
  attemptId: string,
  questionId: string,
  score: number,
  feedback: string | undefined,
  actorId?: string
): Promise<IExamEvaluation> {
  const attempt = await Attempt.findById(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  if (!attempt.examId) throw new Error('Attempt is not an exam attempt');

  const ans = attempt.answers.find((a) => a.questionId.toString() === questionId);
  const previous = ans?.scoreAwarded;
  if (ans) {
    ans.scoreAwarded = score;
    if (feedback) ans.aiFeedback = feedback;
  } else {
    attempt.answers.push({ questionId: new Types.ObjectId(questionId), scoreAwarded: score, aiFeedback: feedback } as any);
  }
  await attempt.save();

  await writeAudit({
    examId: attempt.examId,
    action: 'subjective_score_changed',
    actorId,
    attemptId: attempt._id as Types.ObjectId,
    questionId,
    studentId: attempt.userId,
    field: 'scoreAwarded',
    oldValue: previous,
    newValue: score,
  });

  return recomputeExamResults(attempt.examId.toString(), { actorId });
}

/**
 * Manually set (or clear) the marks awarded to ONE student for ONE question.
 * Works for any question type (objective or subjective). A numeric `score`
 * pins a persistent override (+4 / +1 / 0 / -1 / custom) that survives every
 * recompute; passing `null` clears it and reverts the question to automatic
 * grading. Recomputes the whole test so the student's score, rank, percentile,
 * cohort stats (and any reader that derives from them — analytics, the online
 * leaderboard) all update from this single call. A change to a published test
 * auto-republishes, mirroring the other review mutations.
 */
export async function setManualScore(
  attemptId: string,
  questionId: string,
  score: number | null,
  actorId?: string
): Promise<IExamEvaluation> {
  const attempt = await Attempt.findById(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  if (!attempt.examId) throw new Error('Attempt is not an exam attempt');

  let ans = attempt.answers.find((a) => a.questionId.toString() === questionId);
  const previous = ans?.manualScore ?? null;
  if (!ans) {
    // Student never answered this question — create a stub answer so the manual
    // mark has somewhere to live (e.g. awarding credit for an unattempted Q).
    attempt.answers.push({ questionId: new Types.ObjectId(questionId) } as any);
    ans = attempt.answers[attempt.answers.length - 1];
  }
  if (score === null || score === undefined || Number.isNaN(Number(score))) {
    ans!.manualScore = undefined;
    ans!.manualScoreBy = undefined;
    ans!.manualScoreAt = undefined;
  } else {
    ans!.manualScore = Number(score);
    ans!.manualScoreBy = actorId ? new Types.ObjectId(actorId) : undefined;
    ans!.manualScoreAt = new Date();
  }
  attempt.markModified('answers');
  await attempt.save();

  const evaluation = await ensureEvaluation(attempt.examId.toString());
  const wasPublished = evaluation.reviewState === 'published' || evaluation.reviewState === 'republished';

  await writeAudit({
    examId: attempt.examId,
    action: 'manual_score_changed',
    actorId,
    attemptId: attempt._id as Types.ObjectId,
    questionId,
    studentId: attempt.userId,
    field: 'manualScore',
    oldValue: previous,
    newValue: score,
  });

  const updated = await recomputeExamResults(attempt.examId.toString(), { actorId });
  if (wasPublished) {
    updated.reviewState = 'republished';
    updated.publishedAt = new Date();
    if (actorId) updated.publishedBy = new Types.ObjectId(actorId);
    pushVersion(updated, 'recompute', actorId ? new Types.ObjectId(actorId) : undefined, 'Manual question mark changed after publish');
    await updated.save();
  }
  return updated;
}

// ── Publish-state machine ────────────────────────────────────────────────────
const ALLOWED_TRANSITIONS: Record<ReviewState, ReviewState[]> = {
  draft: ['under_review', 'published'],
  under_review: ['draft', 'published'],
  published: ['draft', 'under_review', 'republished'],
  republished: ['draft', 'under_review', 'published'],
};

export async function transitionState(
  examId: string,
  target: ReviewState,
  actorId?: string,
  note?: string
): Promise<IExamEvaluation> {
  const evaluation = await ensureEvaluation(examId);
  const from = evaluation.reviewState;
  if (from === target) return evaluation;
  if (!ALLOWED_TRANSITIONS[from]?.includes(target)) {
    throw new Error(`Invalid transition: ${from} -> ${target}`);
  }

  const publishing = target === 'published' || target === 'republished';
  // Always recompute before publishing so what students see is current.
  await recomputeExamResults(examId, { actorId });

  // Propagate publish/unpublish to every attempt of this exam.
  if (publishing) {
    await Attempt.updateMany(
      { examId: new Types.ObjectId(examId), submittedAt: { $ne: null } },
      { $set: { resultPublished: true, status: 'graded' } }
    );
    evaluation.publishedAt = new Date();
    if (actorId) evaluation.publishedBy = new Types.ObjectId(actorId);
    evaluation.pendingRepublish = false;
  } else {
    await Attempt.updateMany(
      { examId: new Types.ObjectId(examId), submittedAt: { $ne: null } },
      { $set: { resultPublished: false } }
    );
  }

  evaluation.reviewState = target;
  const event: IEvaluationVersion['event'] =
    target === 'published' ? 'published' : target === 'republished' ? 'republished' : 'unpublished';
  pushVersion(evaluation, event, actorId ? new Types.ObjectId(actorId) : undefined, note);
  await evaluation.save();

  await writeAudit({
    examId: new Types.ObjectId(examId),
    action: publishing ? 'attempt_published' : 'attempt_unpublished',
    actorId,
    field: 'reviewState',
    oldValue: from,
    newValue: target,
    note,
  });

  return evaluation;
}

// ── Consolidated test-wise review summary ────────────────────────────────────
export async function getReviewSummary(examId: string) {
  const exam = await Exam.findById(examId);
  if (!exam) throw new Error('Exam not found');
  const evaluation = await ensureEvaluation(examId);
  const qmap = await loadExamQuestionMap(exam);
  const scheme = examScheme(exam);
  const qMarks = evaluation.questionMarks as Map<string, IQuestionMarks> | undefined;
  const orderedQids = exam.sections.flatMap((s) => s.questionIds.map((q) => q.toString()));
  const baseMax = computeBaseMax(orderedQids, qmap, scheme, qMarks);

  const attempts = await Attempt.find({ examId: new Types.ObjectId(examId), submittedAt: { $ne: null } })
    .populate('userId', 'name email classLevel batch firebaseUid')
    .sort({ rankInTest: 1, totalScore: -1 })
    .lean();

  // Question-wise performance, in exam order.
  const questionPerformance = orderedQids.map((qid) => {
    const q = qmap.get(qid);
    const qm = marksForQuestion(qid, scheme, qMarks);
    let answered = 0;
    let correct = 0;
    let scoreSum = 0;
    for (const a of attempts) {
      const ans = (a.answers || []).find((x: any) => x.questionId.toString() === qid);
      if (!ans) continue;
      const hasResponse = ans.chosenOptionId || ans.textAnswer;
      if (hasResponse) answered += 1;
      if (ans.isCorrect) correct += 1;
      if (typeof ans.scoreAwarded === 'number') scoreSum += ans.scoreAwarded;
    }
    return {
      questionId: qid,
      text: q ? (q as any).text : undefined,
      type: q ? (q as any).type : undefined,
      isSubjective: q ? isSubjectiveType((q as any).type) : false,
      hasAnswerKeyOverride: !!evaluation.answerKeyOverrides?.get(qid),
      // Effective per-question marks (override or scheme) + whether overridden.
      marks: qm,
      hasMarksOverride: !!evaluation.questionMarks?.get(qid),
      answered,
      correct,
      incorrect: Math.max(0, answered - correct),
      pctCorrect: answered ? round2((correct / answered) * 100) : 0,
      avgScore: attempts.length ? round2(scoreSum / attempts.length) : 0,
    };
  });

  const totalMarks = evaluation.totalMarksOverride ?? baseMax;

  return {
    exam: {
      _id: exam._id,
      title: exam.title,
      classLevel: exam.classLevel,
      batch: exam.batch,
      totalDurationMins: exam.totalDurationMins,
      questionCount: orderedQids.length,
    },
    evaluation: {
      reviewState: evaluation.reviewState,
      totalMarks,
      baseTotalMarks: baseMax,
      overrideActive: evaluation.totalMarksOverride !== null && evaluation.totalMarksOverride !== undefined,
      overrideMode: evaluation.overrideMode,
      markingScheme: scheme,
      pendingRepublish: evaluation.pendingRepublish,
      publishedAt: evaluation.publishedAt,
      versionsCount: evaluation.versions.length,
    },
    stats: evaluation.stats,
    questionPerformance,
    attempts: attempts.map((a: any) => ({
      _id: a._id,
      student: a.userId,
      submittedAt: a.submittedAt,
      status: a.status,
      resultPublished: a.resultPublished,
      rawTotalScore: a.rawTotalScore,
      totalScore: a.totalScore,
      maxScore: a.maxScore,
      percentage: a.percentage,
      rankInTest: a.rankInTest,
      percentile: a.percentile,
      hasManualOverride: (a.answers || []).some((ans: any) => typeof ans.manualScore === 'number'),
      hasSubjectivePending: (a.answers || []).some(
        (ans: any) => {
          const q = qmap.get(ans.questionId.toString());
          return q && isSubjectiveType((q as any).type) && typeof ans.scoreAwarded !== 'number';
        }
      ),
    })),
  };
}

/**
 * List exams that have submissions, with their review state, for the dashboard.
 * A teacher only sees the tests they created; admins see every test.
 */
export async function listReviewableTests(requesterId?: string, isAdmin = false) {
  const examIds = await Attempt.distinct('examId', { submittedAt: { $ne: null }, examId: { $ne: null } });
  const examMatch: any = { _id: { $in: examIds } };
  if (!isAdmin && requesterId) examMatch.createdBy = new Types.ObjectId(requesterId);
  const exams = await Exam.find(examMatch).select('title classLevel batch createdAt').lean();
  const evaluations = await ExamEvaluation.find({ examId: { $in: examIds } }).lean();
  const evalByExam = new Map(evaluations.map((e: any) => [e.examId.toString(), e]));

  const rows = await Promise.all(
    exams.map(async (exam: any) => {
      const ev = evalByExam.get(exam._id.toString());
      const totalAttempts = ev?.stats?.totalAttempts ?? (await Attempt.countDocuments({ examId: exam._id, submittedAt: { $ne: null } }));
      const pendingReviews = ev?.stats?.pendingReviews ?? totalAttempts;
      return {
        examId: exam._id,
        title: exam.title,
        classLevel: exam.classLevel,
        batch: exam.batch,
        reviewState: ev?.reviewState || 'draft',
        totalMarks: ev?.totalMarksOverride ?? ev?.baseTotalMarks ?? null,
        totalAttempts,
        pendingReviews,
        avgPercentage: ev?.stats?.avgPercentage ?? 0,
        lastRecomputedAt: ev?.stats?.lastRecomputedAt,
        publishedAt: ev?.publishedAt,
      };
    })
  );
  rows.sort((a, b) => b.pendingReviews - a.pendingReviews);
  return rows;
}

export async function getReviewHistory(examId: string) {
  const evaluation = await ensureEvaluation(examId);
  const audit = await ReviewAuditLog.find({ examId: new Types.ObjectId(examId) })
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  return { versions: evaluation.versions, audit };
}

// ── Duplicate / attempt cleanup ──────────────────────────────────────────────
/** Permanently delete one attempt, then recompute the test it belonged to. */
export async function deleteAttempt(attemptId: string, actorId?: string) {
  const attempt = await Attempt.findById(attemptId);
  if (!attempt) throw new Error('Attempt not found');
  const examId = attempt.examId?.toString();
  await Attempt.deleteOne({ _id: attempt._id });
  if (examId) {
    await writeAudit({
      examId: new Types.ObjectId(examId),
      action: 'attempt_deleted',
      actorId,
      attemptId,
      studentId: attempt.userId,
      meta: { totalScore: attempt.totalScore, status: attempt.status },
    });
    await recomputeExamResults(examId, { actorId });
  }
  return { examId, deleted: 1 };
}

const answeredCount = (a: any) =>
  (a.answers || []).filter((x: any) => x.chosenOptionId || (x.textAnswer != null && String(x.textAnswer) !== '')).length;

/**
 * Remove duplicate attempts for an exam. For each student the single most
 * "complete" attempt is kept — ranked by (answers given, then raw score, then
 * latest submission) — and the rest are deleted. Then results are recomputed.
 */
export async function dedupeExamAttempts(examId: string, actorId?: string) {
  const attempts = await Attempt.find({ examId: new Types.ObjectId(examId) });
  const byUser = new Map<string, any[]>();
  for (const a of attempts) {
    const uid = a.userId.toString();
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid)!.push(a);
  }

  const toDelete: any[] = [];
  for (const list of byUser.values()) {
    if (list.length <= 1) continue;
    list.sort((x, y) => {
      const ac = answeredCount(y) - answeredCount(x);
      if (ac !== 0) return ac;
      const sc = (y.rawTotalScore ?? y.totalScore ?? 0) - (x.rawTotalScore ?? x.totalScore ?? 0);
      if (sc !== 0) return sc;
      const ty = y.submittedAt ? new Date(y.submittedAt).getTime() : 0;
      const tx = x.submittedAt ? new Date(x.submittedAt).getTime() : 0;
      return ty - tx;
    });
    toDelete.push(...list.slice(1)); // keep list[0]
  }

  if (toDelete.length) {
    await Attempt.deleteMany({ _id: { $in: toDelete.map((a) => a._id) } });
    await writeAudit({
      examId: new Types.ObjectId(examId),
      action: 'dedupe',
      actorId,
      meta: { removed: toDelete.length, removedIds: toDelete.map((a) => a._id.toString()) },
    });
    await recomputeExamResults(examId, { actorId });
  }
  return { removed: toDelete.length, students: byUser.size };
}

/**
 * Admin one-shot: dedupe every exam, then (re)create the unique
 * (examId, userId) index so future concurrent starts can't create duplicates.
 * The index can only build once existing duplicates are gone, which is why both
 * steps live together.
 */
export async function cleanupAllDuplicates(actorId?: string) {
  const examIds = await Attempt.distinct('examId', { examId: { $ne: null } });
  let removed = 0;
  for (const id of examIds) {
    const r = await dedupeExamAttempts(id.toString(), actorId);
    removed += r.removed;
  }
  let indexEnsured = false;
  let indexError: string | undefined;
  try {
    await Attempt.collection.createIndex(
      { examId: 1, userId: 1 },
      { unique: true, partialFilterExpression: { examId: { $exists: true, $ne: null } }, name: 'examId_1_userId_1_v2' }
    );
    indexEnsured = true;
  } catch (e: any) {
    indexError = e?.message;
  }
  return { examsProcessed: examIds.length, removed, indexEnsured, indexError };
}

// ── Bulk actions ─────────────────────────────────────────────────────────────
export async function bulkPublish(examIds: string[], actorId?: string) {
  const results = [];
  for (const examId of examIds) {
    try {
      await transitionState(examId, 'published', actorId, 'Bulk publish');
      results.push({ examId, ok: true });
    } catch (e: any) {
      results.push({ examId, ok: false, error: e.message });
    }
  }
  return results;
}

/**
 * One-time backfill: recompute every exam that has submissions so legacy
 * attempts gain rawTotalScore / rawMaxScore / percentage / rankInTest and an
 * ExamEvaluation record. Safe to re-run (idempotent).
 */
export async function backfillAllExams(actorId?: string) {
  const examIds = await Attempt.distinct('examId', { submittedAt: { $ne: null }, examId: { $ne: null } });
  const results: { examId: string; ok: boolean; error?: string }[] = [];
  for (const id of examIds) {
    try {
      await recomputeExamResults(id.toString(), { actorId, logAction: 'recompute', note: 'backfill' });
      results.push({ examId: id.toString(), ok: true });
    } catch (e: any) {
      results.push({ examId: id.toString(), ok: false, error: e.message });
    }
  }
  return { total: examIds.length, succeeded: results.filter((r) => r.ok).length, results };
}

export async function bulkRecompute(examIds: string[], actorId?: string) {
  const results = [];
  for (const examId of examIds) {
    try {
      await recomputeExamResults(examId, { actorId, logAction: 'bulk_recompute' });
      results.push({ examId, ok: true });
    } catch (e: any) {
      results.push({ examId, ok: false, error: e.message });
    }
  }
  return results;
}

/**
 * Approve all pending AI-graded subjective answers for an exam by committing
 * the AI rubric score as the awarded score where a teacher hasn't set one.
 */
export async function bulkApproveSubjective(examId: string, actorId?: string) {
  const exam = await Exam.findById(examId);
  if (!exam) throw new Error('Exam not found');
  const evaluation = await ensureEvaluation(examId);
  const scheme = examScheme(exam);
  const qMarks = evaluation.questionMarks as Map<string, IQuestionMarks> | undefined;
  const qmap = await loadExamQuestionMap(exam);
  const attempts = await Attempt.find({ examId: new Types.ObjectId(examId), submittedAt: { $ne: null } });
  let updatedCount = 0;
  for (const a of attempts) {
    let touched = false;
    for (const ans of a.answers) {
      const qid = ans.questionId.toString();
      const q = qmap.get(qid);
      if (q && isSubjectiveType((q as any).type) && typeof ans.scoreAwarded !== 'number') {
        // Commit the AI rubric (0..1) as marks out of this question's correct mark.
        const correctMark = marksForQuestion(qid, scheme, qMarks).correct;
        ans.scoreAwarded = typeof ans.rubricScore === 'number' ? round2(ans.rubricScore * correctMark) : 0;
        touched = true;
        updatedCount += 1;
      }
    }
    if (touched) await a.save();
  }
  await writeAudit({
    examId: new Types.ObjectId(examId),
    action: 'bulk_approve_subjective',
    actorId,
    meta: { updatedCount },
  });
  await recomputeExamResults(examId, { actorId });
  return { updatedCount };
}

// Re-export for callers that previously reached into attemptService.
export { sanitizeQuestion };
