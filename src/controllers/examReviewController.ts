import { Request, Response } from 'express';
import Exam from '../models/Exam';
import Attempt from '../models/Attempt';
import {
  getReviewSummary,
  listReviewableTests,
  getReviewHistory,
  setTotalMarks,
  setAnswerKey,
  setMarkingScheme,
  setQuestionMarks,
  adjustSubjectiveScore,
  transitionState,
  recomputeExamResults,
  bulkPublish,
  bulkRecompute,
  bulkApproveSubjective,
  backfillAllExams,
  deleteAttempt,
  dedupeExamAttempts,
  cleanupAllDuplicates,
} from '../services/examEvaluationService';

const actorOf = (req: Request) => (req as any).user?.id as string | undefined;
const isAdmin = (req: Request) => (req as any).user?.role === 'admin';

// A teacher may only act on tests they created; admins may act on any test.
async function ensureExamOwnership(req: Request, examId: string): Promise<void> {
  if (isAdmin(req)) return;
  const exam = await Exam.findById(examId).select('createdBy');
  if (!exam) {
    const e: any = new Error('Test not found');
    e.status = 404;
    throw e;
  }
  if (exam.createdBy?.toString() !== actorOf(req)) {
    const e: any = new Error('You do not have access to this test');
    e.status = 403;
    throw e;
  }
}

async function filterOwnedExamIds(req: Request, examIds: string[]): Promise<string[]> {
  if (isAdmin(req)) return examIds;
  const owned = await Exam.find({ _id: { $in: examIds }, createdBy: actorOf(req) }).select('_id').lean();
  const set = new Set(owned.map((e: any) => e._id.toString()));
  return examIds.filter((id) => set.has(String(id)));
}

const fail = (res: Response, err: any, fallback: string) =>
  res.status(err?.status || 400).json({ message: err?.message || fallback });

// GET /api/exam-review/tests — dashboard list (scoped to the requester)
export const listReviewTestsCtrl = async (req: Request, res: Response) => {
  try {
    res.json(await listReviewableTests(actorOf(req), isAdmin(req)));
  } catch (err: any) {
    fail(res, err, 'Failed to list reviewable tests');
  }
};

// GET /api/exam-review/:examId/summary
export const reviewSummaryCtrl = async (req: Request, res: Response) => {
  try {
    await ensureExamOwnership(req, req.params.examId);
    res.json(await getReviewSummary(req.params.examId));
  } catch (err: any) {
    fail(res, err, 'Failed to load review summary');
  }
};

// GET /api/exam-review/:examId/history
export const reviewHistoryCtrl = async (req: Request, res: Response) => {
  try {
    await ensureExamOwnership(req, req.params.examId);
    res.json(await getReviewHistory(req.params.examId));
  } catch (err: any) {
    fail(res, err, 'Failed to load review history');
  }
};

// PATCH /api/exam-review/:examId/total-marks  { totalMarks, mode? }
export const setTotalMarksCtrl = async (req: Request, res: Response) => {
  try {
    await ensureExamOwnership(req, req.params.examId);
    const raw = req.body.totalMarks;
    const total = raw === null || raw === '' ? null : Number(raw);
    if (total !== null && (Number.isNaN(total) || total <= 0)) {
      return res.status(400).json({ message: 'totalMarks must be a positive number or null to clear' });
    }
    const mode = req.body.mode === 'denominator' ? 'denominator' : 'scale';
    res.json(await setTotalMarks(req.params.examId, total, mode, actorOf(req)));
  } catch (err: any) {
    fail(res, err, 'Failed to update total marks');
  }
};

// PATCH /api/exam-review/:examId/marking-scheme  { correct, incorrect, unattempted }
export const setMarkingSchemeCtrl = async (req: Request, res: Response) => {
  try {
    await ensureExamOwnership(req, req.params.examId);
    const { correct, incorrect, unattempted } = req.body;
    if ([correct, incorrect, unattempted].some((v) => v === undefined || v === null || Number.isNaN(Number(v)))) {
      return res.status(400).json({ message: 'correct, incorrect and unattempted must all be numbers' });
    }
    res.json(
      await setMarkingScheme(
        req.params.examId,
        { correct: Number(correct), incorrect: Number(incorrect), unattempted: Number(unattempted) },
        actorOf(req)
      )
    );
  } catch (err: any) {
    fail(res, err, 'Failed to update marking scheme');
  }
};

// PATCH /api/exam-review/:examId/question-marks  { questionId, correct?, incorrect?, unattempted?, clear? }
export const setQuestionMarksCtrl = async (req: Request, res: Response) => {
  try {
    await ensureExamOwnership(req, req.params.examId);
    const { questionId, correct, incorrect, unattempted, clear } = req.body;
    if (!questionId) return res.status(400).json({ message: 'questionId is required' });
    const marks = clear ? null : { correct, incorrect, unattempted };
    res.json(await setQuestionMarks(req.params.examId, questionId, marks, actorOf(req)));
  } catch (err: any) {
    fail(res, err, 'Failed to update question marks');
  }
};

// PATCH /api/exam-review/:examId/answer-key  { questionId, optionIds?, correctText?, clear? }
export const setAnswerKeyCtrl = async (req: Request, res: Response) => {
  try {
    await ensureExamOwnership(req, req.params.examId);
    const { questionId, optionIds, correctText, clear } = req.body;
    if (!questionId) return res.status(400).json({ message: 'questionId is required' });
    const key = clear
      ? null
      : {
          optionIds: Array.isArray(optionIds) ? optionIds.map(String) : undefined,
          correctText: typeof correctText === 'string' ? correctText : undefined,
        };
    res.json(await setAnswerKey(req.params.examId, questionId, key, actorOf(req)));
  } catch (err: any) {
    fail(res, err, 'Failed to update answer key');
  }
};

// PATCH /api/exam-review/attempts/:attemptId/score  { questionId, score, feedback? }
export const adjustSubjectiveCtrl = async (req: Request, res: Response) => {
  try {
    const attempt = await Attempt.findById(req.params.attemptId).select('examId');
    if (!attempt || !attempt.examId) {
      return res.status(404).json({ message: 'Exam attempt not found' });
    }
    await ensureExamOwnership(req, attempt.examId.toString());
    const { questionId, score, feedback } = req.body;
    if (!questionId) return res.status(400).json({ message: 'questionId is required' });
    if (typeof score !== 'number' && Number.isNaN(Number(score))) {
      return res.status(400).json({ message: 'score must be a number' });
    }
    res.json(await adjustSubjectiveScore(req.params.attemptId, questionId, Number(score), feedback, actorOf(req)));
  } catch (err: any) {
    fail(res, err, 'Failed to adjust score');
  }
};

// POST /api/exam-review/:examId/state  { state, note? }
export const transitionStateCtrl = async (req: Request, res: Response) => {
  try {
    await ensureExamOwnership(req, req.params.examId);
    const { state, note } = req.body;
    const allowed = ['draft', 'under_review', 'published', 'republished'];
    if (!allowed.includes(state)) {
      return res.status(400).json({ message: `state must be one of ${allowed.join(', ')}` });
    }
    res.json(await transitionState(req.params.examId, state, actorOf(req), note));
  } catch (err: any) {
    fail(res, err, 'Failed to change review state');
  }
};

// POST /api/exam-review/:examId/recompute
export const recomputeCtrl = async (req: Request, res: Response) => {
  try {
    await ensureExamOwnership(req, req.params.examId);
    res.json(await recomputeExamResults(req.params.examId, { actorId: actorOf(req), logAction: 'recompute', note: req.body?.note }));
  } catch (err: any) {
    fail(res, err, 'Failed to recompute results');
  }
};

// POST /api/exam-review/:examId/approve-subjective
export const approveSubjectiveCtrl = async (req: Request, res: Response) => {
  try {
    await ensureExamOwnership(req, req.params.examId);
    res.json(await bulkApproveSubjective(req.params.examId, actorOf(req)));
  } catch (err: any) {
    fail(res, err, 'Failed to approve subjective answers');
  }
};

// POST /api/exam-review/bulk/publish   { examIds: [] }
export const bulkPublishCtrl = async (req: Request, res: Response) => {
  try {
    const examIds = await filterOwnedExamIds(req, Array.isArray(req.body.examIds) ? req.body.examIds : []);
    res.json(await bulkPublish(examIds, actorOf(req)));
  } catch (err: any) {
    fail(res, err, 'Bulk publish failed');
  }
};

// POST /api/exam-review/bulk/recompute   { examIds: [] }
export const bulkRecomputeCtrl = async (req: Request, res: Response) => {
  try {
    const examIds = await filterOwnedExamIds(req, Array.isArray(req.body.examIds) ? req.body.examIds : []);
    res.json(await bulkRecompute(examIds, actorOf(req)));
  } catch (err: any) {
    fail(res, err, 'Bulk recompute failed');
  }
};

// DELETE /api/exam-review/attempts/:attemptId — remove one (e.g. duplicate) attempt
export const deleteAttemptCtrl = async (req: Request, res: Response) => {
  try {
    const attempt = await Attempt.findById(req.params.attemptId).select('examId');
    if (!attempt || !attempt.examId) {
      return res.status(404).json({ message: 'Exam attempt not found' });
    }
    await ensureExamOwnership(req, attempt.examId.toString());
    res.json(await deleteAttempt(req.params.attemptId, actorOf(req)));
  } catch (err: any) {
    fail(res, err, 'Failed to delete attempt');
  }
};

// POST /api/exam-review/:examId/dedupe — keep one attempt per student, delete the rest
export const dedupeCtrl = async (req: Request, res: Response) => {
  try {
    await ensureExamOwnership(req, req.params.examId);
    res.json(await dedupeExamAttempts(req.params.examId, actorOf(req)));
  } catch (err: any) {
    fail(res, err, 'Failed to remove duplicate attempts');
  }
};

// POST /api/exam-review/backfill — admin one-time recompute of every exam
export const backfillCtrl = async (req: Request, res: Response) => {
  try {
    res.json(await backfillAllExams(actorOf(req)));
  } catch (err: any) {
    fail(res, err, 'Backfill failed');
  }
};

// POST /api/exam-review/cleanup-duplicates — admin dedupe all + ensure unique index
export const cleanupDuplicatesCtrl = async (req: Request, res: Response) => {
  try {
    res.json(await cleanupAllDuplicates(actorOf(req)));
  } catch (err: any) {
    fail(res, err, 'Duplicate cleanup failed');
  }
};
