/**
 * Teacher AI Content Generator — unified controller.
 *
 *   POST   /api/teacher/ai/generate            (multipart, optional file)
 *   GET    /api/teacher/ai/history
 *   GET    /api/teacher/ai/history/:id
 *   DELETE /api/teacher/ai/history/:id
 *   POST   /api/teacher/ai/history/:id/regenerate
 *
 * Every generation is recorded in the AiGeneration collection. Failures are
 * logged and stored on the record; the request never crashes the app.
 */
import { Request, Response } from 'express';
import { Types } from 'mongoose';
import AiGeneration from '../models/AiGeneration';
import {
  aiContentService,
  renderPptx,
  buildDeckPreviewHtml,
  renderPaperPdf,
  buildPaperPreviewHtml,
  type GenerationResult,
} from '../services/aiContent';
import { uploadArtifact, deleteArtifact } from '../services/aiContent/artifactStore';
import type {
  AiFeature,
  AiSource,
  PaperOptions,
  PptOptions,
  UploadFile,
} from '../services/aiContent/types';

function userId(req: Request): Types.ObjectId {
  const u = (req as any).user;
  return new Types.ObjectId(u?._id || u?.id);
}

function parseOptions(raw: any): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

function toPptOptions(prompt: string | undefined, o: Record<string, any>): PptOptions {
  return {
    prompt,
    subject: o.subject,
    className: o.className ?? o.class,
    board: o.board,
    chapter: o.chapter,
    language: o.language,
    numSlides: o.numSlides ?? o.slides ?? o.numberOfSlides,
    theme: o.theme,
    style: o.style ?? o.presentationStyle,
    audience: o.audience,
    includeQuiz: !!(o.includeQuiz ?? o.quiz),
    includeObjectives: !!(o.includeObjectives ?? o.objectives),
    includeSummary: !!(o.includeSummary ?? o.summary),
  };
}

function toPaperOptions(prompt: string | undefined, o: Record<string, any>): PaperOptions {
  const sectionSpec = Array.isArray(o.sectionSpec)
    ? o.sectionSpec
        .map((s: any) => ({
          type: String(s?.type ?? '').trim(),
          count: Number(s?.count),
          marksEach: s?.marksEach != null ? Number(s.marksEach) : undefined,
        }))
        .filter((s: any) => s.type && Number.isFinite(s.count) && s.count > 0)
    : undefined;

  return {
    prompt,
    subject: o.subject,
    className: o.className ?? o.class,
    board: o.board,
    chapter: o.chapter,
    marks: o.marks != null ? Number(o.marks) : undefined,
    language: o.language,
    difficulty: o.difficulty,
    questionTypes: Array.isArray(o.questionTypes)
      ? o.questionTypes
      : typeof o.questionTypes === 'string'
        ? o.questionTypes.split(',').map((t: string) => t.trim()).filter(Boolean)
        : undefined,
    sectionSpec: sectionSpec && sectionSpec.length ? sectionSpec : undefined,
  };
}

const VALID_FEATURES: AiFeature[] = ['ppt', 'question_paper'];

async function runAndStore(params: {
  req: Request;
  feature: AiFeature;
  source: AiSource;
  prompt?: string;
  options: Record<string, any>;
  file?: UploadFile;
}): Promise<any> {
  const { req, feature, source, prompt, options, file } = params;
  const owner = userId(req);

  // Create the record up-front so even failures are visible in history.
  const doc = await AiGeneration.create({
    feature,
    source,
    status: 'processing',
    inputPrompt: prompt,
    options,
    createdBy: owner,
  });

  try {
    let result: GenerationResult;
    if (feature === 'ppt') {
      result = await aiContentService.generatePresentation(
        toPptOptions(prompt, options),
        file,
      );
    } else {
      result = await aiContentService.generateQuestionPaper(
        toPaperOptions(prompt, options),
        file,
      );
    }

    const storagePath = `ai-content/${owner.toString()}/${doc._id.toString()}.${result.artifact.ext}`;
    const stored = await uploadArtifact(
      result.artifact.buffer,
      storagePath,
      result.artifact.mimeType,
      { feature, createdBy: owner.toString() },
    );

    doc.status = 'completed';
    doc.title = result.title;
    doc.contentJSON = result.contentJSON;
    doc.artifactUrl = stored.url;
    doc.storagePath = stored.storagePath;
    doc.fileName = result.artifact.fileName;
    doc.mimeType = result.artifact.mimeType;
    doc.usedVision = result.usedVision;
    await doc.save();

    return { generation: doc.toObject(), previewHtml: result.previewHtml };
  } catch (err: any) {
    const message = err?.message || 'Generation failed';
    console.error(`[aiContent] ${feature} generation failed:`, err);
    doc.status = 'failed';
    doc.error = message;
    await doc.save();
    const e: any = new Error(message);
    e.generationId = doc._id;
    throw e;
  }
}

export const generate = async (req: Request, res: Response) => {
  try {
    const feature = String(req.body?.feature || '') as AiFeature;
    if (!VALID_FEATURES.includes(feature)) {
      return res.status(400).json({
        success: false,
        message: `Unsupported feature "${feature}". Use one of: ${VALID_FEATURES.join(', ')}.`,
      });
    }

    const file = (req as any).file as UploadFile | undefined;
    const options = parseOptions(req.body?.options);
    const prompt: string | undefined =
      (req.body?.prompt && String(req.body.prompt)) || options.prompt || undefined;

    // Determine source: an attached file wins; otherwise prompt.
    let source: AiSource = 'prompt';
    if (file) {
      const ext = (file.originalname.toLowerCase().split('.').pop() || '');
      source = ext === 'pdf' ? 'pdf'
        : ext === 'pptx' ? 'pptx'
        : ext === 'docx' ? 'docx'
        : 'image';
    } else if (!prompt) {
      return res.status(400).json({
        success: false,
        message: 'Provide a prompt or upload a file to generate from.',
      });
    }

    const out = await runAndStore({ req, feature, source, prompt, options, file });
    return res.status(201).json({ success: true, ...out });
  } catch (err: any) {
    return res.status(502).json({
      success: false,
      message: err?.message || 'Generation failed. Please try again.',
      generationId: err?.generationId,
      canRetry: true,
    });
  }
};

export const listHistory = async (req: Request, res: Response) => {
  try {
    const owner = userId(req);
    const feature = req.query.feature as AiFeature | undefined;
    const filter: any = { createdBy: owner };
    if (feature && VALID_FEATURES.includes(feature)) filter.feature = feature;

    const items = await AiGeneration.find(filter)
      .select('-contentJSON') // keep the list light; fetch full doc on demand
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    return res.json({ success: true, items, total: items.length });
  } catch (err: any) {
    console.error('[aiContent] listHistory failed:', err);
    return res.status(500).json({ success: false, message: 'Failed to load history' });
  }
};

export const getHistory = async (req: Request, res: Response) => {
  try {
    const owner = userId(req);
    const doc = await AiGeneration.findOne({ _id: req.params.id, createdBy: owner }).lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });

    // Rebuild a fresh preview from the stored structured content.
    let previewHtml: string | undefined;
    try {
      if (doc.contentJSON) {
        previewHtml =
          doc.feature === 'ppt'
            ? buildDeckPreviewHtml(doc.contentJSON as any)
            : buildPaperPreviewHtml(doc.contentJSON as any);
      }
    } catch {
      /* preview is best-effort */
    }
    return res.json({ success: true, generation: doc, previewHtml });
  } catch (err: any) {
    console.error('[aiContent] getHistory failed:', err);
    return res.status(500).json({ success: false, message: 'Failed to load item' });
  }
};

export const deleteHistory = async (req: Request, res: Response) => {
  try {
    const owner = userId(req);
    const doc = await AiGeneration.findOne({ _id: req.params.id, createdBy: owner });
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    await deleteArtifact(doc.storagePath);
    await doc.deleteOne();
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[aiContent] deleteHistory failed:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete item' });
  }
};

export const regenerate = async (req: Request, res: Response) => {
  try {
    const owner = userId(req);
    const prev = await AiGeneration.findOne({ _id: req.params.id, createdBy: owner }).lean();
    if (!prev) return res.status(404).json({ success: false, message: 'Not found' });

    const hasInputs = !!(prev.inputPrompt || (prev.options && Object.keys(prev.options).length));

    // No re-runnable inputs (e.g. a file-only source we no longer hold) → just
    // re-render the stored structured content into a fresh artifact.
    if (!hasInputs && prev.contentJSON) {
      const newDoc = await AiGeneration.create({
        feature: prev.feature,
        source: prev.source,
        status: 'processing',
        title: prev.title,
        inputPrompt: prev.inputPrompt,
        options: prev.options,
        contentJSON: prev.contentJSON,
        createdBy: owner,
      });
      try {
        const buffer =
          prev.feature === 'ppt'
            ? await renderPptx(prev.contentJSON as any)
            : await renderPaperPdf(prev.contentJSON as any);
        const ext = prev.feature === 'ppt' ? 'pptx' : 'pdf';
        const mimeType =
          prev.feature === 'ppt'
            ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            : 'application/pdf';
        const storagePath = `ai-content/${owner.toString()}/${newDoc._id.toString()}.${ext}`;
        const stored = await uploadArtifact(buffer, storagePath, mimeType, {
          feature: prev.feature,
        });
        newDoc.status = 'completed';
        newDoc.artifactUrl = stored.url;
        newDoc.storagePath = stored.storagePath;
        newDoc.fileName = prev.fileName || `${prev.feature}.${ext}`;
        newDoc.mimeType = mimeType;
        await newDoc.save();
        const previewHtml =
          prev.feature === 'ppt'
            ? buildDeckPreviewHtml(prev.contentJSON as any)
            : buildPaperPreviewHtml(prev.contentJSON as any);
        return res.status(201).json({ success: true, generation: newDoc.toObject(), previewHtml });
      } catch (err: any) {
        newDoc.status = 'failed';
        newDoc.error = err?.message || 'Re-render failed';
        await newDoc.save();
        throw err;
      }
    }

    // Re-run the model with the original inputs (no file on re-run).
    const out = await runAndStore({
      req,
      feature: prev.feature as AiFeature,
      source: 'prompt',
      prompt: prev.inputPrompt,
      options: (prev.options as Record<string, any>) || {},
    });
    return res.status(201).json({ success: true, ...out });
  } catch (err: any) {
    return res.status(502).json({
      success: false,
      message: err?.message || 'Regeneration failed. Please try again.',
      canRetry: true,
    });
  }
};
