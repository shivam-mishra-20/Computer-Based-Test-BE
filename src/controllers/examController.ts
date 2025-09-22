import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { assignExam, createExam, createQuestion, deleteExam, deleteQuestion, getExam, listExams, listQuestions, updateExam, updateQuestion, createBlueprint, listBlueprints, updateBlueprint, deleteBlueprint, createExamFromPaper } from '../services/examService';
import { logAudit } from '../utils/logger';
import type { GeneratedPaperResult } from '../services/aiService';

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
  await logAudit((req as any).user?.id, 'admin.exam.create', String(exam._id), { title: exam.title });
    res.status(201).json(exam);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to create exam' });
  }
};

export const updateExamCtrl = async (req: Request, res: Response) => {
  const exam = await updateExam(req.params.id, req.body);
  if (!exam) return res.status(404).json({ message: 'Exam not found' });
  await logAudit((req as any).user?.id, 'admin.exam.update', String(exam._id), { patch: req.body });
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
  await logAudit((req as any).user?.id, 'admin.exam.delete', String(req.params.id));
  res.json({ message: 'Exam deleted' });
};

export const assignExamCtrl = async (req: Request, res: Response) => {
  // groups can be batch or classLevel labels, UI can choose which to send
  const { users, groups } = req.body as { users?: string[]; groups?: string[] };
  const exam = await assignExam(req.params.id, users, groups);
  if (!exam) return res.status(404).json({ message: 'Exam not found' });
  await logAudit((req as any).user?.id, 'admin.exam.assign', String(exam._id), { users, groups });
  res.json(exam);
};

// Blueprint CRUD
export const createBlueprintCtrl = async (req: Request, res: Response) => {
  try {
    const owner = new Types.ObjectId((req as any).user.id);
    const bp = await createBlueprint({ ...req.body, owner });
    res.status(201).json(bp);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to create blueprint' });
  }
};

export const listBlueprintsCtrl = async (req: Request, res: Response) => {
  const owner = new Types.ObjectId((req as any).user.id);
  const items = await listBlueprints(owner);
  res.json({ items, total: items.length });
};

export const updateBlueprintCtrl = async (req: Request, res: Response) => {
  const owner = new Types.ObjectId((req as any).user.id);
  const bp = await updateBlueprint(req.params.id, owner, req.body);
  if (!bp) return res.status(404).json({ message: 'Blueprint not found' });
  res.json(bp);
};

export const deleteBlueprintCtrl = async (req: Request, res: Response) => {
  const owner = new Types.ObjectId((req as any).user.id);
  await deleteBlueprint(req.params.id, owner);
  res.json({ message: 'Blueprint deleted' });
};

// Create exam from generated paper
export const createExamFromPaperCtrl = async (req: Request, res: Response) => {
  try {
    const { paper, options } = req.body as { paper: GeneratedPaperResult; options?: any };
    if (!paper || !paper.sections) return res.status(400).json({ message: 'paper is required' });
    const createdBy = new Types.ObjectId((req as any).user.id);
    const exam = await createExamFromPaper(paper, createdBy, options || {});
    res.status(201).json(exam);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to create exam from paper' });
  }
};
