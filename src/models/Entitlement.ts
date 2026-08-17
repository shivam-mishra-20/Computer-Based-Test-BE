import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * What an organization can do RIGHT NOW — a resolved, versioned snapshot.
 *
 * ── Why a snapshot and not a computation ────────────────────────────────────
 * Entitlement is checked on essentially every request. Computing it live would
 * mean loading the subscription, the plan, expanding dependencies and applying
 * overrides — three lookups and a graph walk — per call. A check that expensive
 * gets skipped by whoever optimizes the endpoint next, and the skip is not
 * noticed until it matters.
 *
 * Materializing it makes the correct path also the fast path.
 *
 * ── Why versioned ───────────────────────────────────────────────────────────
 * `version` increments on every resolution. Clients cache the manifest and
 * refetch when a socket announces a bump, and a billing dispute about "what was
 * this customer entitled to on 4 March" becomes answerable rather than
 * reconstructed.
 *
 * NOT tenant-scoped: written only by resolution, never by a tenant API.
 */

export interface IEntitlement extends Document {
  orgId: Types.ObjectId;
  /** Fully expanded — dependencies and core modules already folded in. */
  modules: string[];
  limits: Record<string, number>;
  /** Mirrors Subscription.status so a gate needs one read, not two. */
  status: string;
  /** False when the subscription is suspended/cancelled — writes are blocked. */
  writable: boolean;
  version: number;
  resolvedAt: Date;
  /** Why this resolution happened — invaluable when an entitlement surprises someone. */
  reason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const entitlementSchema = new Schema<IEntitlement>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true, unique: true, index: true },
    modules: [{ type: String }],
    limits: { type: Schema.Types.Mixed, default: () => ({}) },
    status: { type: String, required: true },
    writable: { type: Boolean, default: true },
    version: { type: Number, default: 1 },
    resolvedAt: { type: Date, default: Date.now },
    reason: { type: String },
  },
  { timestamps: true, tenantScoped: false } as never,
);

export default mongoose.model<IEntitlement>('Entitlement', entitlementSchema);
