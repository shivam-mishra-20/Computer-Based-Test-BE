import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { listAssignedExams, startAttempt, getAttemptView, saveAnswer, markForReview, submitAttempt, publishResult, logActivity } from '../services/attemptService';

export const listAssignedCtrl = async (req: Request, res: Response) => {
  const exams = await listAssignedExams((req as any).user.id);
  res.json(exams);
};

export const startAttemptCtrl = async (req: Request, res: Response) => {
  try {
    const attempt = await startAttempt(req.params.examId, (req as any).user.id);
    res.status(201).json(attempt);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to start attempt' });
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

export const saveAnswerCtrl = async (req: Request, res: Response) => {
  try {
    const attempt = await saveAnswer(req.params.attemptId, (req as any).user.id, {
      questionId: new Types.ObjectId(req.body.questionId),
      chosenOptionId: req.body.chosenOptionId ? new Types.ObjectId(req.body.chosenOptionId) : undefined,
      textAnswer: req.body.textAnswer,
      isMarkedForReview: req.body.isMarkedForReview,
      timeSpentSec: req.body.timeSpentSec,
    });
    res.json(attempt);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to save answer' });
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
    const attempt = await submitAttempt(req.params.attemptId, (req as any).user.id, !!req.body.auto);
    res.json(attempt);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to submit attempt' });
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
