import mongoose, { Document, Schema } from 'mongoose';

/**
 * An organization — THE tenant boundary.
 *
 * Every isolation guarantee in the platform is defined against `Org._id`.
 * Abhigyan Gurukul becomes Org 001; the public learning product becomes the
 * platform-owned Org 000; external customers are Org 002 onward.
 *
 * ── Not tenant-scoped ───────────────────────────────────────────────────────
 * This collection is the tenant REGISTRY, so it cannot itself be filtered by
 * tenant — a scoped query for organizations would be circular. `tenantScoped:
 * false` opts it out of the global plugin.
 */

export type OrgStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'suspended'
  | 'cancelled'
  | 'terminated';

/**
 * The organization's NATIVE identity — what a white-label mobile build bakes in.
 *
 * ── Why this is separate from branding ──────────────────────────────────────
 * Everything in `IOrgBranding` is applied at RUNTIME: change a colour and every
 * client picks it up on its next `/api/me/context`, with no build and no store
 * review. Nothing here works that way. An Android package name is Google Play's
 * primary key, a bundle id is Apple's, and a deep-link scheme is claimed by the
 * OS at install time — all three are decided before a binary exists and cannot
 * be changed afterwards without publishing a different application.
 *
 * Keeping them in one object makes that boundary visible: a field in `branding`
 * is free to change, a field in `mobile` costs a release. The console says so
 * on the screen, and `docs/organization-finalization.md` explains why.
 *
 * These are recorded here so the console can validate and generate a build
 * configuration from the organization record. The build itself still happens in
 * `client-platform-app`; nothing in this repository compiles an app.
 */
export interface IOrgMobile {
  /** Android `applicationId`. Unique across every organization. */
  androidPackage?: string;
  /** iOS bundle identifier. Unique across every organization. */
  iosBundleId?: string;
  /** Deep-link scheme, `scheme://`. Unique — the OS routes on it. */
  scheme?: string;
  /**
   * The API this organization's app talks to, including the `/api` suffix.
   * Empty means "not decided yet", which readiness reports rather than
   * defaulting — a shipped app pointed at a guess is worse than one that
   * refuses to start.
   */
  apiBaseUrl?: string;
  /** Marketing version for the next build, e.g. "1.0.0". */
  version?: string;
  /**
   * Only for an organization continuing an existing store listing, whose
   * numbering must not restart. Absent otherwise, so EAS manages it.
   */
  androidVersionCode?: number;
  /**
   * The organization's EAS project.
   *
   * Set by hand for an institute that already had one, and otherwise created
   * automatically by the first build — see core/platform/easProvisioning.ts.
   * Once present it is never re-created: it is the identity of the app on
   * Expo, and a second project would mean a second set of Android credentials
   * for the same store listing.
   */
  easProjectId?: string;
  easOwner?: string;
  /** The project slug on Expo, which is the organization slug. */
  easProjectSlug?: string;
  /** When it was created automatically. Absent for one entered by hand. */
  easProvisionedAt?: Date;
  /** Behind the splash and the launch frame. */
  backgroundColor?: string;
  /**
   * Whether the five bundled native assets have been produced for this
   * organization. Set by staff, because the files live in the app repository
   * and this server cannot see them. See `docs/organization-finalization.md`.
   */
  assetsReady?: boolean;
  assetsNote?: string;
  /**
   * The five images a build compiles in, as stored objects.
   *
   * Uploaded from the console, downloaded by the build worker. Present here
   * rather than only in the app repository because a worker has no checkout —
   * see core/platform/mobileAssets.ts.
   */
  nativeAssets?: {
    kind: string;
    storagePath: string;
    filename: string;
    bytes: number;
    uploadedAt: Date;
  }[];
}

/** Runtime branding, applied by both clients without a deploy. */
export interface IOrgBranding {
  logoUrl?: string;
  faviconUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  appName?: string;
  /** Second line under the name in navigation and on the landing page. */
  tagline?: string;
  accentColor?: string;
  /** Mobile splash background; app.json currently hardcodes #F7F7F7. */
  splashBackgroundColor?: string;
  splashImageUrl?: string;
  /** Shown on exported PDFs; replaces the hardcoded institute header. */
  documentHeader?: string;
  /** Printed under the header on exported PDFs. */
  documentAddress?: string;
  /** Footer/sender identity for outbound email. */
  emailFromName?: string;
}

/**
 * The app experience an organization defines for its own users.
 *
 * ── Why this is separate from `branding` ────────────────────────────────────
 * `branding` is RUNTIME theming that both web clients already apply without a
 * deploy — a logo URL, a couple of colours, a document header. This is the
 * MOBILE APP's identity: the words on a sign-in screen nobody has signed into
 * yet, which roles may create an account, the atmosphere behind the glass. It
 * is baked into a binary at build time and cannot be changed without a new
 * build, so conflating the two would make it look as though editing a colour
 * here reaches an installed app. It does not.
 *
 * Everything is optional. `resolveBrandConfig` in core/platform/mobileBuildRules
 * turns whatever is here into a complete configuration, so an organization that
 * has set nothing still gets a coherent app.
 */
export interface IOrgAppExperience {
  shortName?: string;
  palette?: {
    splashBackgroundColor?: string;
    successColor?: string;
    warningColor?: string;
    dangerColor?: string;
  };
  authCopy?: {
    welcomeTitle?: string;
    welcomeSubtitle?: string;
    loginMessage?: string;
    registerMessage?: string;
    supportEmail?: string;
    supportPhone?: string;
  };
  /** What the organization WANTS. What it gets is intersected with what the
   *  platform can authenticate — see SUPPORTED_AUTH_ROLES. */
  roles?: { student?: boolean; teacher?: boolean; parent?: boolean };
  registrationPolicy?: 'open' | 'approval' | 'invite';
}

/**
 * Where this organization's public registrations are written.
 *
 * ── Owned by the SERVER, never by a client ──────────────────────────────────
 * Everything in `appExperience` is something an institute chooses. This is not.
 * The collection name is assigned by `provisionRegistrationStore` in
 * core/registration/registrationStore.ts, it is never read from a request body,
 * a header or an onboarding form, and no API accepts it as input. A registration
 * request names an organization (as a routing hint) and nothing else; which
 * collection receives it is decided here, from this record, by the server.
 *
 * ── One collection per application, and why the name is reserved ───────────
 * `reg_<slug>`. The `reg_` prefix is a namespace no other collection on the
 * platform uses, and the validator refuses any name outside it — so no
 * misconfiguration, however it arises, can point registrations at `users`,
 * `orgs` or another tenant's data. The unique index below means no two
 * organizations can hold the same collection.
 *
 * ── The account is not here ──────────────────────────────────────────────────
 * This collection holds the REGISTRATION: who asked, as what, from which
 * application, under which policy, with what result. The account that login
 * authenticates lives in the platform's tenant-partitioned user store, created
 * pending or approved exactly as before — because login, token verification and
 * every approval screen read that store and only that store. `accountStore`
 * records that explicitly rather than leaving it implied.
 */
export interface IOrgRegistrationStore {
  collection: string;
  accountStore: 'platform-users';
  provisionedAt: Date;
}

/**
 * An organization deletion in progress — or one that stopped.
 *
 * Kept ON the organization, deliberately: the organization record is the last
 * thing deleted, so while any of its data remains, this record says so. A
 * deletion that fails half way leaves the organization visibly "deleting —
 * failed at step X" and resumable, never silently gone with tenant data left
 * behind. When it completes, the summary moves to the platform audit log and
 * the organization is removed.
 *
 * `incomplete` is the one state that outlives the data: everything in the
 * database and in storage is gone and verified, but an EXTERNAL resource (the
 * Expo project) still exists because the provider would not delete it. The
 * organization stays as a stripped record naming what remains, until someone
 * removes it and retries, or explicitly finishes without it.
 */
export interface IOrgDeletionStep {
  key: string;
  kind: 'documents' | 'collection' | 'storage' | 'external';
  label: string;
  planned: number;
  removed: number;
  done: boolean;
  /** External steps only: what the provider holds. */
  resource?: { provider: 'expo'; id: string; fullName: string };
  /**
   * External steps only. `deleted`: gone, confirmed by the provider.
   * `shared`: another organization references it, so it was never this one's
   * to delete. `orphaned`: this organization's, and still exists. `retained`:
   * still exists, and an operator finished the deletion without it.
   */
  outcome?: 'deleted' | 'shared' | 'orphaned' | 'retained';
  reason?: string;
}

export interface IOrgDeletion {
  status: 'running' | 'failed' | 'incomplete';
  requestedBy: string;
  requestedByEmail?: string;
  startedAt: Date;
  heartbeatAt: Date;
  attempts: number;
  steps: IOrgDeletionStep[];
  error?: string;
  failedStep?: string;
}

/**
 * The institute's own details — who to contact and where it is. Edited by the
 * institute's administrators (and platform staff); seeded from the approved
 * application. Contact details for STUDENTS live in the app experience's
 * support copy, which the apps show; these are the organization's own.
 */
export interface IOrgProfile {
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  website?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
}

export interface IOrgLocale {
  timezone?: string;
  currency?: string;
  language?: string;
}

export interface IOrg extends Document {
  name: string;
  /** URL-safe identifier. Resolves a subdomain to a tenant. */
  slug: string;
  status: OrgStatus;
  branding?: IOrgBranding;
  appExperience?: IOrgAppExperience;
  registrationStore?: IOrgRegistrationStore;
  deletion?: IOrgDeletion;
  mobile?: IOrgMobile;
  locale?: IOrgLocale;
  profile?: IOrgProfile;
  /** Hostnames that resolve to this org. Drives per-tenant CORS. */
  domains?: string[];
  /**
   * Platform-owned organizations are not customers: Org 000 (public learning)
   * and Org 001 (Abhigyan) are never billed, suspended or churn-reported.
   * Keeping them in the same collection means zero special-casing everywhere
   * else — only the commercial layer needs to know the difference.
   */
  isPlatformOwned?: boolean;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const orgSchema = new Schema<IOrg>(
  {
    name: { type: String, required: true, trim: true },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'slug must be lowercase alphanumeric with hyphens'],
    },
    status: {
      type: String,
      enum: ['trialing', 'active', 'past_due', 'suspended', 'cancelled', 'terminated'],
      default: 'active',
      index: true,
    },
    branding: {
      type: {
        logoUrl: String,
        faviconUrl: String,
        primaryColor: String,
        secondaryColor: String,
        appName: String,
        // The line under the name in the navbar and on the landing page.
        // Abhigyan's is "Tree of Knowledge"; an institute that sets nothing
        // gets no second line rather than someone else's.
        tagline: String,
        accentColor: String,
        splashBackgroundColor: String,
        splashImageUrl: String,
        documentHeader: String,
        documentAddress: String,
        emailFromName: String,
      },
      required: false,
      _id: false,
    },
    appExperience: {
      type: {
        shortName: String,
        palette: {
          type: {
            splashBackgroundColor: String,
            successColor: String,
            warningColor: String,
            dangerColor: String,
          },
          required: false,
          _id: false,
        },
        authCopy: {
          type: {
            welcomeTitle: String,
            welcomeSubtitle: String,
            loginMessage: String,
            registerMessage: String,
            supportEmail: String,
            supportPhone: String,
          },
          required: false,
          _id: false,
        },
        roles: {
          type: { student: Boolean, teacher: Boolean, parent: Boolean },
          required: false,
          _id: false,
        },
        registrationPolicy: { type: String, enum: ['open', 'approval', 'invite'] },
      },
      required: false,
      _id: false,
    },
    deletion: { type: Schema.Types.Mixed, required: false },
    registrationStore: {
      type: {
        collection: { type: String, match: /^reg_[a-z0-9_]{2,60}$/ },
        accountStore: { type: String, enum: ['platform-users'] },
        provisionedAt: Date,
      },
      required: false,
      _id: false,
    },
    mobile: {
      type: {
        androidPackage: String,
        iosBundleId: String,
        scheme: String,
        apiBaseUrl: String,
        version: String,
        androidVersionCode: Number,
        easProjectId: String,
        easOwner: String,
        easProjectSlug: String,
        easProvisionedAt: Date,
        backgroundColor: String,
        assetsReady: Boolean,
        assetsNote: String,
        // The five native images, once the server holds them. `assetsReady`
        // above used to be the only record that they existed anywhere, because
        // they lived in a repository this server could not see; it is now
        // derived from this list — see core/platform/mobileAssets.ts.
        nativeAssets: [
          {
            _id: false,
            kind: String,
            storagePath: String,
            filename: String,
            bytes: Number,
            uploadedAt: Date,
          },
        ],
      },
      required: false,
      _id: false,
    },
    profile: {
      type: {
        contactName: String,
        contactEmail: String,
        contactPhone: String,
        website: String,
        address: String,
        city: String,
        state: String,
        country: String,
      },
      required: false,
      _id: false,
    },
    locale: {
      type: {
        timezone: { type: String, default: 'Asia/Kolkata' },
        currency: { type: String, default: 'INR' },
        language: { type: String, default: 'English' },
      },
      required: false,
      _id: false,
    },
    domains: [{ type: String, lowercase: true, trim: true }],
    isPlatformOwned: { type: Boolean, default: false },
    notes: { type: String },
  },
  {
    timestamps: true,
    // The tenant registry cannot be tenant-filtered — see the header comment.
    tenantScoped: false,
  } as never,
);

orgSchema.index({ domains: 1 });

// Native identity is globally unique. Enforced in the service so the error can
// name the organization already holding it; indexed here so two concurrent
// saves cannot both win. Sparse, because most organizations have no mobile
// configuration yet and `null` is not a collision.
orgSchema.index({ 'mobile.androidPackage': 1 }, { unique: true, sparse: true });
orgSchema.index({ 'mobile.iosBundleId': 1 }, { unique: true, sparse: true });
orgSchema.index({ 'mobile.scheme': 1 }, { unique: true, sparse: true });
// Two applications can never share a registration collection. The server
// assigns the name, and this makes a collision impossible rather than unlikely.
orgSchema.index({ 'registrationStore.collection': 1 }, { unique: true, sparse: true });

export default mongoose.model<IOrg>('Org', orgSchema);
