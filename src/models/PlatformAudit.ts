import mongoose, { Document, Schema } from 'mongoose';

/**
 * Platform-staff actions, across every tenant.
 *
 * ── Why not reuse AuditLog ──────────────────────────────────────────────────
 * `AuditLog` is now tenant-scoped: the global plugin adds `orgId` and filters
 * every read by it. That is correct for tenant activity, and wrong for this —
 * platform actions are inherently cross-tenant ("listed all organizations",
 * "changed Org 002's plan"), and a scoped collection cannot answer "what did
 * this staff member do today" across customers.
 *
 * `AuditLog` also carries a 30-day TTL. A record of who changed a customer's
 * entitlements needs to outlive that by years, because the question is usually
 * asked during a billing dispute.
 *
 * ── Written for every mutation, without exception ───────────────────────────
 * Not because a regulator asked, but because the alternative is a customer
 * asking "who turned off our attendance module" and the honest answer being
 * "we cannot tell".
 */

export interface IPlatformAudit extends Document {
  /** PlatformUser who acted. Absent for system-initiated events. */
  actorId?: mongoose.Types.ObjectId;
  actorEmail?: string;
  actorRole?: string;
  action: string;
  /** Organization affected, when the action targets one. */
  orgId?: string;
  entity?: string;
  entityId?: string;
  /** Before/after for changes — the part that makes an audit useful. */
  changes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  ip?: string;
  createdAt: Date;
}

const platformAuditSchema = new Schema<IPlatformAudit>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'PlatformUser', index: true },
    actorEmail: { type: String },
    actorRole: { type: String },
    action: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    entity: { type: String, index: true },
    entityId: { type: String },
    changes: { type: Schema.Types.Mixed },
    metadata: { type: Schema.Types.Mixed },
    ip: { type: String },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    // Cross-tenant by definition — see the header.
    tenantScoped: false,
  } as never,
);

// The two questions actually asked: "what happened to this org" and
// "what did this person do".
platformAuditSchema.index({ orgId: 1, createdAt: -1 });
platformAuditSchema.index({ actorId: 1, createdAt: -1 });

// Deliberately NO TTL. See the header.

export default mongoose.model<IPlatformAudit>('PlatformAudit', platformAuditSchema);
