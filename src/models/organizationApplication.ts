/**
 * The structured application an institute submits to join the platform.
 *
 * ── Why this is a sub-document and not a new collection ─────────────────────
 * `OrganizationRegistration` already exists, already has a lifecycle, already
 * carries the review trail, and is already what the console queue reads. A
 * second collection for "the detailed version" would mean two records per
 * institute, two lifecycles to keep in step, and an admin who has to know
 * which one is authoritative. So the detail hangs off the record that already
 * exists, and every historical registration stays valid with `application`
 * simply absent.
 *
 * ── What shape it takes, and why it is not free-form ────────────────────────
 * Every section below mirrors something the provisioning path already
 * consumes:
 *
 *   academic  →  `ConfigInput` in core/platform/organizations.ts
 *   policy    →  `OrgPolicy`
 *   branding  →  `Org.branding`
 *   modules   →  the entitlement add-on list
 *   staff     →  `onboardOrganization`'s `admin` block
 *
 * That correspondence is the entire point: approval maps this onto
 * `onboardOrganization()` without an admin re-typing anything. A field that
 * does not map to something the platform can actually apply would be a
 * question asked for nothing, so there are none.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * · Internal identifiers — orgId, slug, tenant ids. Generated at provisioning;
 *   an applicant-supplied one would be a tenant-selection primitive on a
 *   public endpoint.
 * · Integration CREDENTIALS. The application records which integrations an
 *   institute wants and who their provider is. Secrets are entered later in
 *   the console, through the existing AES-256-GCM sealed-secret path on
 *   `Integration`. A public form is the wrong place to receive an API key, and
 *   a registration document is the wrong place to store one.
 * · Branches as a first-class record. The backend has no `Branch` collection —
 *   only a `branchId` reference on rooms and policy. They are captured here so
 *   nothing is lost, and staff can act on them, but nothing pretends a branch
 *   registry exists.
 */

import { Schema } from 'mongoose';

/* ══════════════════════════════════════════════════════════════════════════
   Section shapes
   ══════════════════════════════════════════════════════════════════════════ */

export interface IApplicationOrganization {
  legalName?: string;
  /** Short form for tight UI, e.g. a home-screen label. */
  shortName?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  website?: string;
  organizationEmail?: string;
  supportEmail?: string;
  supportPhone?: string;
  /** e.g. "2026-27". Free text: academic year conventions differ by board. */
  academicYear?: string;
}

/**
 * Customer-facing branding.
 *
 * The three colours are REQUIRED by `validateMobileIdentity`; the splash
 * background is not, because it falls back to the platform default. Asset
 * fields hold upload ids, never URLs — see `OrganizationApplicationAsset`.
 */
export interface IApplicationBranding {
  appName?: string;
  shortAppName?: string;
  tagline?: string;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  splashBackgroundColor?: string;
  logoAssetId?: string;
  lightLogoAssetId?: string;
  darkLogoAssetId?: string;
  faviconAssetId?: string;
}

/** Mirrors `ConfigInput`, field for field, so approval is a direct mapping. */
export interface IApplicationAcademic {
  classLevels?: { key: string; label: string; aliases?: string[]; order?: number; isActive?: boolean }[];
  subjects?: { name: string; code?: string; order?: number; isActive?: boolean }[];
  rooms?: { name: string; capacity?: number; order?: number; branch?: string }[];
  batches?: { name: string; classLevels?: string[]; branch?: string; startDate?: string; endDate?: string; timing?: string }[];
  /**
   * Captured, not provisioned. There is no Branch collection; these are here
   * so the information is not lost between the application and whoever sets
   * the institute up.
   */
  branches?: { name: string; code?: string; address?: string; phone?: string; email?: string }[];
}

/** Mirrors `OrgPolicy`. Only fields that model actually supports. */
export interface IApplicationPolicy {
  exam?: {
    markingScheme?: { correct?: number; incorrect?: number; unattempted?: number };
    submitLockPercent?: number;
    defaultDurationMins?: number;
    lateEntryMins?: number;
    shuffleQuestions?: boolean;
    shuffleOptions?: boolean;
    antiCheat?: boolean;
    violationThreshold?: number;
  };
  grading?: { passPercentage?: number; gradeBands?: { grade: string; minPercent: number }[] };
  attendance?: {
    officialInTime?: string;
    officialOutTime?: string;
    graceMinutes?: number;
    fullDayMinHours?: number;
    halfTimeRequiredHours?: number;
  };
  leave?: { annualQuota?: number; requiresApproval?: boolean };
  locale?: { timezone?: string; currency?: string; language?: string };
  /** Working days as ISO weekday numbers, 1 = Monday. */
  workingDays?: number[];
}

/**
 * What the institute wants switched on.
 *
 * `addOns` are module KEYS from `moduleRegistry.ts`. The form presents them as
 * business features and translates; storing the key is what lets approval hand
 * them straight to the existing entitlement path rather than re-deriving them.
 */
export interface IApplicationModules {
  /** A named starting point — 'coaching', 'school', 'test-prep', 'custom'. */
  preset?: string;
  addOns?: string[];
}

export interface IApplicationStaff {
  admins?: {
    name: string;
    email: string;
    phone?: string;
    designation?: string;
    /** A role KEY from the system role set. Defaults to admin. */
    role?: string;
    /** True for the one account provisioning creates. Exactly one. */
    isPrimary?: boolean;
  }[];
}

/**
 * Which integrations the institute wants. NEVER their secrets.
 *
 * `accountRef` is a non-secret identifier — a sender id, a merchant code, a
 * from-address — the kind of thing printed on an invoice. Anything that
 * authenticates goes through the console into `Integration.credentials`,
 * which seals it.
 */
export interface IApplicationIntegrations {
  requested?: {
    type: string;
    provider?: string;
    accountRef?: string;
    notes?: string;
  }[];
}

export interface IApplicationCommercial {
  privacyPolicyUrl?: string;
  termsUrl?: string;
  legalEntityName?: string;
  gstNumber?: string;
  billingEmail?: string;
  billingAddress?: string;
  /**
   * What the institute ASKED for. Never an entitlement: the plan actually
   * granted is a commercial decision made in the console, and a public form
   * that could assign one would be a self-service upgrade endpoint.
   */
  planPreference?: string;
}

/** One uploaded brand asset. */
export interface IOrganizationApplicationAsset {
  assetId: string;
  /** 'logo' | 'logoLight' | 'logoDark' | 'favicon' */
  kind: string;
  filename: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  /**
   * Storage path, not a public URL. Served to staff through an authenticated
   * platform route; the applicant gets back only the id.
   */
  storagePath: string;
  uploadedAt: Date;
}

export interface IOrganizationApplication {
  organization?: IApplicationOrganization;
  branding?: IApplicationBranding;
  academic?: IApplicationAcademic;
  policy?: IApplicationPolicy;
  modules?: IApplicationModules;
  staff?: IApplicationStaff;
  integrations?: IApplicationIntegrations;
  commercial?: IApplicationCommercial;
  assets?: IOrganizationApplicationAsset[];
  /** Which steps the applicant has marked done. UI state, not a gate. */
  completedSteps?: string[];
  /** Schema version, so a later shape change can migrate rather than guess. */
  version?: number;
}

/* ══════════════════════════════════════════════════════════════════════════
   Schema
   ══════════════════════════════════════════════════════════════════════════ */

// `_id: false` throughout: these are value objects inside one document, and
// per-subdocument ids would be noise in every API response.
const assetSchema = new Schema<IOrganizationApplicationAsset>(
  {
    assetId: { type: String, required: true },
    kind: { type: String, required: true },
    filename: { type: String, required: true, maxlength: 260 },
    mimeType: { type: String, required: true, maxlength: 120 },
    bytes: { type: Number, required: true },
    width: { type: Number },
    height: { type: Number },
    storagePath: { type: String, required: true, maxlength: 512 },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

export const organizationApplicationSchema = new Schema<IOrganizationApplication>(
  {
    organization: {
      type: {
        legalName: { type: String, trim: true, maxlength: 200 },
        shortName: { type: String, trim: true, maxlength: 40 },
        addressLine1: { type: String, trim: true, maxlength: 200 },
        addressLine2: { type: String, trim: true, maxlength: 200 },
        city: { type: String, trim: true, maxlength: 120 },
        state: { type: String, trim: true, maxlength: 120 },
        country: { type: String, trim: true, maxlength: 120 },
        postalCode: { type: String, trim: true, maxlength: 20 },
        website: { type: String, trim: true, maxlength: 300 },
        organizationEmail: { type: String, trim: true, lowercase: true, maxlength: 254 },
        supportEmail: { type: String, trim: true, lowercase: true, maxlength: 254 },
        supportPhone: { type: String, trim: true, maxlength: 32 },
        academicYear: { type: String, trim: true, maxlength: 40 },
      },
      required: false,
      _id: false,
    },

    branding: {
      type: {
        appName: { type: String, trim: true, maxlength: 120 },
        shortAppName: { type: String, trim: true, maxlength: 40 },
        tagline: { type: String, trim: true, maxlength: 160 },
        primaryColor: { type: String, trim: true, maxlength: 9 },
        secondaryColor: { type: String, trim: true, maxlength: 9 },
        accentColor: { type: String, trim: true, maxlength: 9 },
        splashBackgroundColor: { type: String, trim: true, maxlength: 9 },
        logoAssetId: { type: String, trim: true, maxlength: 64 },
        lightLogoAssetId: { type: String, trim: true, maxlength: 64 },
        darkLogoAssetId: { type: String, trim: true, maxlength: 64 },
        faviconAssetId: { type: String, trim: true, maxlength: 64 },
      },
      required: false,
      _id: false,
    },

    // Mixed for the list sections: they are shaped by `ConfigInput`, validated
    // in the service before anything is written, and re-declaring the shape
    // here would be a second definition to keep in step with that one.
    academic: { type: Schema.Types.Mixed, default: undefined },
    policy: { type: Schema.Types.Mixed, default: undefined },
    modules: { type: Schema.Types.Mixed, default: undefined },
    staff: { type: Schema.Types.Mixed, default: undefined },
    integrations: { type: Schema.Types.Mixed, default: undefined },
    commercial: { type: Schema.Types.Mixed, default: undefined },

    assets: { type: [assetSchema], default: undefined },
    completedSteps: { type: [String], default: undefined },
    version: { type: Number, default: 1 },
  },
  { _id: false },
);

/* ══════════════════════════════════════════════════════════════════════════
   Lifecycle
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * ── The lifecycle, and why the old names survive ────────────────────────────
 *
 *   DRAFT ──► PENDING ──► UNDER_REVIEW ──► APPROVED ──► PROVISIONING
 *               │  ▲            │                            │
 *               │  └── INFO_REQUESTED                        ▼
 *               │                              READY_FOR_ACTIVATION ──► ACTIVATED
 *               └──────────► REJECTED
 *
 * `PENDING` is what the original registration flow called "submitted", and
 * every historical row carries it. Renaming it to SUBMITTED would have meant a
 * migration and a period where two names meant one thing, so the old name
 * stays and means exactly what it always did.
 *
 * `INFO_REQUESTED` is the same state the specification calls "Needs Changes".
 * One state, one name, already in use.
 *
 * `DRAFT` is new and is the only status a row can hold before the applicant
 * has submitted anything. It is invisible to the console queue by default:
 * a half-filled form is not work for staff.
 */
export const APPLICATION_STATUSES = [
  'DRAFT',
  'PENDING',
  'UNDER_REVIEW',
  'INFO_REQUESTED',
  'APPROVED',
  'PROVISIONING',
  'READY_FOR_ACTIVATION',
  'ACTIVATED',
  'REJECTED',
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Statuses a staff queue should show as needing attention. */
export const ACTIONABLE_STATUSES: ApplicationStatus[] = [
  'PENDING',
  'UNDER_REVIEW',
  'INFO_REQUESTED',
];
