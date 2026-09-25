/**
 * Mobile app builds, as the console sees them.
 *
 * ── What this owns ──────────────────────────────────────────────────────────
 * The RECORD and the RULES: whether a build may start, what it is called, that
 * two identical ones cannot run at once, and how a job moves between states.
 * The work itself — workspace, assets, EAS — belongs to the worker, and
 * nothing in this module spawns a process or waits on a network call to Expo.
 * An HTTP handler calling into here returns in milliseconds.
 *
 * ── Readiness is answered before anything is queued ─────────────────────────
 * Section 3 asks that a build which cannot succeed is never queued, and that
 * the reason is a sentence rather than a stack trace. Both matter for the same
 * reason: the person clicking the button is an administrator, and "Missing app
 * icon: icon.png" is something they can act on, while `ENOENT` forty minutes
 * into a Gradle run is something they have to escalate. So every condition
 * that can be checked cheaply is checked here, up front, and the refusal names
 * the field and the next action.
 */

import mongoose from 'mongoose';
import AppBuildJob, {
  LIVE_BUILD_STATUSES,
  type BuildArtifactType,
  type BuildPlatform,
  type BuildStatus,
  type IAppBuildJob,
} from '../../models/AppBuildJob';
import { withoutTenantScope } from '../tenancy/context';
import { getMobileConfig } from './mobileBuild';
import { nativeAssetState, syncAssetsReady } from './mobileAssets';
import { isEasConfigured } from './easClient';
import { profileNameFor } from './appBuildWorkspace';
import type { SelectableBuildProfile } from './mobileBuildRules';
import {
  DEFAULT_BUILD_MS,
  describeBuildProgress,
  expectedDurationFrom,
  type BuildProgressView,
} from './buildProgress';

export class BuildNotAllowed extends Error {
  readonly code = 'BUILD_NOT_ALLOWED';
  constructor(message: string, readonly problems: string[] = []) {
    super(message);
    this.name = 'BuildNotAllowed';
  }
}

export class BuildNotFound extends Error {
  readonly code = 'BUILD_NOT_FOUND';
  constructor() {
    super('Build not found');
    this.name = 'BuildNotFound';
  }
}

function orgModel() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../models/Org').default;
}

async function loadOrg(orgId: string): Promise<Record<string, any> | null> {
  if (!mongoose.Types.ObjectId.isValid(orgId)) return null;
  return withoutTenantScope('app-build:load-org', async () => orgModel().findById(orgId));
}

/* ══════════════════════════════════════════════════════════════════════════
   Readiness
   ══════════════════════════════════════════════════════════════════════════ */

export interface BuildReadiness {
  ready: boolean;
  /**
   * The profile these answers are about.
   *
   * Echoed back because the console asks for one and renders the result; a
   * panel that says "not ready" without saying what it was judged against is
   * the disagreement this field exists to make impossible.
   */
  profile: SelectableBuildProfile;
  /** Sentences an administrator can act on. Never a stack trace. */
  problems: string[];
  appVersion: string;
  slug: string;
  identity: {
    orgId: string;
    appName: string;
    androidPackage: string;
    iosBundleId: string;
    scheme: string;
    apiBaseUrl: string;
  } | null;
  assets: Awaited<ReturnType<typeof nativeAssetState>>;
  /** Whether this SERVER can build at all, as opposed to this organization. */
  easConfigured: boolean;
  /**
   * The organization's Expo project, if it has one yet.
   *
   * `connected: false` is not a fault — it means the first build will create
   * it. The console says exactly that, so nobody has to know what EAS is.
   */
  easProject: {
    connected: boolean;
    projectId: string | null;
    account: string | null;
    slug: string | null;
    provisionedAt: Date | null;
  };
}

/**
 * Everything that would stop a build, gathered in one pass.
 *
 * Deliberately returns all of them rather than the first: an administrator
 * fixing four things one refusal at a time is four round trips through a
 * console they did not want to be in.
 */
export async function buildReadiness(
  orgId: string,
  profile: SelectableBuildProfile = 'production',
): Promise<BuildReadiness> {
  const problems: string[] = [];

  const org = await loadOrg(orgId);
  if (!org) {
    return {
      ready: false,
      profile,
      problems: ['That organization no longer exists.'],
      appVersion: '',
      slug: '',
      identity: null,
      assets: [],
      easConfigured: isEasConfigured(),
      easProject: { connected: false, projectId: null, account: null, slug: null, provisionedAt: null },
    };
  }
  if (String(org.status ?? '').toUpperCase() !== 'ACTIVE') {
    problems.push(
      `This organization is ${String(org.status ?? 'not active').toLowerCase()}. Only an active organization can be built.`,
    );
  }

  // Before asking the validator, make the flag it reads true or false for the
  // right reason — see `syncAssetsReady`.
  await syncAssetsReady(orgId);

  const view = await getMobileConfig(orgId, profile);
  for (const issue of view.issues ?? []) {
    problems.push(issue.message ?? String(issue));
  }

  const assets = await nativeAssetState(orgId);
  for (const asset of assets) {
    if (!asset.present) {
      problems.push(`Missing ${asset.label.toLowerCase()}: ${asset.filename}. Upload it under Native assets.`);
    }
  }

  const easConfigured = isEasConfigured();
  if (!easConfigured) {
    problems.push(
      'This server is not connected to Expo, so it cannot start a cloud build. A developer must set EXPO_TOKEN on the build host.',
    );
  }

  // The EAS project is NOT a readiness problem.
  //
  // It used to be, and that was the wrong shape: it made an administrator
  // responsible for a concept they should never meet. The first build now
  // creates it (core/platform/easProvisioning.ts), so the console reports the
  // state and says what will happen rather than refusing.
  //
  // What IS still a problem is having no account to create it under, because
  // nothing can resolve that from the console.
  const easProject = String(org.mobile?.easProjectId ?? '').trim();
  if (!easProject && !String(process.env.EXPO_ACCOUNT ?? '').trim()) {
    problems.push(
      'This organization has no Expo project and this server has no Expo account configured to create one under. ' +
        'A developer must set EXPO_ACCOUNT on the build host.',
    );
  }

  const id = view.identity ?? ({} as Record<string, any>);
  return {
    ready: problems.length === 0,
    profile,
    problems,
    appVersion: String(org.mobile?.version ?? '1.0.0'),
    slug: String(id.slug ?? org.slug ?? ''),
    identity: view.identity
      ? {
          orgId: String(id.orgId ?? ''),
          appName: String(id.appName ?? ''),
          androidPackage: String(id.androidPackage ?? ''),
          iosBundleId: String(id.iosBundleId ?? ''),
          scheme: String(id.scheme ?? ''),
          apiBaseUrl: String(id.apiBaseUrl ?? ''),
        }
      : null,
    assets,
    easConfigured,
    easProject: {
      connected: Boolean(easProject),
      projectId: easProject || null,
      account: String(org.mobile?.easOwner ?? '') || null,
      slug: String(org.mobile?.easProjectSlug ?? '') || null,
      provisionedAt: org.mobile?.easProvisionedAt ?? null,
    },
  };
}

/** The email of the staff member who asked, for the history table. */
async function staffEmail(platformUserId: string): Promise<string> {
  if (!mongoose.Types.ObjectId.isValid(platformUserId)) return 'unknown';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const PlatformUser = require('../../models/PlatformUser').default;
  const staff = await withoutTenantScope('app-build:staff-email', async () =>
    PlatformUser.findById(platformUserId).select('email').lean(),
  );
  return String((staff as { email?: string } | null)?.email ?? 'unknown');
}

/* ══════════════════════════════════════════════════════════════════════════
   Creating a build
   ══════════════════════════════════════════════════════════════════════════ */

export interface StartBuildInput {
  orgId: string;
  platform: BuildPlatform;
  artifactType: BuildArtifactType;
  requestedBy: string;
  /** Optional: resolved from the staff record when the caller does not have it. */
  requestedByEmail?: string;
  /** Supersede a live build of the same shape instead of returning it. */
  force?: boolean;
  /**
   * What the artifact is for, which is the only thing that varies the rules.
   *
   * Defaults to `production`, so a caller that does not know about this — an
   * older console, a script — gets the strict answer it used to get.
   */
  appProfile?: SelectableBuildProfile;
}

export interface StartBuildResult {
  build: IAppBuildJob;
  /** False when an identical live build already existed and was returned. */
  created: boolean;
}

/**
 * The next `#n` for this organization.
 *
 * Read from the highest existing number rather than a counter document: the
 * unique index below is what actually prevents a collision that matters, and a
 * duplicate build NUMBER under a race is a cosmetic tie in a list, not a
 * second build.
 */
async function nextBuildNumber(orgId: string): Promise<number> {
  const latest = await withoutTenantScope('app-build:next-number', async () =>
    AppBuildJob.findOne({ orgId }).sort({ buildNumber: -1 }).select('buildNumber').lean(),
  );
  return ((latest as { buildNumber?: number } | null)?.buildNumber ?? 0) + 1;
}

/**
 * Create a build, or return the one already running.
 *
 * ── Why this is idempotent rather than guarded ──────────────────────────────
 * Section 6 lists six ways a duplicate arrives — a double click, a browser
 * retry, an API retry, two tabs, a worker retry, a dropped connection — and
 * five of them happen after the frontend has done everything it can. A
 * disabled button is a courtesy; the partial unique index on
 * `(orgId, platform, artifactType)` over live statuses is the guarantee,
 * because it is the database refusing to write the second row.
 *
 * The duplicate is not an error to the caller. Someone who clicked twice meant
 * to start one build and should be shown that build, so the second call
 * returns the first call's result with `created: false`.
 */
export async function startBuild(input: StartBuildInput): Promise<StartBuildResult> {
  const appProfile = input.appProfile ?? 'production';
  // Re-validated here rather than trusted from the readiness call the console
  // made: the browser could have asked about `preview`, been told it was
  // ready, and then posted a build. Whatever profile the build runs under is
  // the profile it is judged against, in the same request that creates it.
  const readiness = await buildReadiness(input.orgId, appProfile);
  if (!readiness.ready) {
    throw new BuildNotAllowed('This organization is not ready to build.', readiness.problems);
  }

  const org = await loadOrg(input.orgId);
  const slug = readiness.slug;

  const existing = await withoutTenantScope('app-build:find-live', async () =>
    AppBuildJob.findOne({
      orgId: input.orgId,
      platform: input.platform,
      artifactType: input.artifactType,
      status: { $in: LIVE_BUILD_STATUSES },
    }),
  );

  if (existing && !input.force) return { build: existing, created: false };

  if (existing && input.force) {
    // An explicit rebuild. The old row leaves the live set so the index frees
    // up, and records what replaced it rather than vanishing from the history.
    existing.status = 'cancelled';
    existing.cancelledAt = new Date();
    existing.statusMessage = 'Superseded by a newer build';
    await withoutTenantScope('app-build:supersede', async () => existing.save());
  }

  const doc = {
    buildNumber: await nextBuildNumber(input.orgId),
    orgId: new mongoose.Types.ObjectId(input.orgId),
    organizationSlug: slug,
    platform: input.platform,
    artifactType: input.artifactType,
    buildProfile: profileNameFor(slug, input.artifactType),
    // What the workspace will judge the configuration against, recorded on the
    // job so the worker cannot pick a different one later and so the history
    // shows which builds were internal.
    appProfile,
    appVersion: readiness.appVersion,
    requestedBy: new mongoose.Types.ObjectId(input.requestedBy),
    requestedByEmail: input.requestedByEmail || (await staffEmail(input.requestedBy)),
    status: 'queued' as BuildStatus,
    statusMessage: 'Waiting for a build worker',
    progress: 5,
    queuedAt: new Date(),
    resolvedIdentity: readiness.identity ?? undefined,
    easProjectId: org?.mobile?.easProjectId ? String(org.mobile.easProjectId) : undefined,
  };

  try {
    const created = await withoutTenantScope('app-build:create', async () => AppBuildJob.create(doc));
    if (input.force && existing) {
      existing.supersededBy = created._id as mongoose.Types.ObjectId;
      await withoutTenantScope('app-build:link-supersede', async () => existing.save());
    }
    return { build: created, created: true };
  } catch (err) {
    // The index fired: something else created the same live build between the
    // lookup above and this insert. That is the race the index exists for, and
    // the right answer is the build that won, not a failure.
    if ((err as { code?: number }).code === 11000) {
      const winner = await withoutTenantScope('app-build:find-winner', async () =>
        AppBuildJob.findOne({
          orgId: input.orgId,
          platform: input.platform,
          artifactType: input.artifactType,
          status: { $in: LIVE_BUILD_STATUSES },
        }),
      );
      if (winner) return { build: winner, created: false };
    }
    throw err;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Reading
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * What a browser is allowed to see.
 *
 * `errorDetail` is the reason this function exists. A failed EAS build's
 * output can run to thousands of lines and can contain the CLI's view of its
 * own environment; it is kept for whoever debugs the build and is never put in
 * a response body. Section 16 asks for a summary in the UI and the detail
 * server-side, and this is where that split is enforced rather than remembered.
 */
/* ══════════════════════════════════════════════════════════════════════════
   How long builds take
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Remembered for a few minutes, per organization and artifact.
 *
 * The console polls a running build every four seconds, and each poll wants
 * an expected duration. The answer only changes when a build finishes, which
 * happens a handful of times a day — so recomputing a median from the job
 * history on every poll would be a query per request for a number that is the
 * same as last time.
 */
const EXPECTED_TTL_MS = 5 * 60_000;
const expectedCache = new Map<string, { at: number; value: number }>();

async function recentDurations(filter: Record<string, unknown>, limit: number): Promise<number[]> {
  const rows = await withoutTenantScope('app-build:durations', async () =>
    AppBuildJob.find({ ...filter, status: 'completed', buildDurationMs: { $gt: 0 } })
      .sort({ completedAt: -1 })
      .limit(limit)
      .select('buildDurationMs')
      .lean(),
  );
  return (rows as { buildDurationMs?: number }[])
    .map((r) => Number(r.buildDurationMs))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * How long a compile like this one usually takes.
 *
 * Reads only durations — numbers, never another organization's identity — so
 * the platform-wide fallback leaks nothing. See `expectedDurationFrom` for the
 * order in which the history is trusted.
 */
export async function expectedBuildDuration(
  orgId: string,
  artifactType: BuildArtifactType,
): Promise<number> {
  const key = `${orgId}:${artifactType}`;
  const cached = expectedCache.get(key);
  if (cached && Date.now() - cached.at < EXPECTED_TTL_MS) return cached.value;

  try {
    const [own, platform] = await Promise.all([
      recentDurations({ orgId: new mongoose.Types.ObjectId(orgId), artifactType }, 10),
      recentDurations({ artifactType }, 30),
    ]);
    const value = expectedDurationFrom(own, platform, artifactType);
    expectedCache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    // An estimate is a courtesy. A failed lookup must never fail the request
    // that asked for a build's status.
    return DEFAULT_BUILD_MS[artifactType];
  }
}

/**
 * Where a build is, for the console's progress bar.
 *
 * Computed at READ time, from timestamps, rather than stored. The worker only
 * writes when something happens, which during a compile is once a minute at
 * best; the console reads every four seconds. Deriving the view per read is
 * what lets the bar move between the worker's writes without anyone storing a
 * number that is a guess.
 */
export function progressViewOf(
  job: IAppBuildJob,
  expectedBuildMs: number,
  now = Date.now(),
): BuildProgressView {
  return describeBuildProgress({
    status: job.status,
    storedProgress: job.progress,
    easStatus: job.easStatus,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    stepStartedAt: job.updatedAt,
    easSubmittedAt: job.easSubmittedAt,
    buildingStartedAt: job.buildingStartedAt,
    completedAt: job.completedAt,
    failedAt: job.failedAt,
    cancelledAt: job.cancelledAt,
    queuePosition: job.queuePosition,
    initialQueuePosition: job.initialQueuePosition,
    estimatedWaitSeconds: job.estimatedWaitSeconds,
    expectedBuildMs,
    now,
  });
}

/**
 * Builds as the console receives them, each with its progress view.
 *
 * One expected-duration lookup per organization and artifact type in the set,
 * not one per build — a history page of twenty-five builds is still at most a
 * couple of cached lookups.
 */
export async function publicBuildViews(jobs: IAppBuildJob[]): Promise<Record<string, unknown>[]> {
  const now = Date.now();
  const expected = new Map<string, number>();
  for (const job of jobs) {
    const key = `${String(job.orgId)}:${job.artifactType}`;
    if (!expected.has(key)) {
      expected.set(key, await expectedBuildDuration(String(job.orgId), job.artifactType));
    }
  }
  return jobs.map((job) =>
    publicBuildView(job, {
      expectedBuildMs: expected.get(`${String(job.orgId)}:${job.artifactType}`),
      now,
    }),
  );
}

export async function publicBuildViewOf(job: IAppBuildJob): Promise<Record<string, unknown>> {
  const [view] = await publicBuildViews([job]);
  return view;
}

export function publicBuildView(
  job: IAppBuildJob,
  context: { expectedBuildMs?: number; now?: number } = {},
): Record<string, unknown> {
  const expectedBuildMs = context.expectedBuildMs ?? DEFAULT_BUILD_MS[job.artifactType];
  return {
    progressView: progressViewOf(job, expectedBuildMs, context.now),
    // Timestamps the console formats itself ("Running 6m 12s"), exposed
    // because they are facts about the build rather than about anyone.
    easSubmittedAt: job.easSubmittedAt,
    buildingStartedAt: job.buildingStartedAt,
    buildDurationMs: job.buildDurationMs,
    id: String(job._id),
    buildNumber: job.buildNumber,
    orgId: String(job.orgId),
    organizationSlug: job.organizationSlug,
    platform: job.platform,
    artifactType: job.artifactType,
    buildProfile: job.buildProfile,
    appProfile: job.appProfile,
    appVersion: job.appVersion,
    requestedByEmail: job.requestedByEmail,
    status: job.status,
    statusMessage: job.statusMessage,
    progress: job.progress,
    easBuildId: job.easBuildId,
    easBuildUrl: job.easBuildUrl,
    artifactUrl: job.artifactUrl,
    artifactFilename: job.artifactFilename,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    resolvedIdentity: job.resolvedIdentity,
    generatedConfigHash: job.generatedConfigHash,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    failedAt: job.failedAt,
    cancelledAt: job.cancelledAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export async function listBuilds(orgId: string, limit = 25): Promise<IAppBuildJob[]> {
  return withoutTenantScope('app-build:list', async () =>
    AppBuildJob.find({ orgId }).sort({ createdAt: -1 }).limit(Math.min(Math.max(limit, 1), 100)),
  );
}

export async function getBuild(buildId: string): Promise<IAppBuildJob> {
  if (!mongoose.Types.ObjectId.isValid(buildId)) throw new BuildNotFound();
  const found = await withoutTenantScope('app-build:get', async () => AppBuildJob.findById(buildId));
  if (!found) throw new BuildNotFound();
  return found;
}

/** The most recent build of any shape, for the console's "Latest build" card. */
export async function latestBuild(orgId: string): Promise<IAppBuildJob | null> {
  return withoutTenantScope('app-build:latest', async () =>
    AppBuildJob.findOne({ orgId }).sort({ createdAt: -1 }),
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Transitions — the worker's vocabulary
   ══════════════════════════════════════════════════════════════════════════ */

export async function markProgress(
  buildId: string,
  patch: { status?: BuildStatus; statusMessage?: string; progress?: number } & Record<string, unknown>,
): Promise<void> {
  await withoutTenantScope('app-build:progress', async () =>
    AppBuildJob.updateOne({ _id: buildId }, { $set: patch }),
  );
}

export async function markFailed(
  buildId: string,
  input: { errorCode: string; errorMessage: string; errorDetail?: string },
): Promise<void> {
  await withoutTenantScope('app-build:failed', async () =>
    AppBuildJob.updateOne(
      { _id: buildId, status: { $in: LIVE_BUILD_STATUSES } },
      {
        $set: {
          status: 'failed',
          failedAt: new Date(),
          progress: 100,
          statusMessage: input.errorMessage,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          errorDetail: input.errorDetail,
        },
      },
    ),
  );
}

export async function markCompleted(
  buildId: string,
  input: { artifactUrl: string; artifactFilename: string },
): Promise<void> {
  await withoutTenantScope('app-build:completed', async () =>
    AppBuildJob.updateOne(
      { _id: buildId },
      {
        $set: {
          status: 'completed',
          completedAt: new Date(),
          progress: 100,
          statusMessage: 'Build completed',
          artifactUrl: input.artifactUrl,
          artifactFilename: input.artifactFilename,
        },
      },
    ),
  );
}

/**
 * Put back on the queue any build that is waiting for a worker that will never
 * come.
 *
 * ── The state this repairs ──────────────────────────────────────────────────
 * A BuildJob and its queue entry are written by two different systems, and the
 * document is the one that survives. Redis can be flushed, a job can be
 * dropped, and — the case that actually happened — a server can accept builds
 * for an hour before anybody notices the worker was never started. All of
 * those leave a row reading "queued / Waiting for a build worker" that nothing
 * will ever pick up, and no error anywhere, because nothing went wrong: the
 * work simply was not requested of anyone.
 *
 * ── Why this cannot double-build ────────────────────────────────────────────
 * The queue id is derived from the BuildJob id, so re-enqueueing a build that
 * IS queued collapses onto the existing entry. And a build that already
 * carries an `easBuildId` is on EAS right now — re-preparing it would start a
 * SECOND cloud build for one click, so it gets a poll instead.
 */
export async function reconcileOrphanedBuilds(): Promise<{ requeued: number; alreadyQueued: number }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { appBuildQueue, buildJobId, enqueuePrepare, enqueuePoll } = require('../../queues/appBuildQueue');

  const live = await withoutTenantScope('app-build:reconcile', async () =>
    AppBuildJob.find({ status: { $in: LIVE_BUILD_STATUSES } }),
  );

  let requeued = 0;
  let alreadyQueued = 0;

  for (const job of live) {
    const id = String(job._id);

    if (job.easBuildId) {
      // Already building on EAS. Only the poll may be missing.
      const pollExists = await appBuildQueue
        .getJob(`poll-${id}-0`)
        .catch(() => null);
      if (pollExists) {
        alreadyQueued++;
        continue;
      }
      await enqueuePoll(
        {
          buildId: id,
          orgId: String(job.orgId),
          platform: job.platform,
          artifactType: job.artifactType,
          easBuildId: job.easBuildId,
          pollCount: 0,
        },
        5_000,
      );
      requeued++;
      console.log(`[appBuilds] re-queued a status poll for build ${id} (already on EAS)`);
      continue;
    }

    const existing = await appBuildQueue.getJob(buildJobId(id)).catch(() => null);
    if (existing) {
      const state = await existing.getState().catch(() => null);
      if (state && state !== 'completed' && state !== 'failed') {
        alreadyQueued++;
        continue;
      }
    }

    await enqueuePrepare({
      buildId: id,
      orgId: String(job.orgId),
      platform: job.platform,
      artifactType: job.artifactType,
    });
    requeued++;
    console.log(`[appBuilds] re-queued build ${id} — it had no queue entry`);
  }

  return { requeued, alreadyQueued };
}

/**
 * Stop a build, if it can honestly be stopped.
 *
 * ── Why this refuses rather than always succeeding ──────────────────────────
 * Section 17 is explicit, and it is the right rule: a row that says
 * "cancelled" while Expo keeps compiling and later publishes an artifact is
 * two systems disagreeing about what happened. Whoever reads the console then
 * believes something false, and the artifact that appears belongs to a build
 * the record says never finished.
 *
 * So a build that has already reached EAS is only marked cancelled when EAS
 * accepts the cancellation. If it does not — the build is already finishing,
 * the CLI is unreachable — the record is left alone and the caller is told, and
 * the next poll will record whatever actually happened.
 */
export async function cancelBuild(buildId: string): Promise<{ cancelled: boolean; reason?: string }> {
  const job = await getBuild(buildId);
  if (!LIVE_BUILD_STATUSES.includes(job.status)) {
    return { cancelled: false, reason: `This build is already ${job.status}.` };
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { removeQueuedBuild } = require('../../queues/appBuildQueue');
  await removeQueuedBuild(buildId).catch(() => {});

  if (job.easBuildId) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { cancelEasBuild } = require('./easClient');
    const cwd = String(process.env.CLIENT_APP_PATH || process.cwd());
    const accepted = await cancelEasBuild(job.easBuildId, cwd).catch(() => false);
    if (!accepted) {
      return {
        cancelled: false,
        reason:
          'EAS would not stop this build — it is probably too far along. It will finish on its own, and the result will appear here.',
      };
    }
  }

  job.status = 'cancelled';
  job.cancelledAt = new Date();
  job.progress = 100;
  job.statusMessage = 'Cancelled';
  await withoutTenantScope('app-build:cancel', async () => job.save());
  return { cancelled: true };
}

/**
 * The file name the console offers, derived from what the build actually is.
 *
 * The extension follows the artifact type and nothing else — an AAB named
 * `.apk` is a file that installs nowhere and is rejected by Play, and it is
 * exactly the kind of mistake that survives until somebody needs it.
 */
export function artifactFilenameFor(job: {
  organizationSlug: string;
  appVersion: string;
  artifactType: BuildArtifactType;
  buildNumber: number;
}): string {
  const ext = job.artifactType === 'apk' ? 'apk' : 'aab';
  return `${job.organizationSlug}-${job.appVersion}-build${job.buildNumber}.${ext}`;
}
