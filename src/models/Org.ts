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

export default mongoose.model<IOrg>('Org', orgSchema);
