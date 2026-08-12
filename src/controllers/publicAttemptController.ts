import { Request, Response } from 'express';
import mongoose from 'mongoose';
import PublicAttempt from '../models/PublicAttempt';
import PublicTest from '../models/PublicTest';
import User from '../models/User';
import {
  applyOptionOrder,
  buildSnapshot,
  gradeAttempt,
  loadSnapshotQuestions,
} from '../services/publicAssessmentService';
import {
  ATTEMPT_QUESTION_PROJECTION,
  isTestStartable,
  revealQuestionForReview,
  sanitizeQuestionForAttempt,
} from '../utils/publicAssessment';
import { findQuestionsByIds } from '../utils/questionSource';

/**
 * Public attempt lifecycle: start → answer → submit → result.
 *
 * ── Guests cannot attempt ────────────────────────────────────────────────────
 * Browsing is open, attempting is not. An attempt needs somewhere to persist
 * answers and a server-owned clock, neither of which exists without an account.
 * Every handler here resolves a PUBLIC_LEARNER first and 401/403s otherwise —
 * an institute student's token is refused too, since their attempts belong in
 * the institute stack.
 *
 * ── The clock is the server's ────────────────────────────────────────────────
 * `expiresAt` is written once, at start, from the test's duration. Nothing the
 * client sends can move it. A resumed attempt gets the real remaining time, and
 * a submit arriving after the deadline is recorded as auto-submitted rather
 * than rejected — the learner's work is never thrown away.
 *
 * ── Answers are never trusted ────────────────────────────────────────────────
 * The client sends choices only. `isCorrect` and `scoreAwarded` are stripped on
 * the way in and written by the grader on the way out.
 */

/** Grace for clock skew and in-flight requests when accepting a late submit. */
const SUBMIT_GRACE_SEC = 30;

async function requireLearner(req: Request, res: Response): Promise<string | null> {
  const current = (req as any).user as { id: string } | undefined;
  if (!current) {
    res.status(401).json({
      message: 'Please sign in to take this test.',
      code: 'AUTH_REQUIRED',
    });
    return null;
  }
  const user = await User.findById(current.id).select('accountType').lean();
  if (!user) {
    res.status(404).json({ message: 'Account not found' });
    return null;
  }
  if (user.accountType !== 'PUBLIC_LEARNER') {
    res.status(403).json({ message: 'Not a public learner account' });
    return null;
  }
  return current.id;
}

const oid = (v: string) => new mongoose.Types.ObjectId(v);

/** Seconds left on the server's clock, floored at zero. */
const remainingSec = (attempt: any) =>
  Math.max(0, Math.floor((new Date(attempt.expiresAt).getTime() - Date.now()) / 1000));

// ─── Start / resume ──────────────────────────────────────────────────────────

/**
 * POST /api/learner/attempts   { testId }
 *
 * Idempotent by design: if a live attempt already exists it is RESUMED rather
 * than replaced. Starting fresh on every call would let a learner reroll a
 * shuffled paper or reset their own timer.
 */
export const startAttempt = async (req: Request, res: Response) => {
  try {
    const learnerId = await requireLearner(req, res);
    if (!learnerId) return;

    const testId = String(req.body?.testId || '');
    if (!mongoose.Types.ObjectId.isValid(testId)) {
      return res.status(400).json({ message: 'A valid testId is required.' });
    }

    // The published floor is part of the lookup, so an unpublished test is a
    // 404 here even to someone holding its id.
    const test = await PublicTest.findOne({
      _id: testId,
      status: 'published',
    }).lean();
    if (!test) return res.status(404).json({ message: 'Test not found' });

    const { startable, reason } = isTestStartable(test as any);
    if (!startable) {
      return res.status(409).json({
        message:
          reason === 'not-open-yet' ? 'This test has not opened yet.' : 'This test is closed.',
        code: reason,
      });
    }

    const existing = await PublicAttempt.findOne({
      learnerId: oid(learnerId),
      testId: oid(testId),
      status: 'in-progress',
    });

    if (existing) {
      return res.json(await serveAttempt(existing, test as any, { resumed: true }));
    }

    const questionIds = (test.sections || []).flatMap((s: any) => s.questionIds || []);
    if (questionIds.length === 0) {
      return res.status(409).json({ message: 'This test has no questions yet.' });
    }

    // Same collection the institute exam flow reads — see utils/questionSource.
    const questions = await findQuestionsByIds(questionIds, test.questionBank);
    const snapshot = buildSnapshot(test as any, questions as any);

    if (snapshot.questionOrder.length === 0) {
      return res.status(409).json({ message: 'This test has no available questions.' });
    }

    const attempt = await PublicAttempt.create({
      learnerId: oid(learnerId),
      testId: oid(testId),
      status: 'in-progress',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + (test.durationMins ?? 30) * 60_000),
      snapshot,
      answers: [],
    });

    return res.status(201).json(await serveAttempt(attempt, test as any, { resumed: false }));
  } catch (error) {
    console.error('Error starting attempt:', error);
    return res.status(500).json({ message: 'Unable to start this test right now.' });
  }
};

/** GET /api/learner/attempts/:id — resume a live attempt. */
export const getAttempt = async (req: Request, res: Response) => {
  try {
    const learnerId = await requireLearner(req, res);
    if (!learnerId) return;

    const attempt = await findOwnAttempt(req, learnerId);
    if (!attempt) return res.status(404).json({ message: 'Attempt not found' });

    const test = await PublicTest.findById(attempt.testId).lean();
    if (!test) return res.status(404).json({ message: 'Test not found' });

    if (attempt.status !== 'in-progress') {
      return res.status(409).json({
        message: 'This attempt has already been submitted.',
        code: 'ALREADY_SUBMITTED',
        attemptId: String(attempt._id),
      });
    }

    return res.json(await serveAttempt(attempt, test as any, { resumed: true }));
  } catch (error) {
    console.error('Error resuming attempt:', error);
    return res.status(500).json({ message: 'Unable to resume this attempt right now.' });
  }
};

// ─── Saving answers ──────────────────────────────────────────────────────────

/**
 * PATCH /api/learner/attempts/:id/answers   { answers: [...] }
 *
 * Accepts a batch so an offline client can flush a queue in one request. Each
 * incoming answer REPLACES the stored one for that question — answering is
 * idempotent, so a retried flush cannot corrupt state.
 *
 * `isCorrect` / `scoreAwarded` are stripped: only the grader writes those.
 */
export const saveAnswers = async (req: Request, res: Response) => {
  try {
    const learnerId = await requireLearner(req, res);
    if (!learnerId) return;

    const attempt = await findOwnAttempt(req, learnerId);
    if (!attempt) return res.status(404).json({ message: 'Attempt not found' });

    if (attempt.status !== 'in-progress') {
      return res.status(409).json({ message: 'This attempt is already submitted.' });
    }

    const incoming = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (incoming.length === 0) {
      return res.json({ saved: 0, remainingSec: remainingSec(attempt) });
    }

    const saved = applyIncomingAnswers(attempt, incoming);
    await attempt.save();

    return res.json({ saved, remainingSec: remainingSec(attempt) });
  } catch (error) {
    console.error('Error saving answers:', error);
    return res.status(500).json({ message: 'Unable to save your answers right now.' });
  }
};

// ─── Submit ──────────────────────────────────────────────────────────────────

/**
 * POST /api/learner/attempts/:id/submit
 *
 * Grades server-side against the live question bank and writes the result once.
 * A late submit is accepted and recorded as `auto-submitted` — refusing it
 * would discard work the learner actually did.
 */
export const submitAttempt = async (req: Request, res: Response) => {
  try {
    const learnerId = await requireLearner(req, res);
    if (!learnerId) return;

    const attempt = await findOwnAttempt(req, learnerId);
    if (!attempt) return res.status(404).json({ message: 'Attempt not found' });

    if (attempt.status !== 'in-progress') {
      // Idempotent: a duplicate submit returns the existing result rather than
      // regrading or erroring.
      return res.json(await buildResult(attempt));
    }

    const test = await PublicTest.findById(attempt.testId).lean();
    if (!test) return res.status(404).json({ message: 'Test not found' });

    // Any last answers can ride along with the submit.
    if (Array.isArray(req.body?.answers) && req.body.answers.length > 0) {
      applyIncomingAnswers(attempt, req.body.answers);
    }

    // test.questionBank names the per-class collection these ids live in.
    // Omitting it would grade against an empty question set — every answer
    // silently unscored.
    const questions = await loadSnapshotQuestions(attempt, undefined, test.questionBank);
    const graded = gradeAttempt(attempt, questions as any, test.markingScheme as any);

    const overdue = Date.now() > new Date(attempt.expiresAt).getTime() + SUBMIT_GRACE_SEC * 1000;

    attempt.answers = graded.answers as any;
    attempt.status = overdue ? 'auto-submitted' : 'submitted';
    attempt.submittedAt = new Date();
    attempt.durationSec = Math.max(
      0,
      Math.floor((Date.now() - new Date(attempt.startedAt).getTime()) / 1000),
    );
    attempt.totalScore = graded.totalScore;
    attempt.maxScore = graded.maxScore;
    attempt.percentage = graded.percentage;
    attempt.correctCount = graded.correctCount;
    attempt.incorrectCount = graded.incorrectCount;
    attempt.unattemptedCount = graded.unattemptedCount;
    attempt.bySubject = graded.bySubject as any;
    attempt.byDifficulty = graded.byDifficulty as any;

    await attempt.save();

    return res.json(await buildResult(attempt));
  } catch (error) {
    console.error('Error submitting attempt:', error);
    return res.status(500).json({ message: 'Unable to submit this attempt right now.' });
  }
};

// ─── Result & history ────────────────────────────────────────────────────────

/**
 * GET /api/learner/attempts/:id/result
 *
 * The scorecard plus the full question-by-question review. This is the ONLY
 * place the answer key is revealed, and only for a submitted attempt the caller
 * owns.
 */
export const getAttemptResult = async (req: Request, res: Response) => {
  try {
    const learnerId = await requireLearner(req, res);
    if (!learnerId) return;

    const attempt = await findOwnAttempt(req, learnerId);
    if (!attempt) return res.status(404).json({ message: 'Attempt not found' });

    if (attempt.status === 'in-progress') {
      return res.status(409).json({
        message: 'This attempt has not been submitted yet.',
        code: 'NOT_SUBMITTED',
      });
    }

    const reviewTest = await PublicTest.findById(attempt.testId).select('questionBank').lean();
    const [result, questions] = await Promise.all([
      buildResult(attempt),
      loadSnapshotQuestions(attempt, undefined, reviewTest?.questionBank),
    ]);

    const answerByQid = new Map(attempt.answers.map((a) => [String(a.questionId), a]));

    return res.json({
      ...result,
      // Key revealed here, and only here — the attempt is over.
      review: (questions as any[]).map((q) => {
        const a = answerByQid.get(String(q._id));
        return {
          question: revealQuestionForReview(q),
          yourAnswer: a
            ? {
                chosenOptionId: a.chosenOptionId ? String(a.chosenOptionId) : undefined,
                textAnswer: a.textAnswer,
                isCorrect: a.isCorrect,
                scoreAwarded: a.scoreAwarded,
                timeSpentSec: a.timeSpentSec,
              }
            : null,
        };
      }),
    });
  } catch (error) {
    console.error('Error loading result:', error);
    return res.status(500).json({ message: 'Unable to load this result right now.' });
  }
};

/** GET /api/learner/attempts — attempt history, newest first. */
export const listAttempts = async (req: Request, res: Response) => {
  try {
    const learnerId = await requireLearner(req, res);
    if (!learnerId) return;

    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const skip = Math.max(Number(req.query.skip) || 0, 0);

    const query: any = { learnerId: oid(learnerId) };
    if (req.query.status === 'completed') query.status = { $ne: 'in-progress' };
    if (req.query.status === 'in-progress') query.status = 'in-progress';

    const [rows, total] = await Promise.all([
      PublicAttempt.find(query)
        .select(
          'testId status startedAt submittedAt totalScore maxScore percentage correctCount incorrectCount unattemptedCount durationSec',
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PublicAttempt.countDocuments(query),
    ]);

    // Titles resolved in one query for the page, not one per row.
    const tests = await PublicTest.find({
      _id: { $in: rows.map((r) => r.testId) },
    })
      .select('title kind subject exam difficulty durationMins')
      .lean();
    const testById = new Map(tests.map((t: any) => [String(t._id), t]));

    return res.json({
      items: rows.map((r: any) => ({
        ...r,
        test: testById.get(String(r.testId)) ?? null,
      })),
      total,
      skip,
      limit,
      hasMore: skip + rows.length < total,
    });
  } catch (error) {
    console.error('Error listing attempts:', error);
    return res.status(500).json({ message: 'Unable to load your attempts right now.' });
  }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function findOwnAttempt(req: Request, learnerId: string) {
  const id = String(req.params.id || '');
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  // Ownership is part of the LOOKUP: another learner's attempt is a 404, never
  // a document that was fetched and then permission-checked.
  return PublicAttempt.findOne({ _id: id, learnerId: oid(learnerId) });
}

/**
 * Merge a batch of client answers into an attempt. Returns how many were taken.
 *
 * Each incoming answer REPLACES the stored one for its question, so a retried
 * flush is harmless. A row for a question outside this attempt's snapshot is
 * skipped rather than throwing — one bad row must not cost the learner the
 * whole batch. `isCorrect` / `scoreAwarded` are deliberately not carried over
 * from input: only the grader writes those.
 */
function applyIncomingAnswers(attempt: any, incoming: any[]): number {
  const allowed = new Set((attempt.snapshot?.questionOrder ?? []).map(String));
  const byQid = new Map(attempt.answers.map((a: any) => [String(a.questionId), a]));
  let saved = 0;

  for (const raw of incoming) {
    const qid = String(raw?.questionId || '');
    if (!mongoose.Types.ObjectId.isValid(qid) || !allowed.has(qid)) continue;
    byQid.set(qid, {
      questionId: oid(qid),
      chosenOptionId:
        raw.chosenOptionId && mongoose.Types.ObjectId.isValid(String(raw.chosenOptionId))
          ? oid(String(raw.chosenOptionId))
          : undefined,
      textAnswer: typeof raw.textAnswer === 'string' ? raw.textAnswer.slice(0, 5000) : undefined,
      markedForReview: !!raw.markedForReview,
      timeSpentSec: Math.max(0, Number(raw.timeSpentSec) || 0),
    });
    saved += 1;
  }

  attempt.answers = Array.from(byQid.values());
  return saved;
}

/** The paper as a learner may see it: sanitised, ordered, with the clock. */
async function serveAttempt(attempt: any, test: any, meta: { resumed: boolean }) {
  const questions = await loadSnapshotQuestions(
    attempt,
    ATTEMPT_QUESTION_PROJECTION,
    test.questionBank,
  );

  return {
    attemptId: String(attempt._id),
    resumed: meta.resumed,
    test: {
      _id: String(test._id),
      title: test.title,
      kind: test.kind,
      durationMins: test.durationMins,
      markingScheme: test.markingScheme,
      instructions: test.instructions,
      totalMarks: test.totalMarks,
    },
    startedAt: attempt.startedAt,
    expiresAt: attempt.expiresAt,
    remainingSec: remainingSec(attempt),
    questions: (questions as any[]).map((q) =>
      applyOptionOrder(sanitizeQuestionForAttempt(q), attempt.snapshot?.optionOrderByQuestion),
    ),
    answers: (attempt.answers || []).map((a: any) => ({
      questionId: String(a.questionId),
      chosenOptionId: a.chosenOptionId ? String(a.chosenOptionId) : undefined,
      textAnswer: a.textAnswer,
      markedForReview: a.markedForReview,
    })),
  };
}

async function buildResult(attempt: any) {
  const test = await PublicTest.findById(attempt.testId)
    .select('title kind subject exam difficulty durationMins totalMarks markingScheme')
    .lean();

  return {
    attemptId: String(attempt._id),
    status: attempt.status,
    test,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    durationSec: attempt.durationSec,
    totalScore: attempt.totalScore,
    maxScore: attempt.maxScore,
    percentage: attempt.percentage,
    correctCount: attempt.correctCount,
    incorrectCount: attempt.incorrectCount,
    unattemptedCount: attempt.unattemptedCount,
    /** Attempted-and-correct over attempted — distinct from percentage, which
     *  is score over maximum and is affected by negative marking. */
    accuracy:
      (attempt.correctCount ?? 0) + (attempt.incorrectCount ?? 0) > 0
        ? Math.round(
            ((attempt.correctCount ?? 0) /
              ((attempt.correctCount ?? 0) + (attempt.incorrectCount ?? 0))) *
              10000,
          ) / 100
        : 0,
    bySubject: attempt.bySubject ?? [],
    byDifficulty: attempt.byDifficulty ?? [],
  };
}
