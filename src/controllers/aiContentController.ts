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
import { uploadArtifact, deleteArtifact, stageSourceFile } from '../services/aiContent/artifactStore';
import { enqueuePptPipelineJob, cancelPptPipelineJob } from '../queues/pptPipelineQueue';
import { pptxBuilder, buildSlidesPreviewHtml } from '../services/aiContent/ppt/pptxBuilder';
import { resolveTheme } from '../services/aiContent/ppt/theme/themeRegistry';
import { renderSlidesPdf } from '../services/aiContent/ppt/pdfExport';
import { coerceBlueprint } from '../services/aiContent/ppt/blueprint';
import BlueprintTemplate from '../models/BlueprintTemplate';
import type { AiPptMode } from '../models/AiGeneration';
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
    blueprintTemplateId: typeof o.blueprintTemplateId === 'string' && o.blueprintTemplateId ? o.blueprintTemplateId : undefined,
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
    // Only ever reached with feature:'question_paper' — feature:'ppt' always
    // takes the async enqueuePptGeneration path (see generate()/regenerate()).
    const result: GenerationResult = await aiContentService.generateQuestionPaper(
      toPaperOptions(prompt, options),
      file,
    );

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

const VALID_PPT_MODES: AiPptMode[] = ['modernizer', 'smart_generator', 'hybrid', 'teacher_enhancement'];

function resolvePptMode(req: Request, options: Record<string, any>): AiPptMode {
  const raw = String(req.body?.mode || options.mode || '').trim();
  return (VALID_PPT_MODES as string[]).includes(raw) ? (raw as AiPptMode) : 'smart_generator';
}

/**
 * feature:'ppt' entry point — async only. Creates the AiGeneration doc as
 * 'queued', stages any uploaded file privately in Firebase (job payloads carry
 * only the storage ref, never raw bytes, through Redis), and enqueues a job
 * for pptPipelineWorker.ts to pick up. Returns immediately; the caller polls
 * GET /ai/history/:id or listens for the 'ai:generation:progress' socket event.
 */
async function enqueuePptGeneration(params: {
  req: Request;
  source: AiSource;
  prompt?: string;
  options: Record<string, any>;
  file?: UploadFile;
}): Promise<{ generation: any }> {
  const { req, source, prompt, options, file } = params;
  const owner = userId(req);
  const mode = resolvePptMode(req, options);

  const doc = await AiGeneration.create({
    feature: 'ppt',
    source,
    status: 'queued',
    mode,
    inputPrompt: prompt,
    options,
    createdBy: owner,
    pipeline: { currentStage: '', stages: [], warnings: [] },
  });

  let stagedFileRef: { storagePath: string; mimeType: string; originalName: string } | undefined;
  if (file) {
    const ext = (file.originalname.toLowerCase().split('.').pop() || 'bin');
    const storagePath = `ai-content/staging/${doc._id.toString()}/source.${ext}`;
    await stageSourceFile(file.buffer, storagePath, file.mimetype);
    stagedFileRef = { storagePath, mimeType: file.mimetype, originalName: file.originalname };
  }

  const jobId = await enqueuePptPipelineJob({
    generationId: doc._id.toString(),
    ownerId: owner.toString(),
    mode,
    phase: 'planning',
    stagedFileRef,
    // Normalized (field-name fallbacks + boolean coercion) — the doc's own
    // `options` above keeps the raw client payload for history/audit fidelity.
    options: toPptOptions(prompt, options),
  });
  doc.jobId = jobId;
  await doc.save();

  return { generation: doc.toObject() };
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

    // feature:'ppt' runs the async multi-stage pipeline (queued job, 202);
    // feature:'question_paper' stays fully synchronous — unchanged contract.
    if (feature === 'ppt') {
      const out = await enqueuePptGeneration({ req, source, prompt, options, file });
      return res.status(202).json({ success: true, ...out, queued: true });
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

/** POST /ai/history/:id/cancel — removes a queued/in-flight PPT job. The
 * worker checks AiGeneration.status between pipeline stages (see
 * AiOrchestratorService) and stops within one stage's duration; a job still
 * queued (not yet picked up) is removed from BullMQ outright. */
export const cancel = async (req: Request, res: Response) => {
  try {
    const owner = userId(req);
    const doc = await AiGeneration.findOne({ _id: req.params.id, createdBy: owner });
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    if (doc.status !== 'queued' && doc.status !== 'processing') {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel a generation with status "${doc.status}".`,
      });
    }
    if (doc.jobId) {
      await cancelPptPipelineJob(doc.jobId).catch(() => {});
    }
    doc.status = 'failed';
    doc.error = 'Cancelled by user';
    await doc.save();
    return res.json({ success: true, generation: doc.toObject() });
  } catch (err: any) {
    console.error('[aiContent] cancel failed:', err);
    return res.status(500).json({ success: false, message: 'Failed to cancel' });
  }
};

/**
 * POST /ai/history/:id/blueprint/approve — the teacher approved (possibly
 * after editing) the Lecture Blueprint. The submitted plan is sanitized,
 * stored as the single source of truth, and phase 2 (generation) is enqueued.
 * Body: { blueprint: LectureBlueprint } — omitted body approves the stored
 * proposal as-is.
 */
export const approveBlueprint = async (req: Request, res: Response) => {
  try {
    const owner = userId(req);
    const doc = await AiGeneration.findOne({ _id: req.params.id, createdBy: owner });
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    if (doc.feature !== 'ppt') {
      return res.status(400).json({ success: false, message: 'Blueprints only apply to presentations.' });
    }
    if (doc.status !== 'awaiting_approval') {
      return res.status(400).json({
        success: false,
        message: `This generation is not awaiting approval (status: "${doc.status}").`,
      });
    }

    let blueprint;
    try {
      blueprint = coerceBlueprint(req.body?.blueprint ?? doc.blueprint);
    } catch (e: any) {
      return res.status(400).json({ success: false, message: e?.message || 'Invalid blueprint.' });
    }

    doc.blueprint = blueprint as any;
    doc.blueprintApprovedAt = new Date();
    doc.status = 'queued';
    doc.error = undefined;
    await doc.save();

    const jobId = await enqueuePptPipelineJob({
      generationId: doc._id.toString(),
      ownerId: owner.toString(),
      mode: (doc.mode as AiPptMode) || 'smart_generator',
      phase: 'generation',
      options: toPptOptions(doc.inputPrompt, (doc.options as Record<string, any>) || {}),
    });
    doc.jobId = jobId;
    await doc.save();

    return res.status(202).json({ success: true, generation: doc.toObject(), queued: true });
  } catch (err: any) {
    console.error('[aiContent] approveBlueprint failed:', err);
    return res.status(502).json({ success: false, message: err?.message || 'Approval failed. Please try again.' });
  }
};

// ── Blueprint templates (reusable lecture structures) ───────────────────────

/** POST /ai/blueprint-templates — save a blueprint's STRUCTURE for reuse.
 * Lecture-specific grounding (knowledgeNodeIds) is stripped; applying the
 * template later fills topics from the new lecture's own content. */
export const saveBlueprintTemplate = async (req: Request, res: Response) => {
  try {
    const owner = userId(req);
    let blueprint;
    try {
      blueprint = coerceBlueprint(req.body?.blueprint);
    } catch (e: any) {
      return res.status(400).json({ success: false, message: e?.message || 'Invalid blueprint.' });
    }
    blueprint.sections = blueprint.sections.map((s) => ({ ...s, knowledgeNodeIds: undefined }));

    const name = String(req.body?.name || '').trim().slice(0, 80) || blueprint.title || 'Lecture template';
    const count = await BlueprintTemplate.countDocuments({ ownerId: owner });
    if (count >= 50) {
      return res.status(400).json({ success: false, message: 'Template limit reached (50). Delete an old template first.' });
    }
    const tpl = await BlueprintTemplate.create({ ownerId: owner, name, blueprint });
    return res.status(201).json({ success: true, template: tpl.toObject() });
  } catch (err: any) {
    console.error('[aiContent] saveBlueprintTemplate failed:', err);
    return res.status(500).json({ success: false, message: 'Failed to save template' });
  }
};

/** GET /ai/blueprint-templates */
export const listBlueprintTemplates = async (req: Request, res: Response) => {
  try {
    const owner = userId(req);
    const items = await BlueprintTemplate.find({ ownerId: owner }).sort({ createdAt: -1 }).limit(50).lean();
    return res.json({ success: true, items });
  } catch (err: any) {
    console.error('[aiContent] listBlueprintTemplates failed:', err);
    return res.status(500).json({ success: false, message: 'Failed to load templates' });
  }
};

/** DELETE /ai/blueprint-templates/:id */
export const deleteBlueprintTemplate = async (req: Request, res: Response) => {
  try {
    const owner = userId(req);
    const tpl = await BlueprintTemplate.findOneAndDelete({ _id: req.params.id, ownerId: owner });
    if (!tpl) return res.status(404).json({ success: false, message: 'Not found' });
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[aiContent] deleteBlueprintTemplate failed:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete template' });
  }
};

export const listHistory = async (req: Request, res: Response) => {
  try {
    const owner = userId(req);
    const feature = req.query.feature as AiFeature | undefined;
    const filter: any = { createdBy: owner };
    if (feature && VALID_FEATURES.includes(feature)) filter.feature = feature;

    const items = await AiGeneration.find(filter)
      .select('-contentJSON -blueprint') // keep the list light; fetch full doc on demand
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
        const cj = doc.contentJSON as any;
        if (doc.feature === 'ppt') {
          previewHtml =
            cj?.__pptSchema === 2
              ? buildSlidesPreviewHtml(cj.slides, resolveTheme(cj.themeId))
              : buildDeckPreviewHtml(cj); // legacy pre-Phase-4 SlideDeck shape
        } else {
          previewHtml = buildPaperPreviewHtml(cj);
        }
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
    if (doc.pdfStoragePath) await deleteArtifact(doc.pdfStoragePath);
    await doc.deleteOne();
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[aiContent] deleteHistory failed:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete item' });
  }
};

/**
 * POST /ai/history/:id/export-pdf — lazily renders a PDF rendition of a
 * completed ppt deck (one 16:9 page per slide, from the same HTML the preview
 * shows) and caches its URL on the doc, so repeat downloads are instant.
 */
export const exportPdf = async (req: Request, res: Response) => {
  try {
    const owner = userId(req);
    const doc = await AiGeneration.findOne({ _id: req.params.id, createdBy: owner });
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    if (doc.feature !== 'ppt') {
      return res.status(400).json({ success: false, message: 'PDF export is only available for presentations.' });
    }
    if (doc.status !== 'completed' || !doc.contentJSON) {
      return res.status(400).json({ success: false, message: 'This generation is not ready yet.' });
    }

    const fileName = (doc.fileName || 'presentation.pptx').replace(/\.pptx$/i, '') + '.pdf';

    if (doc.pdfArtifactUrl) {
      return res.json({ success: true, url: doc.pdfArtifactUrl, fileName });
    }

    const cj = doc.contentJSON as any;
    const previewHtml =
      cj?.__pptSchema === 2
        ? buildSlidesPreviewHtml(cj.slides, resolveTheme(cj.themeId))
        : buildDeckPreviewHtml(cj); // legacy pre-pipeline SlideDeck shape

    const pdfBuffer = await renderSlidesPdf(previewHtml);
    const storagePath = `ai-content/${owner.toString()}/${doc._id.toString()}.pdf`;
    const stored = await uploadArtifact(pdfBuffer, storagePath, 'application/pdf', {
      feature: 'ppt',
      createdBy: owner.toString(),
    });

    doc.pdfArtifactUrl = stored.url;
    doc.pdfStoragePath = stored.storagePath;
    await doc.save();

    return res.json({ success: true, url: stored.url, fileName });
  } catch (err: any) {
    console.error('[aiContent] exportPdf failed:', err);
    return res.status(500).json({ success: false, message: err?.message || 'PDF export failed. Please try again.' });
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
        let buffer: Buffer;
        let ext: string;
        let mimeType: string;
        let previewHtml: string;

        if (prev.feature === 'ppt') {
          const cj = prev.contentJSON as any;
          if (cj?.__pptSchema === 2) {
            // Phase 4+ shape: { slides: GeneratedSlide[], themeId, deckTitle }.
            const theme = resolveTheme(cj.themeId);
            const rendered = await pptxBuilder.render(cj.slides, theme, {
              generationId: newDoc._id.toString(),
              ownerId: owner.toString(),
              mode: (prev.mode as any) || 'smart_generator',
              options: (prev.options as any) || {},
            });
            buffer = rendered.output.buffer;
            ext = rendered.output.ext;
            mimeType = rendered.output.mimeType;
            previewHtml = rendered.output.previewHtml;
          } else {
            // Legacy pre-Phase-4 flat SlideDeck shape — renderPptx/buildDeckPreviewHtml unchanged.
            buffer = await renderPptx(cj);
            ext = 'pptx';
            mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
            previewHtml = buildDeckPreviewHtml(cj);
          }
        } else {
          buffer = await renderPaperPdf(prev.contentJSON as any);
          ext = 'pdf';
          mimeType = 'application/pdf';
          previewHtml = buildPaperPreviewHtml(prev.contentJSON as any);
        }

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
        return res.status(201).json({ success: true, generation: newDoc.toObject(), previewHtml });
      } catch (err: any) {
        newDoc.status = 'failed';
        newDoc.error = err?.message || 'Re-render failed';
        await newDoc.save();
        throw err;
      }
    }

    // Re-run the model with the original inputs (no file on re-run).
    if (prev.feature === 'ppt') {
      // An approved blueprint + persisted knowledge graph = we can re-generate
      // the deck DIRECTLY from the same approved plan (fresh slide wording,
      // same structure) — no re-planning, no re-approval, no file needed.
      if (prev.blueprint && prev.blueprintApprovedAt && prev.knowledgeGraphId) {
        const owner2 = userId(req);
        const newDoc = await AiGeneration.create({
          feature: 'ppt',
          source: prev.source,
          status: 'queued',
          mode: prev.mode,
          title: prev.title,
          inputPrompt: prev.inputPrompt,
          options: prev.options,
          blueprint: prev.blueprint,
          blueprintApprovedAt: new Date(),
          knowledgeGraphId: prev.knowledgeGraphId,
          createdBy: owner2,
          pipeline: { currentStage: '', stages: [], warnings: [] },
        });
        const jobId = await enqueuePptPipelineJob({
          generationId: newDoc._id.toString(),
          ownerId: owner2.toString(),
          mode: (prev.mode as AiPptMode) || 'smart_generator',
          phase: 'generation',
          options: toPptOptions(prev.inputPrompt, (prev.options as Record<string, any>) || {}),
        });
        newDoc.jobId = jobId;
        await newDoc.save();
        return res.status(202).json({ success: true, generation: newDoc.toObject(), queued: true });
      }

      const out = await enqueuePptGeneration({
        req,
        source: 'prompt',
        prompt: prev.inputPrompt,
        options: (prev.options as Record<string, any>) || {},
      });
      return res.status(202).json({ success: true, ...out, queued: true });
    }

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
