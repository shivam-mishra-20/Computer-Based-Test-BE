import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { createPaper, deletePaper, getPaper, listPapers, setPaperSolutions, updatePaper } from '../services/paperService';
import type { GeneratedPaperResult } from '../services/aiService';
import { generateSolutionsForPaper } from '../services/aiService';
import { buildPaperHtml } from '../utils/paperExport';

export const createPaperCtrl = async (req: Request, res: Response) => {
  try {
    const owner = new Types.ObjectId((req as any).user.id);
    const payload = req.body as Partial<GeneratedPaperResult> & { meta?: any };
    if (!payload || !payload.sections) return res.status(400).json({ message: 'Invalid paper payload' });
    const saved = await createPaper(owner, {
      owner,
      examTitle: payload.examTitle!,
      subject: payload.subject,
      totalMarks: payload.totalMarks,
      generalInstructions: payload.generalInstructions || [],
      sections: payload.sections,
      meta: payload.meta || { source: 'ai' },
    } as any);
    res.status(201).json(saved);
  } catch (e: any) {
    res.status(400).json({ message: e.message || 'Failed to create paper' });
  }
};

export const listPapersCtrl = async (req: Request, res: Response) => {
  const role = (req as any).user?.role as string | undefined;
  const owner = role === 'admin' ? null : new Types.ObjectId((req as any).user.id);
  const { limit = '50', skip = '0' } = req.query as any;
  const data = await listPapers(owner, parseInt(String(limit), 10), parseInt(String(skip), 10));
  res.json(data);
};

export const getPaperCtrl = async (req: Request, res: Response) => {
  const role = (req as any).user?.role as string | undefined;
  const owner = role === 'admin' ? null : new Types.ObjectId((req as any).user.id);
  const doc = await getPaper(owner, req.params.id);
  if (!doc) return res.status(404).json({ message: 'Paper not found' });
  res.json(doc);
};

export const updatePaperCtrl = async (req: Request, res: Response) => {
  const role = (req as any).user?.role as string | undefined;
  const owner = role === 'admin' ? null : new Types.ObjectId((req as any).user.id);
  const doc = await updatePaper(owner, req.params.id, req.body);
  if (!doc) return res.status(404).json({ message: 'Paper not found' });
  res.json(doc);
};

export const deletePaperCtrl = async (req: Request, res: Response) => {
  const role = (req as any).user?.role as string | undefined;
  const owner = role === 'admin' ? null : new Types.ObjectId((req as any).user.id);
  await deletePaper(owner, req.params.id);
  res.json({ message: 'Deleted' });
};

export const generateSolutionsCtrl = async (req: Request, res: Response) => {
  try {
    const role = (req as any).user?.role as string | undefined;
    const owner = role === 'admin' ? null : new Types.ObjectId((req as any).user.id);
    const id = req.params.id;
    const doc = await getPaper(owner, id);
    if (!doc) return res.status(404).json({ message: 'Paper not found' });
    const result = await generateSolutionsForPaper({
      examTitle: doc.examTitle,
      subject: doc.subject || undefined,
      totalMarks: doc.totalMarks || 0,
      generalInstructions: doc.generalInstructions || [],
      sections: doc.sections as any,
    });
    const updated = await setPaperSolutions(owner, id, result.sections);
    res.json(updated);
  } catch (e: any) {
    res.status(400).json({ message: e.message || 'Failed to generate solutions' });
  }
};

export const exportPdfCtrl = async (req: Request, res: Response) => {
  const role = (req as any).user?.role as string | undefined;
  const owner = role === 'admin' ? null : new Types.ObjectId((req as any).user.id);
  const id = req.params.id;
  // Include solutions by default for PDF
  const includeSolutions = String(req.query.solutions ?? 'true') === 'true';
  const doc = await getPaper(owner, id);
  if (!doc) return res.status(404).json({ message: 'Paper not found' });
  const html = buildPaperHtml(doc as any, { includeSolutions });
  try {
    // Lazy import puppeteer to avoid startup cost if not installed
    const puppeteer = await import('puppeteer');
    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] } as any);
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' } });
    await browser.close();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${(doc.examTitle || 'paper').replace(/[^a-z0-9-_]+/gi, '_')}.pdf"`);
    return res.send(pdf);
  } catch (e: any) {
    // Strict behavior: do NOT return HTML; signal failure so clients don't download .html accidentally
    console.error('exportPdfCtrl: PDF generation failed', e);
    return res.status(500).json({ message: 'PDF generation failed. Please try again.' });
  }
};

export const exportDocCtrl = async (req: Request, res: Response) => {
  const role = (req as any).user?.role as string | undefined;
  const owner = role === 'admin' ? null : new Types.ObjectId((req as any).user.id);
  const id = req.params.id;
  const includeSolutions = String(req.query.solutions || 'true') !== 'false';
  const doc = await getPaper(owner, id);
  if (!doc) return res.status(404).json({ message: 'Paper not found' });
  const html = buildPaperHtml(doc as any, { includeSolutions });
  res.setHeader('Content-Type', 'application/msword');
  res.setHeader('Content-Disposition', `attachment; filename="${(doc.examTitle || 'paper').replace(/[^a-z0-9-_]+/gi, '_')}.doc`);
  res.send(html);
};
