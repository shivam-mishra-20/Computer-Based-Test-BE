import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * An organization asking the platform for a change: renew, upgrade, downgrade
 * or cancel.
 *
 * A REQUEST, never a change. Nothing here touches the subscription; platform
 * staff read it in the console and act through the lifecycle endpoints, which
 * is what keeps "an organization cannot grant itself a plan" true. One open
 * request per kind per organization — asking twice returns the open one.
 *
 * NOT tenant-scoped: created through the org-admin router for the principal's
 * own organization, read and resolved by platform staff.
 */

export type SubscriptionRequestKind = 'renewal' | 'upgrade' | 'downgrade' | 'cancellation';
export const SUBSCRIPTION_REQUEST_KINDS: SubscriptionRequestKind[] = ['renewal', 'upgrade', 'downgrade', 'cancellation'];

export interface ISubscriptionRequest extends Document {
  orgId: Types.ObjectId;
  kind: SubscriptionRequestKind;
  planKey?: string;
  billingInterval?: string;
  message?: string;
  status: 'open' | 'resolved' | 'declined';
  requestedBy?: { id?: string; name?: string; email?: string };
  resolvedBy?: { id?: string; role?: string };
  resolution?: string;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const subscriptionRequestSchema = new Schema<ISubscriptionRequest>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    kind: { type: String, enum: SUBSCRIPTION_REQUEST_KINDS, required: true },
    planKey: { type: String, lowercase: true, trim: true },
    billingInterval: { type: String },
    message: { type: String, maxlength: 1000 },
    status: { type: String, enum: ['open', 'resolved', 'declined'], default: 'open' },
    requestedBy: { type: { id: String, name: String, email: String }, required: false, _id: false },
    resolvedBy: { type: { id: String, role: String }, required: false, _id: false },
    resolution: { type: String, maxlength: 1000 },
    resolvedAt: { type: Date },
  },
  { timestamps: true, tenantScoped: false } as never,
);

// One OPEN request of each kind per organization.
subscriptionRequestSchema.index({ orgId: 1, kind: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });
subscriptionRequestSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model<ISubscriptionRequest>('SubscriptionRequest', subscriptionRequestSchema);
