/**
 * One request to build an organization's mobile app, and everything that
 * happened to it.
 *
 * ── Why this is a document and not just a queue job ─────────────────────────
 * A BullMQ job is working memory: it is removed on a retention timer, it holds
 * no history a console can page through, and it cannot answer "what was the
 * last APK we shipped this institute and who asked for it". The queue carries
 * the WORK; this carries the RECORD. The two are linked by `queueJobId`, and
 * the record outlives the job on purpose.
 *
 * ── `tenantScoped: false` ───────────────────────────────────────────────────
 * Like `OrganizationRegistration`, this is platform-plane data ABOUT an
 * organization rather than data belonging to one. It is created by platform
 * staff, read by platform staff, and never served to a tenant — so it carries
 * `orgId` as an ordinary indexed field rather than as a scoping key, and the
 * tenancy plugin is told to leave it alone. Scoping it would break the console,
 * whose requests carry no organization context of their own.
 *
 * ── The uniqueness rule ─────────────────────────────────────────────────────
 * A partial unique index refuses a SECOND live build for the same
 * organization + platform + artifact type. That is the backend half of "no
 * duplicate builds": a disabled button stops a double click and nothing else —
 * not a browser retry, not two staff in two tabs, not a client that resends on
 * a dropped connection. The index is the only thing that holds under all of
 * them, because it is the database refusing to write the second row.
 *
 * An explicit rebuild is expressed by finishing or cancelling the live one
 * first, or by passing `force`, which supersedes it — see `core/platform/appBuilds.ts`.
 */

import mongoose, { Document, Schema } from 'mongoose';

export const BUILD_PLATFORMS = ['android'] as const;
export type BuildPlatform = (typeof BUILD_PLATFORMS)[number];

/**
 * APK and AAB are different EAS build types, not the same binary renamed.
 * `apk` installs directly on a device; `app-bundle` is what Play accepts and
 * cannot be sideloaded. The mapping to `android.buildType` lives in
 * `core/platform/easBuildProfile.ts`.
 */
export const BUILD_ARTIFACT_TYPES = ['apk', 'aab'] as const;
export type BuildArtifactType = (typeof BUILD_ARTIFACT_TYPES)[number];

export const BUILD_STATUSES = [
  'queued',
  // Its own status, not a message on `preparing`: creating an organization's
  // EAS project is the one step that touches an external account and changes
  // something durable, so it is worth being able to see and count separately
  // from assembling a workspace.
  'provisioning_project',
  'preparing',
  'building',
  'completed',
  'failed',
  'cancelled',
] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];

/** Statuses from which a build may still change — what "live" means. */
export const LIVE_BUILD_STATUSES: BuildStatus[] = ['queued', 'provisioning_project', 'preparing', 'building'];

export interface IAppBuildJob extends Document {
  /** Sequential per organization, so the console can say "#12". */
  buildNumber: number;

  orgId: mongoose.Types.ObjectId;
  organizationSlug: string;

  platform: BuildPlatform;
  artifactType: BuildArtifactType;
  /** The eas.json profile this build ran under, e.g. `org-abc-institute-apk`. */
  buildProfile: string;
  appVersion: string;

  requestedBy: mongoose.Types.ObjectId;
  requestedByEmail: string;

  status: BuildStatus;
  /** One short line for the console — "Uploading to EAS", not a log tail. */
  statusMessage: string;
  /** 0–100. Coarse on purpose: EAS reports phases, not percentages. */
  progress: number;

  easProjectId?: string;
  easBuildId?: string;
  easBuildUrl?: string;

  artifactUrl?: string;
  artifactFilename?: string;
  /** When the signed artifact URL stops working, if the provider says. */
  artifactExpiresAt?: Date;

  queuedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  cancelledAt?: Date;

  errorCode?: string;
  /** Human-readable, safe to show. The detail goes in `errorDetail`. */
  errorMessage?: string;
  /** Server-side only. Never returned by the API — see `publicBuildView`. */
  errorDetail?: string;

  /**
   * A hash of the generated organization configuration. Two builds with the
   * same hash were built from the same identity, which is what makes
   * "did Organization A's build contain Organization B's package name"
   * answerable after the fact rather than only at the time.
   */
  generatedConfigHash?: string;
  /** The resolved identity, recorded BEFORE the build starts. See §10. */
  resolvedIdentity?: Record<string, unknown>;

  queueJobId?: string;
  /** Set when a newer build supersedes this one via `force`. */
  supersededBy?: mongoose.Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const appBuildJobSchema = new Schema<IAppBuildJob>(
  {
    buildNumber: { type: Number, required: true },

    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
    organizationSlug: { type: String, required: true },

    platform: { type: String, enum: BUILD_PLATFORMS, required: true },
    artifactType: { type: String, enum: BUILD_ARTIFACT_TYPES, required: true },
    buildProfile: { type: String, required: true },
    appVersion: { type: String, required: true },

    requestedBy: { type: Schema.Types.ObjectId, ref: 'PlatformUser', required: true },
    requestedByEmail: { type: String, required: true },

    status: { type: String, enum: BUILD_STATUSES, required: true, default: 'queued', index: true },
    statusMessage: { type: String, default: 'Waiting for a build worker' },
    progress: { type: Number, default: 0, min: 0, max: 100 },

    easProjectId: { type: String },
    easBuildId: { type: String, index: true },
    easBuildUrl: { type: String },

    artifactUrl: { type: String },
    artifactFilename: { type: String },
    artifactExpiresAt: { type: Date },

    queuedAt: { type: Date, default: Date.now },
    startedAt: { type: Date },
    completedAt: { type: Date },
    failedAt: { type: Date },
    cancelledAt: { type: Date },

    errorCode: { type: String },
    errorMessage: { type: String },
    errorDetail: { type: String },

    generatedConfigHash: { type: String },
    resolvedIdentity: { type: Schema.Types.Mixed },

    queueJobId: { type: String },
    supersededBy: { type: Schema.Types.ObjectId, ref: 'AppBuildJob' },
  },
  // Platform-plane, like OrganizationRegistration. See the header.
  { timestamps: true, tenantScoped: false } as never,
);

/** The console's list query: this organization's builds, newest first. */
appBuildJobSchema.index({ orgId: 1, createdAt: -1 });

/**
 * At most ONE live build per organization + platform + artifact type.
 *
 * Partial, so completed and failed rows do not collide — an institute has many
 * finished APK builds and may have only one in flight. This is the constraint
 * that makes build creation idempotent under retries; the service catches the
 * duplicate-key error and returns the existing build rather than failing.
 */
appBuildJobSchema.index(
  { orgId: 1, platform: 1, artifactType: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: LIVE_BUILD_STATUSES } },
    name: 'one_live_build_per_org_platform_artifact',
  },
);

const AppBuildJob = mongoose.model<IAppBuildJob>('AppBuildJob', appBuildJobSchema);
export default AppBuildJob;
