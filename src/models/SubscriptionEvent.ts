import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * The history of one organization's subscription. APPEND-ONLY.
 *
 * Every status change, plan change, trial extension and payment lands here
 * with who did it and why. It answers the questions a billing dispute asks —
 * "when did they go read-only, who extended the trial, on what terms were they
 * sold" — without reconstructing them from logs.
 *
 * Staff actions are ALSO written to PlatformAudit (the platform-wide trail);
 * this collection is the per-subscription timeline the console shows, and it
 * includes what the clock did, which PlatformAudit does not.
 *
 * NOT tenant-scoped: written only by core/subscriptions, read by the console
 * and — filtered to the caller's own organization — by its admins.
 */

export interface ISubscriptionEvent extends Document {
  orgId: Types.ObjectId;
  subscriptionId?: Types.ObjectId;
  /** A lifecycle event (lifecycle.ts) or 'created' | 'plan_changed' | 'entitlements_changed' | 'platform_owned_changed'. */
  type: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  actor: {
    kind: 'platform' | 'system' | 'tenant';
    id?: string;
    email?: string;
    role?: string;
  };
  reason?: string;
  /** The lifecycle fields before and after, for the ones that changed. */
  changes?: Record<string, { from: unknown; to: unknown }>;
  metadata?: Record<string, unknown>;
  at: Date;
}

const subscriptionEventSchema = new Schema<ISubscriptionEvent>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription' },
    type: { type: String, required: true },
    fromStatus: { type: String, default: null },
    toStatus: { type: String, default: null },
    actor: {
      type: {
        kind: { type: String, enum: ['platform', 'system', 'tenant'], required: true },
        id: String,
        email: String,
        role: String,
      },
      required: true,
      _id: false,
    },
    reason: { type: String, maxlength: 1000 },
    changes: { type: Schema.Types.Mixed },
    metadata: { type: Schema.Types.Mixed },
    at: { type: Date, default: Date.now },
  },
  { timestamps: false, tenantScoped: false } as never,
);

subscriptionEventSchema.index({ orgId: 1, at: -1 });

export default mongoose.model<ISubscriptionEvent>('SubscriptionEvent', subscriptionEventSchema);
