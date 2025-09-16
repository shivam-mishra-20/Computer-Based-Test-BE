import { Request, Response } from 'express';
import { Types } from 'mongoose';
import Question from '../models/Question';
import { extractTextFromPdf, generateQuestionsFromTextGemini, gradeSubjectiveAnswerGroq } from '../services/aiService';

export const generateFromPdf = async (req: Request, res: Response) => {
  try {
    const anyFiles = (req as any).files as any[] | undefined;
    const single = (req as any).file as { buffer: Buffer } | undefined;
    const file = single || (Array.isArray(anyFiles) && anyFiles.find((f) => f.fieldname === 'pdf'));
    if (!file) return res.status(400).json({ message: 'PDF file is required' });
    const text = await extractTextFromPdf(file.buffer);
    const createdBy = new Types.ObjectId((req as any).user.id);
    // accept case-insensitive body keys
    const body = Object.keys(req.body || {}).reduce((acc: any, k) => { acc[k.toLowerCase()] = req.body[k]; return acc; }, {} as any);
    const opts = {
      subject: body.subject as string | undefined,
      topic: body.topic as string | undefined,
      difficulty: (body.difficulty as any) || 'medium',
      count: body.count ? Number(body.count) : 10,
      createdBy,
    };
    const questions = await generateQuestionsFromTextGemini(text, opts);
    const saved = await Question.insertMany(questions.map((q) => ({ ...q, createdBy })));
    res.status(201).json({ items: saved, total: saved.length });
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to generate from PDF' });
  }
};

export const generateFromText = async (req: Request, res: Response) => {
  try {
    const { text, subject, topic, difficulty, count } = req.body as any;
    if (!text || String(text).trim().length < 50) return res.status(400).json({ message: 'Provide sufficient source text' });
    const createdBy = new Types.ObjectId((req as any).user.id);
    const opts = { subject, topic, difficulty, count: Number(count) || 10, createdBy };
    const questions = await generateQuestionsFromTextGemini(String(text), opts);
    const saved = await Question.insertMany(questions.map((q) => ({ ...q, createdBy })));
    res.status(201).json({ items: saved, total: saved.length });
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to generate from text' });
  }
};

export const evaluateSubjective = async (req: Request, res: Response) => {
  try {
    const { questionText, studentAnswer, rubric } = req.body as { questionText: string; studentAnswer: string; rubric?: string };
    if (!questionText || !studentAnswer) return res.status(400).json({ message: 'questionText and studentAnswer are required' });
    const r = await gradeSubjectiveAnswerGroq({ questionText, studentAnswer, rubric });
    res.json(r);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Evaluation failed' });
  }
};
