/**
 * The queue behind "Build App".
 *
 * ── Two job kinds, not one long one ─────────────────────────────────────────
 * An Android build takes tens of minutes on Expo's infrastructure. A worker
 * that starts one and then waits for it holds a slot for the whole time, loses
 * the build entirely if the process restarts, and turns "two institutes want a
 * build" into a queue. So the work is split:
 *
 *   prepare — assemble the workspace, upload, get a build id. Seconds.
 *   poll    — ask EAS what that build is doing now. Milliseconds.
 *
 * `prepare` finishes by scheduling the first `poll`, and each `poll` either
 * finishes the job or schedules the next one. Nothing is ever in flight for
 * longer than one short task, the worker restarts cleanly, and a build in
 * progress survives a deploy because its state lives in the BuildJob document
 * rather than in a stack frame.
 *
 * ── Why a separate queue from the AI pipeline ───────────────────────────────
 * Same Redis, same BullMQ, different queue name: a build is minutes of waiting
 * and a PPT generation is minutes of GPU, and giving them one queue means one
 * kind of work starves the other under load. The connection and the
 * conventions are shared; the lane is not.
 */

import { Queue } from 'bullmq';
import { bullmqConnection } from './pptPipelineQueue';
import type { BuildArtifactType, BuildPlatform } from '../models/AppBuildJob';

/** Local and deployed servers share a Redis, so the name is overridable for
 *  the same reason the AI queue's is — a stale deployed worker must not eat a
 *  developer's jobs. */
export const APP_BUILD_QUEUE_NAME = (process.env.APP_BUILD_QUEUE_NAME || 'app-builds').replace(/:/g, '-');

export interface AppBuildJobData {
  buildId: string;
  orgId: string;
  platform: BuildPlatform;
  artifactType: BuildArtifactType;
  /** Present on poll jobs. */
  easBuildId?: string;
  /** How many times this build has been polled, for backoff and for giving up. */
  pollCount?: number;
}

export const JOB_PREPARE = 'prepare';
export const JOB_POLL = 'poll';

export const appBuildQueue = new Queue<AppBuildJobData>(APP_BUILD_QUEUE_NAME, {
  connection: bullmqConnection,
  defaultJobOptions: {
    // A prepare that fails is retried twice: the common causes — a slow
    // network during upload, a transient Expo 5xx — are worth one more try,
    // and the ones that are not (a missing asset, an invalid package name)
    // never reach the queue because readiness refuses them first.
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60 },
    removeOnFail: { age: 30 * 24 * 60 * 60 },
  },
});

/** The queue id for a build. See `enqueuePrepare` for why there is no colon. */
export function buildJobId(buildId: string): string {
  return `build-${buildId}`;
}

export async function enqueuePrepare(data: AppBuildJobData): Promise<string> {
  const job = await appBuildQueue.add(JOB_PREPARE, data, {
    // The BuildJob id IS the job id. A second enqueue for the same build —
    // from a retried request, or a worker that re-ran — collapses onto the
    // same queue entry instead of starting a second upload.
    //
    // A DASH, not a colon: BullMQ reserves ':' for its own key namespacing and
    // refuses a custom id containing one, the same way it refuses a queue name
    // containing one. The failure is a 500 at enqueue time, long after the
    // BuildJob row has been written — see the note on `buildJobId`.
    jobId: buildJobId(data.buildId),
  });
  if (!job.id) throw new Error('Failed to enqueue build job (no job id returned)');
  return job.id;
}

/** Ask again in a while. Slow to start, because nothing happens in the first
 *  minute of an Android build that a poll would learn. */
export async function enqueuePoll(data: AppBuildJobData, delayMs: number): Promise<void> {
  await appBuildQueue.add(JOB_POLL, data, {
    jobId: `poll-${data.buildId}-${data.pollCount ?? 0}`,
    delay: delayMs,
    attempts: 5,
    backoff: { type: 'exponential', delay: 15000 },
  });
}

/** Remove any queued work for a build. Does not stop one already on EAS —
 *  that is `cancelEasBuild`, and the caller must do both. */
export async function removeQueuedBuild(buildId: string): Promise<void> {
  const job = await appBuildQueue.getJob(buildJobId(buildId));
  if (!job) return;
  const state = await job.getState().catch(() => null);
  if (state === 'completed' || state === 'failed') return;
  await job.remove().catch(() => {
    // Active jobs cannot be removed; the worker sees the cancelled status on
    // its next transition and stops.
  });
}
