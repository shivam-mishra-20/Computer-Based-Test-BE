import { Request, Response } from 'express';
import { Types } from 'mongoose';
import Question from '../models/Question';
import { extractTextFromPdf, extractTextFromImage, generateQuestionsFromTextGemini, gradeSubjectiveAnswerGroq, generatePaperFromTextGemini, refineQuestionGemini, getGuidanceText } from '../services/aiService';
import Guidance from '../models/Guidance';
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
    // Attach admin guidance if available
    const guidance = await getGuidanceText(opts.subject, opts.topic);
    const questions = await generateQuestionsFromTextGemini(text, { ...opts, __guidance: guidance } as any);
    const saved = await Question.insertMany(questions.map((q) => ({ ...q, createdBy })));
    res.status(201).json({ items: saved, total: saved.length });
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to generate from PDF' });
  }
};

// Generate from image (OCR)
export const generateFromImage = async (req: Request, res: Response) => {
  try {
    const files: any[] | undefined = (req as any).files;
    const single = (req as any).file as { buffer: Buffer } | undefined;
    const file = single || (Array.isArray(files) && files[0]);
    if (!file) return res.status(400).json({ message: 'Image file is required' });
    const text = await extractTextFromImage(file.buffer);
    const createdBy = new Types.ObjectId((req as any).user.id);
    const body = Object.keys(req.body || {}).reduce((acc: any, k) => { acc[k.toLowerCase()] = req.body[k]; return acc; }, {} as any);
    const typesRaw = body.types as string | undefined;
    const parsedTypes = typesRaw ? typesRaw.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
    const opts = {
      subject: body.subject as string | undefined,
      topic: body.topic as string | undefined,
      difficulty: (body.difficulty as any) || 'medium',
      count: body.count ? Number(body.count) : 10,
      types: parsedTypes as any,
      createdBy,
    };
    const guidance = await getGuidanceText(opts.subject, opts.topic);
    const questions = await generateQuestionsFromTextGemini(text, { ...opts, __guidance: guidance } as any);
    const saved = await Question.insertMany(questions.map((q) => ({ ...q, createdBy })));
    res.status(201).json({ items: saved, total: saved.length });
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to generate from image' });
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
    const guidance = await getGuidanceText(subject, topic);
    const questions = await generateQuestionsFromTextGemini(String(text), { ...opts, __guidance: guidance } as any);
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
    const guidance = await getGuidanceText(blueprint.subject, undefined);
    const paper = await generatePaperFromTextGemini(String(sourceText), { ...(blueprint as any), __guidance: guidance } as any);
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
    const guidance = await getGuidanceText(blueprint.subject, undefined);
    const paper = await generatePaperFromTextGemini(text, { ...(blueprint as any), __guidance: guidance } as any);
    res.json(paper);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Paper PDF generation failed' });
  }
};

// Generate paper from uploaded Image (OCR)
export const generatePaperFromImage = async (req: Request, res: Response) => {
  try {
    const single = (req as any).file as { buffer: Buffer } | undefined;
    const files: any[] | undefined = (req as any).files;
    const file = single || (Array.isArray(files) && files[0]);
    if (!file) return res.status(400).json({ message: 'Image file required' });

    let { blueprint } = req.body as { blueprint: any };
    if (typeof blueprint === 'string') {
      try { blueprint = JSON.parse(blueprint); } catch { /* ignore */ }
    }
    if (!blueprint || !Array.isArray(blueprint.sections) || blueprint.sections.length === 0) {
      return res.status(400).json({ message: 'Blueprint with at least one section required' });
    }

    const text = await extractTextFromImage(file.buffer);
    if (!text || text.trim().length < 100) {
      return res.status(400).json({ message: 'Extracted text insufficient (<100 chars)' });
    }

    const guidance = await getGuidanceText(blueprint.subject, undefined);
    const paper = await generatePaperFromTextGemini(text, { ...(blueprint as any), __guidance: guidance } as any);
    res.json(paper);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Paper Image generation failed' });
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

// Guidance CRUD (admin only; wired in routes)
export const createGuidance = async (req: Request, res: Response) => {
  try {
    const owner = new Types.ObjectId((req as any).user.id);
    const { subject, topic, instructions, isActive } = req.body as any;
    if (!instructions || String(instructions).trim().length < 10) return res.status(400).json({ message: 'instructions too short' });
    const doc = await Guidance.create({ subject, topic, instructions, owner, isActive: isActive !== false });
    res.status(201).json(doc);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to create guidance' });
  }
};

export const listGuidance = async (_req: Request, res: Response) => {
  const items = await Guidance.find().sort({ updatedAt: -1 });
  res.json({ items, total: items.length });
};

export const updateGuidance = async (req: Request, res: Response) => {
  const { id } = req.params as any;
  const patch = req.body as any;
  const doc = await Guidance.findByIdAndUpdate(id, patch, { new: true });
  if (!doc) return res.status(404).json({ message: 'Not found' });
  res.json(doc);
};

export const deleteGuidance = async (req: Request, res: Response) => {
  const { id } = req.params as any;
  await Guidance.findByIdAndDelete(id);
  res.json({ message: 'Deleted' });
};
