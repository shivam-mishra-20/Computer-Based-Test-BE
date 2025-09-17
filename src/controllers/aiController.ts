import { Request, Response } from 'express';
import { Types } from 'mongoose';
import Question from '../models/Question';
import { extractTextFromPdf, generateQuestionsFromTextGemini, gradeSubjectiveAnswerGroq, generatePaperFromTextGemini, refineQuestionGemini } from '../services/aiService';
import type { PaperBlueprint } from '../services/aiService';

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
    const typesRaw = body.types as string | undefined;
    const parsedTypes = typesRaw
      ? typesRaw.split(',').map((t) => t.trim()).filter(Boolean)
      : undefined;
    const opts = {
      subject: body.subject as string | undefined,
      topic: body.topic as string | undefined,
      difficulty: (body.difficulty as any) || 'medium',
      count: body.count ? Number(body.count) : 10,
      types: parsedTypes as any,
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
    const { text, subject, topic, difficulty, count, types } = req.body as any;
    if (!text || String(text).trim().length < 50) return res.status(400).json({ message: 'Provide sufficient source text' });
    const createdBy = new Types.ObjectId((req as any).user.id);
    let selectedTypes: string[] | undefined = undefined;
    if (Array.isArray(types)) selectedTypes = types;
    else if (typeof types === 'string') {
      try { const parsed = JSON.parse(types); if (Array.isArray(parsed)) selectedTypes = parsed; } catch { selectedTypes = types.split(',').map((t) => t.trim()); }
    }
    const opts = { subject, topic, difficulty, count: Number(count) || 10, types: selectedTypes as any, createdBy };
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

export const generatePaper = async (req: Request, res: Response) => {
  try {
    const { sourceText, blueprint } = req.body as { sourceText: string; blueprint: PaperBlueprint };
    if (!sourceText || String(sourceText).trim().length < 100) return res.status(400).json({ message: 'Provide sufficient sourceText (>=100 chars)' });
    if (!blueprint || !Array.isArray(blueprint.sections) || blueprint.sections.length === 0) return res.status(400).json({ message: 'Blueprint with at least one section required' });
    const paper = await generatePaperFromTextGemini(String(sourceText), blueprint);
    res.json(paper);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Paper generation failed' });
  }
};

// Generate paper from uploaded PDF
export const generatePaperFromPdf = async (req: Request, res: Response) => {
  try {
    const files: any[] | undefined = (req as any).files;
    let file = files && files.length ? files[0] : undefined;
    if (!file && Array.isArray(files)) {
      file = files.find(f => f.fieldname === 'file' || f.fieldname === 'pdf');
    }
    if (!file) return res.status(400).json({ message: 'PDF file required' });
    let { blueprint } = req.body as { blueprint: any };
    if (typeof blueprint === 'string') {
      try { blueprint = JSON.parse(blueprint); } catch { /* ignore */ }
    }
    if (!blueprint || !Array.isArray(blueprint.sections) || blueprint.sections.length === 0) return res.status(400).json({ message: 'Blueprint with at least one section required' });
    const text = await extractTextFromPdf(file.buffer);
    if (!text || text.trim().length < 100) return res.status(400).json({ message: 'Extracted text insufficient (<100 chars)' });
    const paper = await generatePaperFromTextGemini(text, blueprint);
    res.json(paper);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Paper PDF generation failed' });
  }
};

export const refineQuestion = async (req: Request, res: Response) => {
  try {
    const { question, notes, desiredDifficulty, constraints } = req.body as any;
    if (!question || !question.text) return res.status(400).json({ message: 'question with text required' });
    const refined = await refineQuestionGemini({ ...question, notes, desiredDifficulty, constraints });
    res.json(refined);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Refine failed' });
  }
};
