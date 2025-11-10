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
  try {
    const { Document, Paragraph, TextRun, Packer, HeadingLevel, AlignmentType, UnderlineType } = await import('docx');
    const { mathJaxReady, convertLatex2Math } = await import('@hungknguyen/docx-math-converter');
    await mathJaxReady();

    const displayRe = /\$\$([\s\S]*?)\$\$/g;
    const inlineRe = /\$([^$]+?)\$/g;

    const paragraphChildrenFromText = (text: string, opts?: { bold?: boolean; italics?: boolean }) => {
      const children: any[] = [];
      const matches: Array<{ start: number; end: number; content: string; display: boolean }> = [];
      let m: RegExpExecArray | null;
      while ((m = displayRe.exec(text)) !== null) matches.push({ start: m.index, end: m.index + m[0].length, content: m[1], display: true });
      while ((m = inlineRe.exec(text)) !== null) if (!matches.some(dm => m!.index >= dm.start && m!.index < dm.end)) matches.push({ start: m.index, end: m.index + m[0].length, content: m[1], display: false });
      matches.sort((a, b) => a.start - b.start);
      let i = 0;
      for (const match of matches) {
        if (i < match.start) {
          const plain = text.slice(i, match.start);
          const parts = plain.split(/(\n)/);
          for (const p of parts) {
            if (p === '\n') children.push(new TextRun({ text: '', break: 1 }));
            else if (p) children.push(new TextRun({ text: p, bold: opts?.bold, italics: opts?.italics }));
          }
        }
        try {
          const mathObj = convertLatex2Math(match.content);
          children.push(mathObj as any);
        } catch {
          children.push(new TextRun({ text: match.content }));
        }
        i = match.end;
      }
      if (i < text.length) {
        const tail = text.slice(i);
        const parts = tail.split(/(\n)/);
        for (const p of parts) {
          if (p === '\n') children.push(new TextRun({ text: '', break: 1 }));
          else if (p) children.push(new TextRun({ text: p, bold: opts?.bold, italics: opts?.italics }));
        }
      }
      return children;
    };

    const children: any[] = [];
    // Title
    children.push(
      new Paragraph({
        children: [new TextRun({ text: doc.examTitle, bold: true, size: 32 })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
      })
    );
    // Subject
    if (doc.subject) {
      children.push(new Paragraph({ children: [new TextRun({ text: `Subject: ${doc.subject}`, bold: true })], alignment: AlignmentType.CENTER, spacing: { after: 100 } }));
    }
    // Meta
    const metaBits: string[] = [];
    if (typeof doc.totalMarks === 'number') metaBits.push(`Total Marks: ${doc.totalMarks}`);
    if ((doc as any).meta?.durationMins) metaBits.push(`Time: ${(doc as any).meta?.durationMins} mins`);
    if (metaBits.length) {
      children.push(new Paragraph({ children: [new TextRun({ text: metaBits.join(' | '), italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 200 } }));
    }
    // General Instructions
    if (Array.isArray(doc.generalInstructions) && doc.generalInstructions.length) {
      children.push(new Paragraph({ children: [new TextRun({ text: 'General Instructions:', bold: true, underline: { type: UnderlineType.SINGLE } })], spacing: { after: 100 } }));
      doc.generalInstructions.forEach((t, i) => {
        children.push(new Paragraph({ children: paragraphChildrenFromText(`${i + 1}. ${t}`), spacing: { after: 50 } }));
      });
      children.push(new Paragraph({ children: [new TextRun({ text: '' })], spacing: { after: 200 } }));
    }
    // Sections
    for (let sIdx = 0; sIdx < (doc.sections as any[]).length; sIdx++) {
      const sec = (doc.sections as any[])[sIdx];
      const secTitle = sec.title + (sec.marksPerQuestion ? ` (Marks per Question: ${sec.marksPerQuestion})` : '');
      children.push(new Paragraph({ children: [new TextRun({ text: secTitle, bold: true, size: 24 })], heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 } }));
      if (sec.instructions) children.push(new Paragraph({ children: paragraphChildrenFromText(sec.instructions, { italics: true }) }));
      const sols = (doc as any).solutions?.sections?.[sIdx]?.solutions || [];
      for (let qi = 0; qi < (sec.questions || []).length; qi++) {
        const q = sec.questions[qi];
        // Question text
        children.push(new Paragraph({ children: [new TextRun({ text: `${qi + 1}. `, bold: true }), ...paragraphChildrenFromText(String(q.text ?? ''))] }));
        // Diagram
        if (q.diagramUrl) {
          try {
            const axios = require('axios');
            const fs = require('fs');
            const path = require('path');
            const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
            const toAbs = (u: string) => (/^https?:\/\//i.test(u) || /^data:/i.test(u) ? u : (u.startsWith('/uploads/') ? path.join(process.cwd(), u.replace(/^\//, '')) : (base ? `${base}${u}` : u)));
            const u = toAbs(q.diagramUrl);
            let buffer: Buffer | null = null;
            if (/^data:/i.test(u)) {
              const m = /^data:([^;]+);base64,(.*)$/i.exec(u);
              if (m) buffer = Buffer.from(m[2], 'base64');
            } else if (/^https?:\/\//i.test(u)) {
              const resp = await axios.get(u, { responseType: 'arraybuffer' });
              buffer = Buffer.from(resp.data);
            } else {
              const abs = path.isAbsolute(u) ? u : path.join(process.cwd(), u);
              buffer = fs.readFileSync(abs);
            }
            if (buffer) {
              const { ImageRun } = await import('docx');
              children.push(new Paragraph({ children: [new ImageRun({ data: buffer, transformation: { width: 500, height: 300 } } as any)] }));
            }
          } catch {}
        }
        // Options
        if (Array.isArray(q.options) && q.options.length) {
          for (let oi = 0; oi < q.options.length; oi++) {
            const opt = q.options[oi];
            const label = String.fromCharCode(65 + oi) + '.';
            children.push(new Paragraph({ children: [new TextRun({ text: `   ${label} `, bold: true }), ...paragraphChildrenFromText(String(opt.text ?? ''))] }));
          }
        }
        // Explanation or Solution
        const solText = includeSolutions && (q.explanation || sols[qi]?.solutionText) ? (q.explanation || sols[qi]?.solutionText) : '';
        if (solText) {
          children.push(new Paragraph({ children: [new TextRun({ text: 'Solution:', bold: true })] }));
          children.push(new Paragraph({ children: paragraphChildrenFromText(String(solText)) }));
        }
      }
    }

    const docx = new Document({ sections: [{ properties: {}, children }] });
    const buffer = await Packer.toBuffer(docx);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${(doc.examTitle || 'paper').replace(/[^a-z0-9-_]+/gi, '_')}.docx`);
    return res.send(buffer);
  } catch (e: any) {
    console.error('exportDocCtrl: DOCX generation failed', e);
    // Fallback to HTML-as-DOC to avoid blocking export
    const html = buildPaperHtml(doc as any, { includeSolutions });
    res.setHeader('Content-Type', 'application/msword');
    res.setHeader('Content-Disposition', `attachment; filename="${(doc.examTitle || 'paper').replace(/[^a-z0-9-_]+/gi, '_')}.doc`);
    return res.send(html);
  }
};
