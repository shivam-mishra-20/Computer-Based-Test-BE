/**
 * The AI PPT pipeline worker — queue consumer, pipeline runner, progress
 * emitter, retry/failure semantics. Extracted into a core so it can run in
 * TWO ways with identical behavior:
 *
 *   1. EMBEDDED in the API server (the default — see server.ts): `npm start`
 *      alone is enough; nobody has to remember a second process. This is the
 *      mode that matches how this backend is actually deployed (one service).
 *   2. As its own process (`npm run start:worker:ppt`, pptPipelineWorker.ts)
 *      with PPT_WORKER_EMBEDDED=false on the server — the original design,
 *      for when PDF rasterization load ever justifies separate scaling.
 *
 * Running both at once is harmless (they share the queue; concurrency adds up).
 */
import { Worker, type Job } from 'bullmq';
import { Emitter } from '@socket.io/redis-emitter';
import { redisPublisher } from '../config/redis';
import { bucket } from '../config/firebase';
import AiGeneration from '../models/AiGeneration';
import TeachingKnowledgeGraphModel from '../models/TeachingKnowledgeGraph';
import { AiOrchestratorService } from '../services/aiOrchestrator';
import type { PipelineContext } from '../services/aiOrchestrator';
import { uploadArtifact } from '../services/aiContent/artifactStore';
import {
  buildPptPlanningPipeline,
  buildPptGenerationPipeline,
  BLUEPRINT_PLANNING_STAGE,
  KNOWLEDGE_EXTRACTION_STAGE,
  RENDERING_STAGE,
  SLIDE_GENERATION_STAGE,
} from '../services/aiContent/ppt/pipelineDefinition';
import { coerceBlueprint, type LectureBlueprint } from '../services/aiContent/ppt/blueprint';
import { resolveTheme } from '../services/aiContent/ppt/theme/themeRegistry';
import type {
  GeneratedSlide,
  TeachingKnowledgeGraph as TeachingKnowledgeGraphShape,
} from '../services/aiOrchestrator/interfaces';
import type { RenderedArtifact } from '../services/aiContent/types';
import {
  bullmqConnection,
  PPT_PIPELINE_QUEUE_NAME,
  type PptPipelineJobData,
} from '../queues/pptPipelineQueue';
import type { UploadFile } from '../services/aiContent/types';

const CONCURRENCY = parseInt(process.env.PPT_WORKER_CONCURRENCY || '2', 10);

// Cross-process Socket.IO emitter — publishes to Redis in the exact wire
// format @socket.io/redis-adapter expects, so progress reaches clients whether
// this worker runs inside the API process or as its own process.
const socketEmitter = new Emitter(redisPublisher);

function emitProgress(ownerId: string, payload: Record<string, unknown>): void {
  try {
    socketEmitter.to(`user:${ownerId}`).emit('ai:generation:progress', payload);
  } catch (err) {
    // Best-effort — progress is also persisted to Mongo, so a socket hiccup
    // never blocks or fails the pipeline itself.
    console.warn('[pptWorker] progress emit failed:', err);
  }
}

async function loadStagedFile(
  stagedFileRef: PptPipelineJobData['stagedFileRef'],
): Promise<UploadFile | undefined> {
  if (!stagedFileRef) return undefined;
  const [buffer] = await bucket.file(stagedFileRef.storagePath).download();
  return {
    buffer,
    originalname: stagedFileRef.originalName,
    mimetype: stagedFileRef.mimeType,
    size: buffer.length,
  };
}

function deleteStagedFile(stagedFileRef: PptPipelineJobData['stagedFileRef']): void {
  if (!stagedFileRef) return;
  bucket
    .file(stagedFileRef.storagePath)
    .delete({ ignoreNotFound: true })
    .catch(() => {});
}

async function processJob(job: Job<PptPipelineJobData>): Promise<void> {
  const { generationId, ownerId, mode, options, stagedFileRef } = job.data;

  const doc = await AiGeneration.findById(generationId);
  if (!doc) {
    console.warn(`[pptWorker] AiGeneration ${generationId} not found — skipping job ${job.id}`);
    return;
  }
  // Cooperative cancel check: if the doc was already moved out of a
  // cancellable state (e.g. the cancel endpoint marked it 'failed' while this
  // job was still queued), don't do any work.
  if (doc.status === 'failed' && doc.error === 'Cancelled by user') {
    deleteStagedFile(stagedFileRef);
    return;
  }

  doc.status = 'processing';
  doc.jobId = String(job.id);
  await doc.save();
  emitProgress(ownerId, { generationId, status: 'processing', stage: 'starting' });

  // Fine-grained mid-stage progress (e.g. "Writing slide 7 of 15"): socket
  // events fire on every tick; Mongo writes are throttled so a 25-slide burst
  // doesn't hammer the shared cluster. Poll-based clients read stageDetail.
  let lastDetailPersist = 0;
  const progress = (detail: string, current?: number, total?: number) => {
    emitProgress(ownerId, { generationId, status: 'processing', stageDetail: detail, current, total });
    const now = Date.now();
    if (now - lastDetailPersist > 800) {
      lastDetailPersist = now;
      AiGeneration.updateOne({ _id: generationId }, { $set: { 'pipeline.stageDetail': detail } }).catch(() => {});
    }
  };

  try {
    const ctx: PipelineContext = { generationId, ownerId, mode, options: options as any, progress };
    const onStageProgress = (stage: { name: string; status: string }) => {
      emitProgress(ownerId, {
        generationId,
        status: 'processing',
        stage: stage.name,
        stageStatus: stage.status,
      });
      // A stage transition makes the previous stage's detail line stale.
      AiGeneration.updateOne({ _id: generationId }, { $set: { 'pipeline.stageDetail': '' } }).catch(() => {});
      job.updateProgress({ stage: stage.name, status: stage.status }).catch(() => {});
    };

    if (job.data.phase === 'generation') {
      // ── PHASE 2: the teacher approved the blueprint — generate the deck ──
      // The blueprint on the doc is the single source of truth; the knowledge
      // graph was persisted in phase 1, so no file/extraction is needed.
      const blueprint = coerceBlueprint(doc.blueprint);
      if (!doc.knowledgeGraphId) throw new Error('This generation has no knowledge graph to generate from.');
      const graphDoc = await TeachingKnowledgeGraphModel.findById(doc.knowledgeGraphId).lean();
      if (!graphDoc) {
        throw new Error('The extracted content behind this plan has expired. Please start a new generation.');
      }
      const graph = graphDoc.graph as TeachingKnowledgeGraphShape;

      const definition = buildPptGenerationPipeline(blueprint, graph);
      const { outputs } = await AiOrchestratorService.run(definition, ctx, { onProgress: onStageProgress });

      const slides = outputs[SLIDE_GENERATION_STAGE] as GeneratedSlide[];
      const render = outputs[RENDERING_STAGE] as RenderedArtifact & { previewHtml: string };
      const theme = resolveTheme((options as any)?.theme);

      const storagePath = `ai-content/${ownerId}/${generationId}.${render.ext}`;
      const stored = await uploadArtifact(render.buffer, storagePath, render.mimeType, {
        feature: 'ppt',
        createdBy: ownerId,
      });

      doc.status = 'completed';
      doc.title = blueprint.title;
      // __pptSchema:2 distinguishes this from the legacy flat SlideDeck shape
      // (contentJSON.slides[].layout) old pre-pipeline docs may still have —
      // aiContentController's getHistory/regenerate branch on this field.
      doc.contentJSON = { __pptSchema: 2, slides, themeId: theme.id, deckTitle: blueprint.title } as any;
      doc.artifactUrl = stored.url;
      doc.storagePath = stored.storagePath;
      doc.fileName = render.fileName;
      doc.mimeType = render.mimeType;
      doc.usedVision = graph.metadata?.usedVision ?? false;
      if (doc.pipeline) doc.pipeline.stageDetail = '';
      await doc.save();

      emitProgress(ownerId, { generationId, status: 'completed', artifactUrl: stored.url });
    } else {
      // ── PHASE 1: AI Lecture Planner — propose an editable blueprint ──────
      // (Also the default for legacy queued jobs that predate `phase`.)
      const file = await loadStagedFile(stagedFileRef);
      const definition = buildPptPlanningPipeline(file);
      const { outputs } = await AiOrchestratorService.run(definition, ctx, { onProgress: onStageProgress });

      const graph = outputs[KNOWLEDGE_EXTRACTION_STAGE] as TeachingKnowledgeGraphShape;
      const blueprint = outputs[BLUEPRINT_PLANNING_STAGE] as LectureBlueprint;

      doc.status = 'awaiting_approval';
      doc.title = blueprint.title;
      doc.blueprint = blueprint as any;
      doc.usedVision = graph.metadata?.usedVision ?? false;
      if (doc.pipeline) doc.pipeline.stageDetail = '';
      await doc.save();

      emitProgress(ownerId, { generationId, status: 'awaiting_approval' });
      // The knowledge graph is persisted (TeachingKnowledgeGraph collection),
      // so generation never needs the raw file again — safe to clean up now.
      deleteStagedFile(stagedFileRef);
    }
  } catch (err: any) {
    const message = err?.message || 'Generation failed';
    if (err?.cancelled) {
      // Already marked failed/"Cancelled by user" by the cancel endpoint —
      // don't overwrite, don't retry, just stop quietly.
      emitProgress(ownerId, { generationId, status: 'failed', error: message });
      deleteStagedFile(stagedFileRef);
      return;
    }

    // BullMQ retries while attemptsMade + 1 < opts.attempts (job.attemptsMade
    // counts PRIOR attempts inside the processor — verified against the
    // installed bullmq's shouldRetryJob). A doc must NOT be marked 'failed'
    // for an attempt that will be retried: the app polls status and would
    // show "Generation failed" to the teacher while the retry goes on to
    // succeed silently. Non-final failures park the doc back at 'queued'.
    // The worker's 'failed' event handler (startPptPipelineWorker) is the
    // authoritative final-failure marker, which also covers cases this
    // prediction can't see (UnrecoverableError, stall limits).
    const willRetry = job.attemptsMade + 1 < (job.opts.attempts ?? 1);
    console.error(
      `[pptWorker] Job ${job.id} (generation ${generationId}) attempt ${job.attemptsMade + 1} failed${willRetry ? ' — will retry' : ''}:`,
      err,
    );
    if (willRetry) {
      doc.status = 'queued';
      doc.error = undefined;
      if (doc.pipeline) doc.pipeline.stageDetail = 'Retrying after a temporary error…';
      await doc.save();
      emitProgress(ownerId, { generationId, status: 'queued', retrying: true });
      // Staged file intentionally NOT deleted — the retry needs it.
    } else {
      doc.status = 'failed';
      doc.error = message;
      await doc.save();
      emitProgress(ownerId, { generationId, status: 'failed', error: message });
      deleteStagedFile(stagedFileRef);
    }
    throw err; // let BullMQ apply its retry/backoff policy
  }
}

let workerInstance: Worker<PptPipelineJobData> | null = null;

/**
 * Start the queue consumer (idempotent — repeat calls return the existing
 * instance). Callers must have Mongo connected already; the BullMQ Redis
 * connection is owned by pptPipelineQueue.ts.
 */
export function startPptPipelineWorker(): Worker<PptPipelineJobData> {
  if (workerInstance) return workerInstance;

  const worker = new Worker<PptPipelineJobData>(PPT_PIPELINE_QUEUE_NAME, processJob, {
    connection: bullmqConnection,
    concurrency: CONCURRENCY,
  });

  worker.on('completed', (job) => {
    console.log(`[pptWorker] Job ${job.id} completed`);
  });
  // Authoritative final-failure marker: fires per attempt, but attemptsMade
  // has already been incremented by moveToFailed at this point, so
  // attemptsMade >= opts.attempts identifies the FINAL failure exactly. This
  // also catches terminal paths the processor's catch can't predict —
  // UnrecoverableError, stalled-beyond-limit jobs (worker crash mid-run) —
  // so no generation is ever stranded in 'queued'/'processing' forever.
  worker.on('failed', (job, err) => {
    console.error(`[pptWorker] Job ${job?.id} failed:`, err?.message);
    if (!job?.data?.generationId) return;
    const isFinal = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!isFinal) return;
    AiGeneration.updateOne(
      { _id: job.data.generationId, status: { $nin: ['completed', 'failed'] } },
      { $set: { status: 'failed', error: err?.message || 'Generation failed' } },
    )
      .then((res) => {
        if (res.modifiedCount > 0) {
          emitProgress(job.data.ownerId, {
            generationId: job.data.generationId,
            status: 'failed',
            error: err?.message || 'Generation failed',
          });
          deleteStagedFile(job.data.stagedFileRef);
        }
      })
      .catch(() => {});
  });

  console.log(`✅ [pptWorker] Listening on "${PPT_PIPELINE_QUEUE_NAME}" (concurrency=${CONCURRENCY})`);
  workerInstance = worker;
  return worker;
}

/** Graceful stop — waits for in-flight jobs to finish their current stage. */
export async function stopPptPipelineWorker(): Promise<void> {
  if (!workerInstance) return;
  const w = workerInstance;
  workerInstance = null;
  await w.close();
}
