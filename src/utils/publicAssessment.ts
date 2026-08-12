import type { Request } from 'express';
import type { IQuestion } from '../models/Question';

/**
 * Public assessment safety rules.
 *
 * Two separate concerns live here, both of which the Phase A audit identified
 * as the places this feature can go wrong:
 *
 *   1. ANSWER-KEY LEAKAGE. `Question` stores its key inline —
 *      `options[].isCorrect`, `correctAnswerText`, `integerAnswer`,
 *      `assertionIsTrue`, `reasonIsTrue`, `reasonExplainsAssertion` and
 *      `explanation`. The model's own comment says these "must never leak via
 *      APIs to students". Every question served DURING an attempt must go
 *      through `sanitizeQuestionForAttempt()`.
 *
 *   2. INSTITUTE CROSS-CONTAMINATION. Public assessments live in their own
 *      collections (PublicTest / PublicTestSeries / PublicAttempt) precisely so
 *      no institute query can reach them, but the reverse guard still matters:
 *      only a PUBLIC_LEARNER may create or read a PublicAttempt.
 */

// ─── 1. Answer-key sanitisation ──────────────────────────────────────────────

/** Fields that reveal the answer. Never sent while an attempt is live. */
export const ANSWER_KEY_FIELDS = [
  'correctAnswerText',
  'integerAnswer',
  'assertionIsTrue',
  'reasonIsTrue',
  'reasonExplainsAssertion',
  'explanation',
] as const;

/**
 * Mongoose `.select()` projection for serving questions during an attempt.
 *
 * Note this cannot strip `options[].isCorrect` — a projection cannot exclude a
 * subdocument field while keeping the array — so the option rewrite in
 * `sanitizeQuestionForAttempt()` is mandatory, not optional. Use both.
 */
export const ATTEMPT_QUESTION_PROJECTION =
  '-correctAnswerText -integerAnswer -assertionIsTrue -reasonIsTrue -reasonExplainsAssertion -explanation -createdBy -__v';

export interface SafeQuestion {
  _id: string;
  text: string;
  type: string;
  options?: { _id: string; text: string }[];
  assertion?: string;
  reason?: string;
  diagramUrl?: string;
  diagramAlt?: string;
  subject?: string;
  topic?: string;
  difficulty?: string;
  marks?: number;
}

/**
 * Strip a question down to what a learner may see while answering.
 *
 * Rebuilds `options` from scratch rather than deleting `isCorrect` in place: a
 * `delete` on a Mongoose subdocument can leave the field present after
 * serialisation, and an in-place mutation risks writing the stripped document
 * back if the caller forgot `.lean()`. Constructing a fresh plain object makes
 * leakage structurally impossible.
 */
export function sanitizeQuestionForAttempt(q: IQuestion | any): SafeQuestion {
  return {
    _id: String(q._id),
    text: q.text,
    type: q.type,
    options: Array.isArray(q.options)
      ? q.options.map((o: any) => ({ _id: String(o._id), text: o.text }))
      : undefined,
    assertion: q.assertion,
    reason: q.reason,
    diagramUrl: q.diagramUrl,
    diagramAlt: q.diagramAlt,
    // Class-specific collections store `subject` flat; the shared bank nests it
    // under `tags`. The institute player checks both (see AttemptPlayer's
    // subjectOf), and the public palette groups by this — so a paper promoted
    // from class_11 would land entirely under "General" if only tags were read.
    subject: q.tags?.subject || q.subject,
    topic: q.tags?.topic || q.topic,
    difficulty: q.tags?.difficulty || q.difficulty,
    marks: q.metadata?.marks,
  };
}

/**
 * The fuller shape used AFTER submission, on the review/analysis screen, where
 * the correct answer and explanation are the whole point.
 *
 * Deliberately a separate function so that revealing the key is always an
 * explicit choice at the call site rather than a flag that can default wrong.
 */
export function revealQuestionForReview(q: IQuestion | any) {
  return {
    ...sanitizeQuestionForAttempt(q),
    options: Array.isArray(q.options)
      ? q.options.map((o: any) => ({
          _id: String(o._id),
          text: o.text,
          isCorrect: !!o.isCorrect,
        }))
      : undefined,
    correctAnswerText: q.correctAnswerText,
    integerAnswer: q.integerAnswer,
    explanation: q.explanation,
  };
}

/**
 * True when an object still carries any answer-key field. Used by the
 * verification script, and cheap enough to assert in development.
 */
export function leaksAnswerKey(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false;
  for (const f of ANSWER_KEY_FIELDS) {
    if (obj[f] !== undefined) return true;
  }
  if (Array.isArray(obj.options)) {
    return obj.options.some((o: any) => o && o.isCorrect !== undefined);
  }
  return false;
}

// ─── 2. Public visibility ────────────────────────────────────────────────────

/** Staff may see drafts and archived tests; nobody else may. */
export const isAssessmentStaff = (req: Request): boolean => {
  const role = (req as any).user?.role;
  return role === 'admin' || role === 'teacher' || role === 'developer';
};

/**
 * Force the published-only floor onto a PublicTest / PublicTestSeries query.
 * Mutates and returns, matching the shape used elsewhere in this codebase.
 *
 * A client cannot widen this: `status` is overwritten after any caller-supplied
 * value, so `?status=draft` from a learner is ignored rather than honoured.
 */
export const applyPublishedFloor = <T extends Record<string, any>>(query: T, req: Request): T => {
  if (isAssessmentStaff(req)) return query;
  (query as any).status = 'published';
  return query;
};

/**
 * Whether a published test may be STARTED right now.
 *
 * Separate from discoverability on purpose: a scheduled paper should be
 * visible (so a learner can plan for it) before it is startable. Mirrors the
 * institute scheduler's distinction without sharing its code.
 */
export function isTestStartable(
  test: { status?: string; schedule?: { startAt?: Date; endAt?: Date } },
  now: Date = new Date(),
): {
  startable: boolean;
  reason?: 'not-published' | 'not-open-yet' | 'closed';
} {
  if (test.status !== 'published') return { startable: false, reason: 'not-published' };
  const start = test.schedule?.startAt;
  const end = test.schedule?.endAt;
  if (start && now < new Date(start)) return { startable: false, reason: 'not-open-yet' };
  if (end && now > new Date(end)) return { startable: false, reason: 'closed' };
  return { startable: true };
}

/**
 * Deep-clone a test's sections for duplication.
 *
 * Section `_id`s are dropped so Mongo mints new ones — otherwise the copy would
 * share subdocument identity with the original and an edit to one could be
 * mistaken for the other. `questionIds` are intentionally shared: questions are
 * a common bank, and duplicating them would fragment it.
 */
export function cloneSections(sections: any[]): any[] {
  return (sections || []).map((s) => ({
    title: s.title,
    questionIds: [...(s.questionIds || [])],
    durationMins: s.durationMins,
    shuffleQuestions: s.shuffleQuestions,
    shuffleOptions: s.shuffleOptions,
  }));
}

// ─── Performance folding ─────────────────────────────────────────────────────

/**
 * Merge the per-attempt breakdowns the grader already denormalised onto each
 * PublicAttempt into one view across every attempt.
 *
 * ── Why merged rather than per-attempt ───────────────────────────────────────
 * "You get 45% of Physics questions right across nine papers" is actionable.
 * "You got 2 of 5 Physics questions on the paper you sat on Tuesday" is noise —
 * it moves twenty percentage points on a single lucky guess.
 *
 * Pure so it can be verified without a database: this is a fold over documents,
 * not a re-grade. No question is loaded and no marking scheme is re-applied.
 */
export interface BreakdownRow {
  key: string;
  correct: number;
  total: number;
  accuracy: number;
}

export function foldBreakdowns(
  rows: { key: string; correct?: number; total?: number }[],
): BreakdownRow[] {
  const agg = new Map<string, { correct: number; total: number }>();

  for (const row of rows) {
    if (!row?.key) continue;
    const entry = agg.get(row.key) ?? { correct: 0, total: 0 };
    entry.correct += row.correct ?? 0;
    entry.total += row.total ?? 0;
    agg.set(row.key, entry);
  }

  return Array.from(agg.entries())
    .map(([key, v]) => ({
      key,
      correct: v.correct,
      total: v.total,
      // A subject with zero graded questions is 0%, not NaN — it should not
      // reach here, but a division by zero on a scorecard is unforgivable.
      accuracy: v.total > 0 ? Math.round((v.correct / v.total) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

/** Below this many graded questions, a per-subject figure is noise, not signal. */
export const MIN_QUESTIONS_FOR_SUBJECT_VERDICT = 5;

/**
 * Name a strongest and weakest subject, or refuse to.
 *
 * Three guards, each ruling out a conclusion the data cannot support:
 *   • a subject needs enough questions to be worth ranking at all
 *   • ranking needs at least two eligible subjects to compare
 *   • "weakest" is only named when it is genuinely weak; when a learner is
 *     strong across the board, calling their 88% subject a weakness is false
 *
 * The app has a sibling rule in lib/learner/assessmentDisplay.ts with a LOWER
 * threshold (3). That is deliberate, not drift: the app's applies to a single
 * result screen, where three questions in a subject is thin but is all the
 * paper offers. This one applies across every attempt a learner has ever made,
 * where five is the least that should move a verdict.
 */
export function rankSubjectPerformance(rows: BreakdownRow[]): {
  strongest: string | null;
  weakest: string | null;
} {
  const eligible = rows.filter((r) => r.total >= MIN_QUESTIONS_FOR_SUBJECT_VERDICT);
  if (eligible.length < 2) return { strongest: null, weakest: null };

  const ranked = [...eligible].sort((a, b) => b.accuracy - a.accuracy);
  const worst = ranked[ranked.length - 1];

  return {
    strongest: ranked[0].key,
    weakest: worst.accuracy < 75 ? worst.key : null,
  };
}

// ─── Auto-gradability ────────────────────────────────────────────────────────

/**
 * Can this question actually be marked without a human?
 *
 * ── Why this asks about the ANSWER KEY, not the type label ───────────────────
 * The obvious test is `!isSubjectiveType(q.type)`, and it is wrong in both
 * directions:
 *
 *   • A question typed 'short' or 'long' that nonetheless carries options with
 *     `isCorrect` marked IS gradable. Imported and AI-generated questions
 *     frequently land with a loose type but a perfectly good key, and rejecting
 *     them tells an author their marked-up exam "has no auto-gradable
 *     questions" — which they can see is false.
 *
 *   • A question typed 'mcq' with no correct option marked is NOT gradable.
 *     Accepting it produces a paper where that question can never be earned,
 *     silently, for every learner who sits it.
 *
 * So the predicate looks for a usable key of any kind. That is the property the
 * grader actually depends on, and checking the real property instead of a
 * proxy for it is what stops the two from disagreeing.
 *
 * REQUIRES the key fields to be selected. A projection that fetches only `type`
 * makes every question look ungradable — see promoteExamToPublicTest.
 */
export function isAutoGradable(q: any): boolean {
  if (!q) return false;

  // Any question offering options with a marked answer is gradable, whatever
  // its type string says.
  if (Array.isArray(q.options) && q.options.some((o: any) => o?.isCorrect)) return true;

  const answerText = (q.correctAnswerText ?? '').toString().trim();
  if (answerText !== '') return true;

  // Integer questions may store the answer numerically instead.
  if (q.integerAnswer !== undefined && q.integerAnswer !== null) return true;

  // Assertion-reason is gradable from its truth flags alone: the correct
  // A/B/C/D follows from them, so a key is present even with no options.
  if (
    q.assertionIsTrue !== undefined ||
    q.reasonIsTrue !== undefined ||
    q.reasonExplainsAssertion !== undefined
  ) {
    return true;
  }

  return false;
}

/** Every field `isAutoGradable` reads. Select these or it always returns false. */
export const GRADABILITY_FIELDS =
  'type options correctAnswerText integerAnswer assertionIsTrue reasonIsTrue reasonExplainsAssertion';
