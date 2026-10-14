/**
 * Background AI question generation for uploads (PDF / image).
 *
 * A scanned PDF is read by vision OCR one page at a time, and a single page
 * has taken anywhere from 20 s to 10 min on the vision endpoint. A request
 * held open that long fails at the proxy or in the browser long before the
 * work does, and the teacher loses the result. So an upload can instead
 * return a job id at once (202); the work continues here, the page polls
 * GET /ai/ai-generate/jobs/:jobId, and a finished job opens the same review →
 * save flow as before. Nothing is written to a question bank until the
 * teacher saves the questions they selected (POST /ai/save-questions).
 *
 * ── Where a job lives ───────────────────────────────────────────────────────
 * The job record is an ImportBatch with kind 'ai-generate': the record Smart
 * Import already uses for the same upload → processing → review → save flow
 * (and no new collection — the cluster is at its collection cap). Generated
 * questions are held with services/importPreview on that record, gzipped,
 * for the same review window.
 *
 * The work runs in the process that accepted the upload, as Smart Import's
 * does. The upload itself is not stored, so a restart mid-job cannot resume
 * it: the job stops beating, and the next status read reports it as
 * INTERRUPTED so the teacher can upload again — it never shows "processing"
 * forever.
 *
 * ── Expiry ──────────────────────────────────────────────────────────────────
 * Job records do not pile up: a sweep (sweepGenerationJobs) marks abandoned
 * jobs interrupted, deletes failed ones after AI_GENERATE_JOB_RETENTION_HOURS
 * (default 72), and deletes completed ones once their questions' review window
 * has passed. A teacher who saves or closes the review discards the job at once.
 */
import { AsyncResource } from 'node:async_hooks';
import { Types } from 'mongoose';
import { ImportBatch } from '../models/ImportedQuestion';
import { clearPreview, getPreview, newPreviewId, previewTtlMs, setPreview, type PreviewQuestion } from './importPreview';
import { withoutTenantScope } from '../core/tenancy/context';
import {
  EmptySourceError,
  OcrUnavailableError,
  generateQuestionsFromImage,
  generateQuestionsFromPDF,
  type AIGenerationOptions,
  type GeneratedQuestion,
  type GenerationProgress,
} from './aiQuestionGenerationService';

const setting = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
/** Jobs that run at once in this process; the rest wait their turn. */
const concurrency = () => setting('AI_GENERATE_JOB_CONCURRENCY', 2);
/** Unfinished jobs one teacher may have at a time. */
const perUserLimit = () => setting('AI_GENERATE_JOBS_PER_USER', 2);
/** Jobs this process will hold waiting for a free slot. */
const queueLimit = () => setting('AI_GENERATE_JOB_QUEUE_LIMIT', 20);
const heartbeatMs = () => setting('AI_GENERATE_JOB_HEARTBEAT_MS', 20_000);
/** No beat for this long means the process running the job is gone. */
const staleMs = () => setting('AI_GENERATE_JOB_STALE_MS', 120_000);
/** A job still running after this long is reported failed; a late result is discarded. */
const deadlineMs = () => setting('AI_GENERATE_JOB_TIMEOUT_MS', 45 * 60_000);
/** How long a failed job stays readable (the teacher sees why), then it is deleted. */
const retentionMs = () => setting('AI_GENERATE_JOB_RETENTION_HOURS', 72) * 3_600_000;
/** The sweep runs at most this often per process, driven by job traffic. */
const sweepEveryMs = () => setting('AI_GENERATE_JOB_SWEEP_MS', 10 * 60_000);

const INTERRUPTED_MESSAGE = 'Generation was interrupted (the server restarted). Please upload the file again.';
const interruptedFields = () => ({
  status: 'failed',
  stage: 'failed',
  errorCode: 'INTERRUPTED',
  errorMessage: INTERRUPTED_MESSAGE,
  processingCompleted: new Date(),
});

export type GenerationSource = 'pdf' | 'image';

/** The upload was refused before a job was created (too many running). */
export class JobRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'TOO_MANY_JOBS' | 'BUSY',
    message: string,
  ) {
    super(message);
    this.name = 'JobRejectedError';
  }
}

/** The preview rows the review screen shows — shared by the synchronous endpoints and jobs. */
export function toPreviewQuestions(questions: GeneratedQuestion[]): PreviewQuestion[] {
  return questions.map((q, index) => ({
    _id: newPreviewId(),
    questionNumber: index + 1,
    text: q.text,
    type: q.type,
    options: q.options,
    correctAnswerText: q.correctAnswerText,
    integerAnswer: q.integerAnswer,
    assertion: q.assertion,
    reason: q.reason,
    assertionIsTrue: q.assertionIsTrue,
    reasonIsTrue: q.reasonIsTrue,
    reasonExplainsAssertion: q.reasonExplainsAssertion,
    difficulty: q.difficulty || 'medium',
    confidence: q.confidence || 0.85,
    needsReview: q.needsReview || false,
    status: 'pending' as const,
  }));
}

/** What the generator was asked for — kept on the job and returned as `formData`. */
function storableOptions(options: AIGenerationOptions): Record<string, unknown> {
  // Not the author id or the institute's guidance text — only the form fields.
  const rest: Record<string, unknown> = { ...options };
  delete rest.createdBy;
  delete rest.guidance;
  return JSON.parse(JSON.stringify(rest));
}

// Jobs queued or running in THIS process. A job listed here is alive even if
// a beat was late (a long page render can hold the event loop for seconds).
const live = new Set<string>();
const waiting: Array<() => Promise<void>> = [];
let running = 0;

function pump(): void {
  while (running < concurrency() && waiting.length > 0) {
    const task = waiting.shift()!;
    running += 1;
    task().finally(() => {
      running -= 1;
      pump();
    });
  }
}

// Every write below is conditional on the job still being 'processing', so a
// job already reported as timed out, interrupted or discarded keeps that
// outcome and a late stage update can never overwrite a finished one.
async function updateRunning(jobId: string, set: Record<string, unknown>): Promise<boolean> {
  try {
    const result = await ImportBatch.updateOne({ _id: jobId, status: 'processing' }, { $set: set });
    return result.modifiedCount === 1;
  } catch (error) {
    console.error(`[AI Job ${jobId}] could not update the job:`, (error as Error).message);
    return false;
  }
}

async function failJob(jobId: string, code: string, message: string, detail?: string): Promise<void> {
  try {
    await ImportBatch.updateOne(
      { _id: jobId, status: 'processing' },
      {
        $set: {
          status: 'failed',
          stage: 'failed',
          errorCode: code,
          errorMessage: message,
          processingCompleted: new Date(),
        },
        $push: { processingErrors: { error: detail || message, timestamp: new Date() } },
      },
    );
  } catch (error) {
    console.error(`[AI Job ${jobId}] could not record the failure:`, (error as Error).message);
  }
}

async function runJob(
  jobId: string,
  source: GenerationSource,
  buffer: Buffer,
  options: AIGenerationOptions,
): Promise<void> {
  const startedAt = Date.now();
  // Discarded, or reported failed, while it waited: nothing to do.
  if (!(await updateRunning(jobId, { stage: 'reading', heartbeatAt: new Date() }))) return;

  const progress: GenerationProgress = {
    onStage: (stage, detail) => {
      void updateRunning(jobId, {
        stage,
        heartbeatAt: new Date(),
        ...(detail ? { currentPage: detail.page, totalPages: detail.total } : {}),
      });
    },
  };

  try {
    const result =
      source === 'pdf'
        ? await generateQuestionsFromPDF(buffer, options, progress)
        : await generateQuestionsFromImage(buffer, options, progress);
    const questions = toPreviewQuestions(result.questions);

    // Preview first, so a poll never sees 'completed' with nothing to review.
    await setPreview(jobId, questions);
    const completed = await updateRunning(jobId, {
      status: 'completed',
      stage: 'completed',
      totalQuestions: questions.length,
      processedQuestions: questions.length,
      generationMetadata: JSON.parse(JSON.stringify(result.metadata)),
      processingCompleted: new Date(),
      totalProcessingTime: Date.now() - startedAt,
      heartbeatAt: new Date(),
    });
    if (!completed) await clearPreview(jobId); // timed out or discarded meanwhile
    console.log(`[AI Job ${jobId}] ${completed ? 'completed' : 'finished after it was closed'}: ${questions.length} question(s) in ${Date.now() - startedAt} ms`);
  } catch (error) {
    if (error instanceof EmptySourceError || error instanceof OcrUnavailableError) {
      await failJob(jobId, error.code, error.message);
    } else {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[AI Job ${jobId}] generation failed:`, detail);
      await failJob(
        jobId,
        'GENERATION_FAILED',
        `Failed to generate questions from this ${source === 'pdf' ? 'PDF' : 'image'}.`,
        detail,
      );
    }
  }
}

export interface StartJobInput {
  source: GenerationSource;
  buffer: Buffer;
  originalFileName: string;
  options: AIGenerationOptions;
  userId: string;
}

/**
 * Create the job record and queue the work. Returns as soon as the record
 * exists — the caller answers 202 with the id.
 */
export async function startGenerationJob(input: StartJobInput): Promise<string> {
  maybeSweep();
  const unfinished = await ImportBatch.countDocuments({
    uploadedBy: input.userId,
    kind: 'ai-generate',
    status: 'processing',
    heartbeatAt: { $gte: new Date(Date.now() - staleMs()) },
  });
  if (unfinished >= perUserLimit()) {
    throw new JobRejectedError(
      429,
      'TOO_MANY_JOBS',
      `You already have ${unfinished} question generation${unfinished === 1 ? '' : 's'} running. Wait for one to finish, then try again.`,
    );
  }
  if (waiting.length >= queueLimit()) {
    throw new JobRejectedError(429, 'BUSY', 'Question generation is busy right now. Please try again in a few minutes.');
  }

  const now = new Date();
  const job = await ImportBatch.create({
    kind: 'ai-generate',
    fileName: `ai-generate-${now.getTime()}`,
    originalFileName: input.originalFileName || (input.source === 'pdf' ? 'upload.pdf' : 'upload'),
    fileType: input.source,
    fileSize: input.buffer.length,
    status: 'processing',
    stage: 'queued',
    processingStarted: now,
    heartbeatAt: now,
    ocrProvider: input.source === 'pdf' ? 'pdf-parse' : 'nvidia-vision',
    processingModel: 'ai-question-generation',
    generationOptions: storableOptions(input.options),
    uploadedBy: new Types.ObjectId(input.userId),
  });
  const jobId = String(job._id);
  live.add(jobId);

  // Created inside the request, so the beat and the deadline write under the
  // request's tenant context — a job's records are never touched from another.
  const beat = setInterval(() => {
    void updateRunning(jobId, { heartbeatAt: new Date() });
  }, heartbeatMs());
  const deadline = setTimeout(() => {
    void failJob(
      jobId,
      'TIMED_OUT',
      'Generation took too long and was stopped. Try a shorter document or fewer pages.',
    );
  }, deadlineMs());
  beat.unref?.();
  deadline.unref?.();

  // Bound to the uploading request's async context: the task may be started
  // later from another job's completion, which belongs to a different request
  // (and possibly a different organization).
  const task = AsyncResource.bind(async () => {
    try {
      await runJob(jobId, input.source, input.buffer, input.options);
    } catch (error) {
      console.error(`[AI Job ${jobId}] unexpected failure:`, error);
      await failJob(jobId, 'GENERATION_FAILED', 'Question generation failed unexpectedly.', (error as Error)?.message);
    } finally {
      clearInterval(beat);
      clearTimeout(deadline);
      live.delete(jobId);
    }
  });
  waiting.push(task);
  pump();
  return jobId;
}

export interface GenerationJobView {
  jobId: string;
  status: 'processing' | 'completed' | 'failed';
  stage: string;
  sourceType: GenerationSource;
  fileName: string;
  currentPage?: number;
  totalPages?: number;
  startedAt?: Date;
  finishedAt?: Date;
  error?: { code: string; message: string; detail?: string };
  /** Present once completed: the same payload the synchronous endpoint returns. */
  questions?: PreviewQuestion[];
  metadata?: Record<string, unknown>;
  formData?: Record<string, unknown>;
  /** Completed, but the review window has passed — generate again. */
  previewExpired?: boolean;
}

/** One teacher's job, or null when it is not theirs / does not exist. */
export async function getGenerationJob(jobId: string, userId: string): Promise<GenerationJobView | null> {
  maybeSweep();
  if (!Types.ObjectId.isValid(jobId)) return null;
  const filter = { _id: jobId, uploadedBy: userId, kind: 'ai-generate' };
  let job = await ImportBatch.findOne(filter).lean();
  if (!job) return null;

  const beatAge = Date.now() - new Date(job.heartbeatAt || job.createdAt).getTime();
  if (job.status === 'processing' && !live.has(jobId) && beatAge > staleMs()) {
    // Nothing has run it for a while: the process that held it is gone.
    await ImportBatch.updateOne(
      { ...filter, status: 'processing', heartbeatAt: job.heartbeatAt },
      { $set: interruptedFields() },
    );
    job = (await ImportBatch.findOne(filter).lean()) || job;
  }

  const view: GenerationJobView = {
    jobId,
    status: job.status === 'uploading' ? 'processing' : (job.status as GenerationJobView['status']),
    stage: job.stage || (job.status === 'processing' ? 'queued' : job.status),
    sourceType: job.fileType,
    fileName: job.originalFileName,
    currentPage: job.currentPage,
    totalPages: job.totalPages || undefined,
    startedAt: job.processingStarted,
    finishedAt: job.processingCompleted,
  };
  if (job.status === 'failed') {
    view.error = {
      code: job.errorCode || 'GENERATION_FAILED',
      message: job.errorMessage || 'Question generation failed.',
      detail: job.errorCode === 'GENERATION_FAILED' ? job.processingErrors?.[job.processingErrors.length - 1]?.error : undefined,
    };
  }
  if (job.status === 'completed') {
    const questions = await getPreview(jobId);
    view.questions = questions || [];
    view.previewExpired = !questions;
    view.metadata = job.generationMetadata;
    view.formData = job.generationOptions;
  }
  return view;
}

/**
 * Drop a job and its held questions (after the teacher saved or discarded
 * them). A job still running finishes its current call, then its result is
 * thrown away — the record it would complete no longer exists.
 */
export async function discardGenerationJob(jobId: string, userId: string): Promise<boolean> {
  if (!Types.ObjectId.isValid(jobId)) return false;
  const removed = await ImportBatch.findOneAndDelete({ _id: jobId, uploadedBy: userId, kind: 'ai-generate' });
  if (!removed) return false;
  await clearPreview(jobId);
  return true;
}

let lastSweepAt = 0;

/** Run the sweep in the background if this process has not run it recently. */
function maybeSweep(): void {
  const now = Date.now();
  if (now - lastSweepAt < sweepEveryMs()) return;
  lastSweepAt = now;
  sweepGenerationJobs(now).catch((error) =>
    console.error('[AI Job] sweep failed:', (error as Error).message),
  );
}

/**
 * Expire generation jobs nobody will come back for.
 *
 * - processing, no beat for the stale window, not running here → INTERRUPTED
 *   (the read path does the same for one job; this catches jobs never read again)
 * - failed (incl. interrupted / timed out), finished before the retention window → deleted
 * - completed, finished before the review window → deleted (its questions are already gone)
 *
 * It selects only by kind, status and age — never by content — across every
 * organization, so it runs outside the tenant scope, as a reviewed bypass.
 */
export async function sweepGenerationJobs(now = Date.now()): Promise<{ interrupted: number; deleted: number }> {
  return withoutTenantScope('ai-generate:sweep-expired-jobs', async () => {
    let interrupted = 0;
    const abandoned = await ImportBatch.find({
      kind: 'ai-generate',
      status: 'processing',
      heartbeatAt: { $lt: new Date(now - staleMs()) },
    })
      .select('_id heartbeatAt')
      .lean();
    for (const job of abandoned) {
      if (live.has(String(job._id))) continue;
      const result = await ImportBatch.updateOne(
        { _id: job._id, status: 'processing', heartbeatAt: job.heartbeatAt },
        { $set: interruptedFields() },
      );
      interrupted += result.modifiedCount;
    }

    const failedBefore = new Date(now - retentionMs());
    const completedBefore = new Date(now - previewTtlMs());
    const expired = await ImportBatch.find({
      kind: 'ai-generate',
      $or: [
        { status: 'failed', processingCompleted: { $lt: failedBefore } },
        { status: 'failed', processingCompleted: { $exists: false }, updatedAt: { $lt: failedBefore } },
        { status: 'completed', processingCompleted: { $lt: completedBefore } },
      ],
    })
      .select('_id')
      .lean();
    let deleted = 0;
    if (expired.length > 0) {
      const ids = expired.map((job) => job._id);
      deleted = (await ImportBatch.deleteMany({ _id: { $in: ids }, kind: 'ai-generate' })).deletedCount ?? 0;
      for (const id of ids) await clearPreview(id);
    }
    if (interrupted || deleted) console.log(`[AI Job] sweep: ${interrupted} interrupted, ${deleted} expired job(s) deleted`);
    return { interrupted, deleted };
  });
}
