/**
 * The build worker: everything the administrator does not have to know.
 *
 * ── The whole pipeline, in one place ────────────────────────────────────────
 *   prepare  assemble a single-organization workspace from the app project,
 *            generate config/organizations/<slug>.js, generate eas.json with
 *            the right android.buildType, download the five native assets,
 *            prove the result describes THIS organization, then hand it to the
 *            EAS CLI non-interactively and record the build id.
 *   poll     ask EAS what that build is doing, translate its vocabulary into
 *            something a console can display, and either finish the job or ask
 *            again shortly.
 *
 * No step of that requires a terminal, a checkout, a config file somebody
 * edited, or an image somebody copied. That is the entire point of the
 * feature: the console is the interface and this is what is underneath it.
 *
 * ── Failures are translated, not dumped ─────────────────────────────────────
 * EAS reports failures as codes like `EAS_BUILD_GRADLE_BUILD_FAILED`. A
 * console that prints that has moved the problem rather than solved it, so
 * each one gets a sentence, and the raw output is stored on the BuildJob in a
 * field the API never returns. Section 16.
 */

import { Worker, type Job } from 'bullmq';
import { bullmqConnection } from '../queues/pptPipelineQueue';
import {
  APP_BUILD_QUEUE_NAME,
  JOB_POLL,
  JOB_PREPARE,
  enqueuePoll,
  type AppBuildJobData,
} from '../queues/appBuildQueue';
import AppBuildJob, { LIVE_BUILD_STATUSES } from '../models/AppBuildJob';
import {
  artifactFilenameFor,
  markCompleted,
  markFailed,
  markProgress,
} from '../core/platform/appBuilds';
import {
  discardWorkspace,
  prepareWorkspace,
  verifyWorkspaceIdentity,
} from '../core/platform/appBuildWorkspace';
import { getEasBuild, redactSecrets, startEasBuild } from '../core/platform/easClient';
import { normaliseEasDuration } from '../core/platform/buildProgress';
import { ensureEasProject, storedEasProject } from '../core/platform/easProvisioning';
import {
  pollContextRoot,
  rewriteOrganizationConfig,
  verifyWorkspaceDependencies,
} from '../core/platform/appBuildWorkspace';
import { withoutTenantScope } from '../core/tenancy/context';

const CONCURRENCY = Number(process.env.APP_BUILD_CONCURRENCY) || 2;

/** How long to keep asking. An Android build that has not finished in two
 *  hours has not finished; the record says so rather than polling forever. */
const MAX_POLLS = Number(process.env.APP_BUILD_MAX_POLLS) || 90;

function pollDelayMs(pollCount: number): number {
  // Nothing useful happens in the first minute, and a queued build can sit for
  // several. Start slow, settle at a minute.
  if (pollCount === 0) return 45_000;
  if (pollCount < 4) return 30_000;
  return 60_000;
}

/** EAS's vocabulary → what the console shows. Section 13. */
function describeEasStatus(status: string): { message: string; progress: number } {
  switch (status) {
    case 'NEW':
      return { message: 'Accepted by EAS', progress: 55 };
    case 'IN_QUEUE':
      return { message: 'Queued on EAS', progress: 60 };
    case 'IN_PROGRESS':
      return { message: 'Building', progress: 75 };
    case 'FINISHED':
      return { message: 'Finalizing', progress: 95 };
    default:
      return { message: 'Building', progress: 70 };
  }
}

/**
 * An EAS error code, as a sentence.
 *
 * The list is short on purpose: these are the failures that actually recur,
 * and inventing prose for codes nobody has seen would be guessing. Anything
 * unrecognised falls back to EAS's own message, which is at least true.
 */
function describeEasFailure(code: string | undefined, message: string | undefined): string {
  const known: Record<string, string> = {
    EAS_BUILD_GRADLE_BUILD_FAILED: 'The Android build failed while compiling the app.',
    EAS_BUILD_NPM_INSTALL_FAILED: 'The build failed while installing the app’s dependencies.',
    EAS_BUILD_UNKNOWN_FAIL_REASON: 'The build failed on EAS for a reason EAS did not name.',
    EAS_BUILD_UNKNOWN_GRADLE_ERROR: 'The Android build failed during native compilation.',
    EAS_BUILD_CREDENTIALS_SETUP_FAILED:
      'The build failed while setting up Android signing credentials on the Expo account.',
    EAS_BUILD_CONFIGURE_PROJECT_FAILED: 'The build failed while configuring the native project.',
    EAS_BUILD_PREBUILD_FAILED:
      'The build failed generating the native project — usually a missing or invalid app asset.',
  };
  if (code && known[code]) return known[code];
  if (message) return String(message).split('\n')[0].slice(0, 300);
  return 'The build failed on EAS.';
}

/** Has somebody cancelled this build while we were working? */
async function stillLive(buildId: string): Promise<boolean> {
  const doc = await withoutTenantScope('app-build:check-live', async () =>
    AppBuildJob.findById(buildId).select('status').lean(),
  );
  const status = (doc as { status?: string } | null)?.status;
  return Boolean(status && LIVE_BUILD_STATUSES.includes(status as never));
}

/* ══════════════════════════════════════════════════════════════════════════
   prepare
   ══════════════════════════════════════════════════════════════════════════ */

async function runPrepare(data: AppBuildJobData): Promise<void> {
  const { buildId } = data;
  if (!(await stillLive(buildId))) return;

  await markProgress(buildId, {
    status: 'preparing',
    statusMessage: 'Preparing build',
    progress: 10,
    startedAt: new Date(),
  });

  const job = await withoutTenantScope('app-build:load', async () => AppBuildJob.findById(buildId));
  if (!job) return;

  try {
    const workspace = await prepareWorkspace({
      orgId: String(job.orgId),
      buildId,
      artifactType: job.artifactType,
      appProfile: job.appProfile,
      onProgress: async (message) => {
        await markProgress(buildId, { statusMessage: message, progress: 25 });
      },
    });

    // ── The organization's EAS project ───────────────────────────────────
    //
    // Runs between writing the configuration and starting the build, because
    // it needs the first (the CLI reads the slug from it) and the second
    // cannot happen without it. An organization that already has a project
    // skips this entirely — `ensureEasProject` returns before spawning
    // anything — so the cost is paid once, on the first build, and never
    // again.
    const project = await (async () => {
      const already = await storedEasProject(String(job.orgId));
      if (already) return already;

      await markProgress(buildId, {
        status: 'provisioning_project',
        statusMessage: 'Preparing Expo project',
        progress: 30,
      });
      return ensureEasProject({
        orgId: String(job.orgId),
        organizationSlug: workspace.slug,
        workspaceRoot: workspace.root,
      });
    })();

    if (project.provisioned) {
      // The configuration written a moment ago predates the project, so it
      // does not name it. Regenerated rather than patched: the same function
      // that produced it produces it again, now with the id, and there is one
      // description of what an organization's build config looks like.
      await rewriteOrganizationConfig(workspace, String(job.orgId));
      console.log(
        `[appBuildWorker] build ${buildId} provisioned EAS project ${project.projectId} ` +
          `for @${project.account}/${project.slug}`,
      );
    }

    await markProgress(buildId, { easProjectId: project.projectId });

    // Section 10: prove what is about to be uploaded belongs to this
    // organization, and record it, BEFORE a build minute is spent.
    const identity = (job.resolvedIdentity ?? {}) as Record<string, string>;
    await verifyWorkspaceIdentity(workspace, {
      orgId: identity.orgId ?? '',
      androidPackage: identity.androidPackage ?? '',
      scheme: identity.scheme ?? '',
      appName: identity.appName ?? '',
    });

    // Every local dependency must still be a working package after upload.
    // This is where `@platform/client-core` losing its compiled entry point is
    // caught — before EAS installs it and fails in "Read app config".
    await verifyWorkspaceDependencies(workspace);

    console.log(
      `[appBuildWorker] build ${buildId} identity — org=${identity.orgId} slug=${workspace.slug} ` +
        `package=${identity.androidPackage} scheme=${identity.scheme} artifact=${job.artifactType} ` +
        `profile=${workspace.profileName} configHash=${workspace.configHash}`,
    );

    await markProgress(buildId, {
      status: 'preparing',
      statusMessage: 'Uploading to EAS',
      progress: 45,
      generatedConfigHash: workspace.configHash,
    });

    if (!(await stillLive(buildId))) {
      await discardWorkspace(buildId);
      return;
    }

    const started = await startEasBuild({
      cwd: workspace.root,
      profile: workspace.profileName,
      platform: 'android',
    });

    await markProgress(buildId, {
      status: 'building',
      statusMessage: 'Queued on EAS',
      progress: 55,
      easBuildId: started.id,
      easBuildUrl: started.buildUrl,
      easStatus: started.status || 'NEW',
      easSubmittedAt: new Date(),
    });

    // Deliberately not fatal. By this point EAS IS building — throwing here
    // would mark failed a build that is running, which is the one outcome
    // worse than a build nobody is watching. The id is recorded either way,
    // so the console can still open it on EAS.
    await enqueuePoll({ ...data, easBuildId: started.id, pollCount: 0 }, pollDelayMs(0)).catch((err) => {
      console.error(
        `[appBuildWorker] build ${buildId} is running on EAS but its status poll could not be scheduled:`,
        (err as Error)?.message,
      );
    });
  } catch (err) {
    const e = err as { code?: string; message?: string; detail?: string; problems?: string[] };
    await markFailed(buildId, {
      errorCode: e.code || 'PREPARE_FAILED',
      errorMessage: e.message || 'The build could not be prepared.',
      errorDetail: redactSecrets(e.detail || (err as Error)?.stack || ''),
    });
    throw err;
  } finally {
    // The workspace is only needed until EAS has the archive. Keeping it would
    // accumulate a copy of the app project per build.
    await discardWorkspace(buildId);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   poll
   ══════════════════════════════════════════════════════════════════════════ */

async function runPoll(data: AppBuildJobData): Promise<void> {
  const { buildId, easBuildId } = data;
  if (!easBuildId) return;
  if (!(await stillLive(buildId))) return;

  const pollCount = data.pollCount ?? 0;
  if (pollCount >= MAX_POLLS) {
    await markFailed(buildId, {
      errorCode: 'EAS_TIMEOUT',
      errorMessage: 'EAS did not finish this build in time. Open the build on EAS to see where it stopped.',
      errorDetail: `Gave up after ${pollCount} polls.`,
    });
    return;
  }

  const job = await withoutTenantScope('app-build:load-poll', async () => AppBuildJob.findById(buildId));
  if (!job) return;

  // A directory naming THIS project, and nothing else — see `pollContextRoot`.
  const cwd = await pollContextRoot(
    String(job.easProjectId || ''),
    job.organizationSlug,
  );

  let build;
  try {
    build = await getEasBuild(easBuildId, cwd);
  } catch (err) {
    const e = err as { code?: string; message?: string; detail?: string };
    // Retried by BullMQ. Only the final attempt reaches the worker's `failed`
    // handler, and this is what gives that failure the CLI's own words rather
    // than a stack trace through the bundle.
    await markProgress(buildId, {
      statusMessage: 'Checking the build status',
      errorCode: e.code,
      errorDetail: redactSecrets(e.detail || String(e.message || '')),
    });
    throw err;
  }

  if (build.status === 'FINISHED') {
    // How long the compile took, for the NEXT build's estimate. EAS's own
    // metric when it is usable; otherwise our observation of it, which is at
    // most one poll interval off at either end.
    const measured =
      normaliseEasDuration(build.buildDuration) ??
      (job.buildingStartedAt ? Date.now() - new Date(job.buildingStartedAt).getTime() : null);
    if (measured) {
      await markProgress(buildId, { easStatus: 'FINISHED', buildDurationMs: measured });
    }
    if (!build.artifactUrl) {
      await markFailed(buildId, {
        errorCode: 'EAS_NO_ARTIFACT',
        errorMessage: 'EAS reported the build finished but returned no file to download.',
        errorDetail: JSON.stringify(build),
      });
      return;
    }
    await markCompleted(buildId, {
      artifactUrl: build.artifactUrl,
      artifactFilename: artifactFilenameFor({
        organizationSlug: job.organizationSlug,
        appVersion: job.appVersion,
        artifactType: job.artifactType,
        buildNumber: job.buildNumber,
      }),
    });
    console.log(`[appBuildWorker] build ${buildId} completed (${job.artifactType})`);
    return;
  }

  if (build.status === 'ERRORED') {
    await markFailed(buildId, {
      errorCode: build.errorCode || 'EAS_BUILD_ERRORED',
      errorMessage: describeEasFailure(build.errorCode, build.errorMessage),
      errorDetail: redactSecrets(JSON.stringify(build, null, 2)),
    });
    return;
  }

  if (build.status === 'CANCELED') {
    await markProgress(buildId, {
      status: 'cancelled',
      statusMessage: 'Cancelled on EAS',
      progress: 100,
      cancelledAt: new Date(),
    });
    return;
  }

  const described = describeEasStatus(build.status);
  await markProgress(buildId, {
    statusMessage: described.message,
    progress: described.progress,
    easBuildUrl: build.buildUrl || job.easBuildUrl,
    easStatus: build.status,
    // Queue fields are written even when absent, so a build that has left the
    // queue does not keep showing the position it had while in it.
    queuePosition: build.status === 'IN_QUEUE' ? build.queuePosition : undefined,
    initialQueuePosition: build.initialQueuePosition ?? job.initialQueuePosition,
    estimatedWaitSeconds: build.status === 'IN_QUEUE' ? build.estimatedWaitTimeLeftSeconds : undefined,
    // The first poll that sees it compiling marks the start of the long phase.
    // Never overwritten, or every poll would restart the clock.
    ...(build.status === 'IN_PROGRESS' && !job.buildingStartedAt
      ? { buildingStartedAt: new Date() }
      : {}),
  });

  await enqueuePoll({ ...data, pollCount: pollCount + 1 }, pollDelayMs(pollCount + 1)).catch((err) => {
    console.error(`[appBuildWorker] could not schedule the next poll for ${buildId}:`, (err as Error)?.message);
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   Worker
   ══════════════════════════════════════════════════════════════════════════ */

let workerInstance: Worker<AppBuildJobData> | null = null;

async function processJob(job: Job<AppBuildJobData>): Promise<void> {
  if (job.name === JOB_PREPARE) return runPrepare(job.data);
  if (job.name === JOB_POLL) return runPoll(job.data);
}

export function startAppBuildWorker(): Worker<AppBuildJobData> {
  if (workerInstance) return workerInstance;

  const worker = new Worker<AppBuildJobData>(APP_BUILD_QUEUE_NAME, processJob, {
    connection: bullmqConnection,
    concurrency: CONCURRENCY,
  });

  worker.on('failed', (job, err) => {
    console.error(`[appBuildWorker] job ${job?.id} failed:`, err?.message);
    const buildId = job?.data?.buildId;
    if (!buildId) return;
    const isFinal = (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? 1);
    if (!isFinal) return;
    // The last word, for the paths the processor's own catch cannot reach —
    // a worker that died mid-job, a stalled job past its limit. Without this a
    // build sits in 'preparing' for ever and the console waits on it.
    markFailed(buildId, {
      errorCode: 'WORKER_FAILED',
      errorMessage: err?.message || 'The build worker stopped unexpectedly.',
      errorDetail: redactSecrets(err?.stack || ''),
    }).catch(() => {});
  });

  console.log(`✅ [appBuildWorker] Listening on "${APP_BUILD_QUEUE_NAME}" (concurrency=${CONCURRENCY})`);
  workerInstance = worker;
  return worker;
}

/**
 * The two stages, for tests.
 *
 * Exported so the safety test can drive the pipeline without standing up
 * BullMQ and Redis: the queue is BullMQ's code and is not what needs proving,
 * while the state machine inside these two functions is entirely ours.
 */
export const __test__ = { runPrepare, runPoll, describeEasFailure, describeEasStatus };

export async function stopAppBuildWorker(): Promise<void> {
  if (!workerInstance) return;
  const w = workerInstance;
  workerInstance = null;
  await w.close();
}
