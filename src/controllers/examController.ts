import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { assignExam, createExam, createQuestion, deleteExam, deleteQuestion, getExam, listExams, listQuestions, updateExam, updateQuestion } from '../services/examService';

export const createQuestionCtrl = async (req: Request, res: Response) => {
  try {
    const createdBy = new Types.ObjectId((req as any).user.id);
    const q = await createQuestion({ ...req.body, createdBy });
    res.status(201).json(q);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to create question' });
  }
};

export const listQuestionsCtrl = async (req: Request, res: Response) => {
  const { q, subject, topic, difficulty, limit = '50', skip = '0' } = req.query as any;
  const filter: any = {};
  if (q) filter.text = { $regex: q, $options: 'i' };
  if (subject) filter['tags.subject'] = subject;
  if (topic) filter['tags.topic'] = topic;
  if (difficulty) filter['tags.difficulty'] = difficulty;
  const result = await listQuestions(filter, parseInt(limit, 10), parseInt(skip, 10));
  res.json(result);
};

export const updateQuestionCtrl = async (req: Request, res: Response) => {
  const q = await updateQuestion(req.params.id, req.body);
  if (!q) return res.status(404).json({ message: 'Question not found' });
  res.json(q);
};

export const deleteQuestionCtrl = async (req: Request, res: Response) => {
  await deleteQuestion(req.params.id);
  res.json({ message: 'Question deleted' });
};

export const createExamCtrl = async (req: Request, res: Response) => {
  try {
    const createdBy = new Types.ObjectId((req as any).user.id);
    const exam = await createExam({ ...req.body, createdBy });
    res.status(201).json(exam);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to create exam' });
  }
};

export const updateExamCtrl = async (req: Request, res: Response) => {
  const exam = await updateExam(req.params.id, req.body);
  if (!exam) return res.status(404).json({ message: 'Exam not found' });
  res.json(exam);
};

export const getExamCtrl = async (req: Request, res: Response) => {
  const exam = await getExam(req.params.id);
  if (!exam) return res.status(404).json({ message: 'Exam not found' });
  res.json(exam);
};

export const listExamsCtrl = async (req: Request, res: Response) => {
  const { title, createdBy, isPublished, limit = '50', skip = '0' } = req.query as any;
  const filter: any = {};
  if (title) filter.title = { $regex: title, $options: 'i' };
  if (createdBy) filter.createdBy = createdBy;
  if (isPublished !== undefined) filter.isPublished = isPublished === 'true';
  const result = await listExams(filter, parseInt(limit, 10), parseInt(skip, 10));
  res.json(result);
};

export const deleteExamCtrl = async (req: Request, res: Response) => {
  await deleteExam(req.params.id);
  res.json({ message: 'Exam deleted' });
};

export const assignExamCtrl = async (req: Request, res: Response) => {
  const { users, groups } = req.body as { users?: string[]; groups?: string[] };
  const exam = await assignExam(req.params.id, users, groups);
  if (!exam) return res.status(404).json({ message: 'Exam not found' });
  res.json(exam);
};
