/**
 * Single queue backing the async AI PPT pipeline. `generate` (feature:'ppt')
 * enqueues a job and returns 202 immediately; `pptPipelineWorker.ts` (its own
 * process) consumes it and calls AiOrchestratorService.run(). Uses a dedicated
 * ioredis connection (not the app-wide redisClient/redisPublisher used for
 * Socket.IO/rate-limiting) per BullMQ's guidance to avoid blocking-command
 * contention on a shared connection.
 */
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

// BullMQ rejects ':' in queue names (it uses that character internally for
// Redis key namespacing) — a colon here throws at construction time, which
// crashes the whole server on boot since this module is imported transitively
// from app.ts, not just when a PPT generation actually runs.
//
// AI_QUEUE_NAME env override: local dev and production share the same Redis,
// so without distinct names a stale deployed worker steals (and fails) jobs
// enqueued by a newer local server, and vice versa. Set a distinct value in
// the local .env (e.g. ai-pipeline-dev); leave production on the default.
export const PPT_PIPELINE_QUEUE_NAME = (process.env.AI_QUEUE_NAME || 'ai-ppt-pipeline').replace(/:/g, '-');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// BullMQ requires these two options on any connection it manages.
export const bullmqConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export interface PptPipelineJobData {
  generationId: string;
  ownerId: string;
  /** Which generator this job runs. Absent = 'ppt' (legacy queued jobs).
   * 'question_paper' jobs skip the ppt pipeline entirely — the worker runs
   * the paper generator (extract → questions → checkpoint → PDF → upload)
   * with the same retry/parking/cancel semantics. */
  feature?: 'ppt' | 'question_paper';
  /** v6 modes; legacy v4/v5 strings may arrive on old queued jobs — the
   * worker normalizes via normalizePptMode(). */
  mode: string;
  /** 'planning' (default when absent, incl. pre-blueprint legacy jobs) runs
   * the AI Lecture Planner and stops at status 'awaiting_approval';
   * 'generation' compiles the doc's APPROVED blueprint into the deck. */
  phase?: 'planning' | 'generation';
  /** Staging location of an uploaded source file, if any. */
  stagedFileRef?: {
    storagePath: string;
    mimeType: string;
    originalName: string;
  };
  /** PptOptions — `prompt` is folded in here by the caller before enqueueing. */
  options: Record<string, any>;
}

export const pptPipelineQueue = new Queue<PptPipelineJobData>(PPT_PIPELINE_QUEUE_NAME, {
  connection: bullmqConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60 }, // keep completed jobs 7d for debugging
    removeOnFail: { age: 30 * 24 * 60 * 60 },
  },
});

export async function enqueuePptPipelineJob(data: PptPipelineJobData): Promise<string> {
  const job = await pptPipelineQueue.add('generate', data);
  if (!job.id) throw new Error('Failed to enqueue PPT pipeline job (no job id returned)');
  return job.id;
}

/** Best-effort cancel: removes a queued/delayed job, or requests a running one
 * stop (BullMQ can't hard-kill an in-flight job; the worker checks isActive
 * cooperative flags between stages via AiOrchestratorService — see worker). */
export async function cancelPptPipelineJob(jobId: string): Promise<boolean> {
  const job = await pptPipelineQueue.getJob(jobId);
  if (!job) return false;
  const state = await job.getState();
  if (state === 'completed' || state === 'failed') return false;
  try {
    await job.remove();
    return true;
  } catch {
    // Active jobs can't be removed directly; caller falls back to marking the
    // AiGeneration doc failed — the worker will no-op on finishing a job whose
    // generation doc it can no longer find in a cancellable status.
    return false;
  }
}
