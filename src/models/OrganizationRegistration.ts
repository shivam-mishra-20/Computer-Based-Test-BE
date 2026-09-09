/**
 * A prospective institute asking to join the platform.
 *
 * ── Why this is not an Org ──────────────────────────────────────────────────
 * An `Org` is a TENANT. The moment one exists it has system roles, an
 * entitlement snapshot, a slug that reserves a namespace, and every
 * tenant-scoped query in the system starts including it. Creating one from an
 * unauthenticated web form would mean anybody could mint tenants, and a
 * rejected applicant would leave a real organization behind to be cleaned up.
 *
 * So a registration is a REQUEST, in its own collection, with its own
 * lifecycle. It becomes an organization only when platform staff approve it,
 * and approval runs the existing `onboardOrganization()` — this file adds no
 * provisioning of its own.
 *
 * ── Shaped after ClassRequest ───────────────────────────────────────────────
 * The repository already has one public-form-to-staff-queue model, and this
 * follows its conventions rather than inventing new ones: uppercase status
 * enum, `submittedIp` recorded for abuse triage and never returned by the
 * public endpoint, review metadata alongside the payload.
 *
 * ── `tenantScoped: false` ───────────────────────────────────────────────────
 * A registration belongs to no organization — that is the entire point of it.
 * Scoping it would make it invisible to the platform deployment that has to
 * review it, and there is nothing to scope it BY until approval succeeds.
 */

import mongoose, { Document, Schema } from 'mongoose';

/**
 * Where the submission came from. `WEB` is the public marketing site; the enum
 * exists so a second front door can be told apart later without a migration.
 */
export type OrganizationRegistrationSource = 'WEB';

/**
 * ── The lifecycle ───────────────────────────────────────────────────────────
 *
 *   PENDING ──────────► APPROVED     (an Org now exists; orgId is set)
 *      │  ▲
 *      │  └── INFO_REQUESTED   (staff need more from the applicant)
 *      │
 *      └────────────► REJECTED
 *
 * `APPROVED` means an organization was created. It does NOT promise the
 * organization is fully configured: `onboardOrganization()` can return a
 * partial result (the 207 case), and that is recorded in
 * `provisioningComplete` and `provisioningSteps` rather than by inventing a
 * fifth status. A half-configured organization is still an approved
 * registration; what it needs is a retry, not a different verdict.
 */
export type OrganizationRegistrationStatus =
  | 'PENDING'
  | 'INFO_REQUESTED'
  | 'APPROVED'
  | 'REJECTED';

export const ORGANIZATION_REGISTRATION_STATUSES: OrganizationRegistrationStatus[] = [
  'PENDING',
  'INFO_REQUESTED',
  'APPROVED',
  'REJECTED',
];

/**
 * Deliberately coarse. This is a sales qualifier, not a taxonomy — a longer
 * list would make the public form slower to fill in and the data no more
 * useful, and `OTHER` plus the free-text message covers what it misses.
 */
export type OrganizationType =
  | 'COACHING_INSTITUTE'
  | 'SCHOOL'
  | 'COLLEGE'
  | 'UNIVERSITY'
  | 'TRAINING_CENTRE'
  | 'INDIVIDUAL_TUTOR'
  | 'OTHER';

export const ORGANIZATION_TYPES: OrganizationType[] = [
  'COACHING_INSTITUTE',
  'SCHOOL',
  'COLLEGE',
  'UNIVERSITY',
  'TRAINING_CENTRE',
  'INDIVIDUAL_TUTOR',
  'OTHER',
];

export interface IOrganizationRegistration extends Document {
  // ── What the applicant told us ────────────────────────────────────────────
  organizationName: string;
  organizationType: OrganizationType;
  contactName: string;
  designation?: string;
  email: string;
  phone: string;
  city: string;
  state?: string;
  country?: string;
  estimatedStudents?: number;
  estimatedTeachers?: number;
  message?: string;

  // ── Where it came from ────────────────────────────────────────────────────
  source: OrganizationRegistrationSource;
  /**
   * Abuse triage only. NEVER returned by the public endpoint, and returned to
   * platform staff only on the detail view.
   */
  submittedIp?: string;

  /**
   * A normalized fingerprint of "this institute, this contact", used to
   * collapse a double-click or a refresh into one row. Not unique-indexed: two
   * genuine submissions months apart are legitimate, and a hard constraint
   * would reject the second one with a 500 rather than a sensible message.
   */
  dedupeKey: string;

  // ── Review ────────────────────────────────────────────────────────────────
  status: OrganizationRegistrationStatus;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedByEmail?: string;
  reviewedAt?: Date;
  /** Staff-facing note. Rejection reason, or what was asked for. */
  reviewNote?: string;

  // ── What approval produced ────────────────────────────────────────────────
  /**
   * The tenant this registration became. Set only by the approval path, and
   * the reason repeated approval cannot create a second organization: the slug
   * is derived once, stored here, and reused — and `onboardOrganization()` is
   * itself idempotent on that slug.
   */
  orgId?: mongoose.Types.ObjectId;
  orgSlug?: string;
  provisionedAt?: Date;
  /** False when onboarding returned a partial result. Retry resumes it. */
  provisioningComplete?: boolean;
  provisioningSteps?: { step: string; ok: boolean; detail?: string }[];

  createdAt: Date;
  updatedAt: Date;
}

const OrganizationRegistrationSchema = new Schema<IOrganizationRegistration>(
  {
    organizationName: { type: String, required: true, trim: true, maxlength: 160 },
    organizationType: {
      type: String,
      enum: ORGANIZATION_TYPES,
      required: true,
      default: 'COACHING_INSTITUTE',
    },
    contactName: { type: String, required: true, trim: true, maxlength: 120 },
    designation: { type: String, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254, index: true },
    phone: { type: String, required: true, trim: true, maxlength: 32 },
    city: { type: String, required: true, trim: true, maxlength: 120 },
    state: { type: String, trim: true, maxlength: 120 },
    country: { type: String, trim: true, maxlength: 120, default: 'India' },
    estimatedStudents: { type: Number, min: 0, max: 1_000_000 },
    estimatedTeachers: { type: Number, min: 0, max: 100_000 },
    message: { type: String, trim: true, maxlength: 2000 },

    source: { type: String, enum: ['WEB'], required: true, default: 'WEB' },
    submittedIp: { type: String, trim: true, maxlength: 64 },
    dedupeKey: { type: String, required: true, index: true },

    status: {
      type: String,
      enum: ORGANIZATION_REGISTRATION_STATUSES,
      required: true,
      default: 'PENDING',
      index: true,
    },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'PlatformUser' },
    reviewedByEmail: { type: String, trim: true, maxlength: 254 },
    reviewedAt: { type: Date },
    reviewNote: { type: String, trim: true, maxlength: 2000 },

    orgId: { type: Schema.Types.ObjectId, ref: 'Org', index: true },
    orgSlug: { type: String, trim: true, maxlength: 120 },
    provisionedAt: { type: Date },
    provisioningComplete: { type: Boolean },
    provisioningSteps: [
      {
        _id: false,
        step: { type: String },
        ok: { type: Boolean },
        detail: { type: String },
      },
    ],
  },
  // A registration precedes every tenant, including its own. See the header.
  { timestamps: true, tenantScoped: false } as never,
);

// The queue is read newest-first and filtered by status; this is the index
// that serves both without a sort stage.
OrganizationRegistrationSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model<IOrganizationRegistration>(
  'OrganizationRegistration',
  OrganizationRegistrationSchema,
);
