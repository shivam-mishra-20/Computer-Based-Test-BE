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
  /** An existing EAS project, for an organization already on EAS. */
  easProjectId?: string;
  easOwner?: string;
  /** Behind the splash and the launch frame. */
  backgroundColor?: string;
  /**
   * Whether the five bundled native assets have been produced for this
   * organization. Set by staff, because the files live in the app repository
   * and this server cannot see them. See `docs/organization-finalization.md`.
   */
  assetsReady?: boolean;
  assetsNote?: string;
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
  mobile?: IOrgMobile;
  locale?: IOrgLocale;
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
        backgroundColor: String,
        assetsReady: Boolean,
        assetsNote: String,
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

export default mongoose.model<IOrg>('Org', orgSchema);
