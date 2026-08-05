import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { listAssignedExams, startAttempt, getAttemptView, saveAnswer, saveAnswersBatch, markForReview, clearAnswerResponse, submitAttempt, publishResult, logActivity, nextAdaptiveQuestion, listPendingReviewAttempts, adjustAnswerScore, listAttemptsForUser, getAttemptViewForTeacher, getExamPreview, heartbeat } from '../services/attemptService';
import Question from '../models/Question';
import Attempt from '../models/Attempt';

export const listAssignedCtrl = async (req: Request, res: Response) => {
  const exams = await listAssignedExams((req as any).user.id);
  res.json(exams);
};

export const startAttemptCtrl = async (req: Request, res: Response) => {
  try {
    const attempt = await startAttempt(req.params.examId, (req as any).user.id);
    res.status(201).json(attempt);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to start attempt', code: err.code, startAt: err.startAt, endAt: err.endAt });
  }
};

export const examPreviewCtrl = async (req: Request, res: Response) => {
  try {
    const preview = await getExamPreview(req.params.examId, (req as any).user.id);
    res.json(preview);
  } catch (err: any) {
    res.status(err.code === 'NOT_FOUND' ? 404 : 400).json({ message: err.message || 'Failed to load exam preview', code: err.code });
  }
};

export const heartbeatCtrl = async (req: Request, res: Response) => {
  try {
    const result = await heartbeat(req.params.attemptId, (req as any).user.id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to record heartbeat' });
  }
};

export const getAttemptCtrl = async (req: Request, res: Response) => {
  try {
    const view = await getAttemptView(req.params.attemptId, (req as any).user.id);
    res.json(view);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to fetch attempt' });
  }
};

// Build a PARTIAL answer that contains only the fields the client actually
// sent. The service merges non-destructively, so omitting a field leaves the
// stored value intact (critical: a mark-for-review toggle must not wipe the
// answer, and an answer save must not wipe the review flag). Shared by the
// single-answer and batch (offline-sync flush) endpoints.
function buildAnswerFromBody(body: any): any {
  const answer: any = { questionId: new Types.ObjectId(body.questionId) };

  if (body.chosenOptionId) {
    answer.chosenOptionId = new Types.ObjectId(body.chosenOptionId);
  }
  if (Array.isArray(body.selectedOptionIds)) {
    // Multi-select is persisted as a JSON array of option ids in textAnswer.
    answer.textAnswer = JSON.stringify(body.selectedOptionIds);
  } else if (body.textAnswer !== undefined && body.textAnswer !== null) {
    answer.textAnswer = body.textAnswer;
  }
  if (typeof body.isMarkedForReview === 'boolean') {
    answer.isMarkedForReview = body.isMarkedForReview;
  }
  if (body.timeSpentSec !== undefined) {
    answer.timeSpentSec = body.timeSpentSec;
  }
  // Offline-sync ordering: monotonic per-attempt sequence + client timestamp.
  // Older clients that don't send these simply skip the staleness guard.
  if (typeof body.clientSeq === 'number') {
    answer.clientSeq = body.clientSeq;
  }
  if (body.clientTs) {
    answer.clientTs = new Date(body.clientTs);
  }

  // Backward/cross-client compatibility: older mobile builds POST a single
  // `response` field instead of chosenOptionId/textAnswer. Route it to the
  // right field so those answers are no longer silently dropped (the "0
  // attempted from app" bug). Only used when explicit fields are absent.
  if (
    answer.chosenOptionId === undefined &&
    answer.textAnswer === undefined &&
    body.response !== undefined &&
    body.response !== null
  ) {
    const r = body.response;
    if (Array.isArray(r)) {
      answer.textAnswer = JSON.stringify(r);
    } else if (typeof r === 'string' && /^[a-f\d]{24}$/i.test(r)) {
      answer.chosenOptionId = new Types.ObjectId(r);
    } else {
      answer.textAnswer = String(r);
    }
  }
  return answer;
}

export const saveAnswerCtrl = async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    // Deselect / clear a response (keeps the mark-for-review flag).
    if (body.clear) {
      const cleared = await clearAnswerResponse(req.params.attemptId, (req as any).user.id, body.questionId);
      return res.json(cleared);
    }
    const answer = buildAnswerFromBody(body);
    const { attempt, applied } = await saveAnswer(req.params.attemptId, (req as any).user.id, answer);
    res.json({ ...(attempt as any).toObject(), applied });
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to save answer' });
  }
};

export const saveAnswersBatchCtrl = async (req: Request, res: Response) => {
  try {
    const items = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const answers = items.map(buildAnswerFromBody);
    const { attempt, results } = await saveAnswersBatch(req.params.attemptId, (req as any).user.id, answers);
    res.json({ ...(attempt as any).toObject(), results });
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to sync answers' });
  }
};

export const markForReviewCtrl = async (req: Request, res: Response) => {
  try {
    const attempt = await markForReview(req.params.attemptId, (req as any).user.id, req.body.questionId, !!req.body.marked);
    res.json(attempt);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to update mark for review' });
  }
};

export const submitAttemptCtrl = async (req: Request, res: Response) => {
  try {
    // Tolerate a body-less POST (req.body may be undefined) — older mobile builds
    // submit with no body, and reading `.auto` off undefined throws a 400.
    const body = req.body || {};
    // Last-mile answers a client attaches directly to the submit call (any
    // still-unsynced offline-queue entries at exam end).
    const inlineAnswers = Array.isArray(body.answers) ? body.answers.map(buildAnswerFromBody) : [];
    const attempt = await submitAttempt(req.params.attemptId, (req as any).user.id, !!body.auto, inlineAnswers);
    res.json(attempt);
  } catch (err: any) {
    const status = err.code === 'SUBMIT_LOCKED' ? 403 : 400;
    res.status(status).json({ message: err.message || 'Failed to submit attempt', code: err.code, unlockAt: err.unlockAt });
  }
};

export const publishResultCtrl = async (req: Request, res: Response) => {
  try {
    const attempt = await publishResult(req.params.attemptId, !!req.body.publish);
    res.json(attempt);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to publish result' });
  }
};

export const logActivityCtrl = async (req: Request, res: Response) => {
  try {
    const entry = await logActivity(
      req.params.attemptId,
      (req as any).user.id,
      req.body.type,
      req.body.meta
    );
    res.status(201).json(entry);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to log activity' });
  }
};

export const nextAdaptiveQuestionCtrl = async (req: Request, res: Response) => {
  try {
    const result = await nextAdaptiveQuestion(req.params.attemptId, (req as any).user.id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to select next question' });
  }
};
export const listPendingReviewCtrl = async (_req: Request, res: Response) => {
  try {
    const list = await listPendingReviewAttempts();
    res.json(list);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to list attempts' });
  }
};

export const adjustAnswerScoreCtrl = async (req: Request, res: Response) => {
  try {
    // Accept both answerQuestionId (frontend) and answerId for compatibility
    const questionId = req.body.answerQuestionId || req.body.answerId;
    if (!questionId) {
      return res.status(400).json({ message: 'answerQuestionId is required' });
    }
    const updated = await adjustAnswerScore(req.params.attemptId, questionId, req.body.score, req.body.feedback);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to adjust score' });
  }
};

export const listMyAttemptsCtrl = async (req: Request, res: Response) => {
  try {
    const published = req.query.published === '1' || req.query.published === 'true';
    const list = await listAttemptsForUser((req as any).user.id, { published });
    res.json(list);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to list attempts' });
  }
};

export const getPracticeExplanationCtrl = async (req: Request, res: Response) => {
  try {
    const { attemptId, questionId } = req.params as any;
    const attempt = await Attempt.findById(attemptId);
    if (!attempt) return res.status(404).json({ message: 'Attempt not found' });
    if (attempt.userId.toString() !== (req as any).user.id) return res.status(403).json({ message: 'Forbidden' });
    if (attempt.mode !== 'practice') return res.status(403).json({ message: 'Explanations only in practice mode' });
    const answered = attempt.answers.find((a) => a.questionId.toString() === questionId);
    if (!answered) return res.status(403).json({ message: 'Answer the question first' });
    const q = await Question.findById(questionId);
    if (!q || !q.explanation) return res.json({ explanation: null });
    res.json({ explanation: q.explanation });
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to fetch explanation' });
  }
};

export const teacherAttemptViewCtrl = async (req: Request, res: Response) => {
  try {
    const view = await getAttemptViewForTeacher(req.params.attemptId);
    res.json(view);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to fetch attempt for review' });
  }
};
