import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * An organization's commercial state.
 *
 * NOT tenant-scoped, deliberately. This collection is the platform's record of
 * what a customer bought, and it must be unreachable from tenant APIs — a
 * tenant that could write its own Subscription could grant itself every paid
 * module. Isolation here is by TOKEN AUDIENCE (only `/api/platform/*` may write
 * it), which is structural: a bug in tenant RBAC cannot reach it, because the
 * route is not mounted on the tenant surface at all.
 */

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'suspended'
  | 'cancelled'
  | 'terminated';

export const SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
  'suspended',
  'cancelled',
  'terminated',
];

/**
 * Statuses under which the tenant may still WRITE.
 *
 * `suspended` degrades to read-only rather than locking the door. If a payment
 * fails on the morning of a board practice exam and five hundred students
 * cannot open their paper, that is not contract enforcement — it is the end of
 * a customer relationship. `past_due` keeps full access during the grace period
 * precisely so that never happens by accident.
 */
export const WRITABLE_STATUSES: SubscriptionStatus[] = ['trialing', 'active', 'past_due'];

/** Statuses under which the tenant may still READ and EXPORT their own data. */
export const READABLE_STATUSES: SubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
  'suspended',
  'cancelled',
];

export interface ISubscription extends Document {
  orgId: Types.ObjectId;
  planId?: Types.ObjectId;
  /** Modules bought outside the plan. */
  addOns: string[];
  /** Modules removed from the plan for this organization. */
  removals: string[];
  /**
   * Negotiated overrides applied LAST during resolution, so an Enterprise deal
   * never requires inventing a bespoke plan just to change one limit.
   */
  overrides: {
    modules?: string[];
    limits?: Record<string, number>;
  };
  status: SubscriptionStatus;
  periodStart?: Date;
  periodEnd?: Date;
  trialEndsAt?: Date;
  graceEndsAt?: Date;
  /**
   * Platform-owned organizations are never billed, never suspended and never
   * churn-reported. Org 000 (public learning) and Org 001 (Abhigyan) are not
   * customers, and commercial gating must never be able to switch off a feature
   * their staff use daily.
   */
  isPlatformOwned: boolean;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const subscriptionSchema = new Schema<ISubscription>(
  {
    // One active subscription per organization — enforced by the unique index
    // below rather than by convention, because two overlapping subscriptions
    // would make entitlement resolution non-deterministic.
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true, unique: true, index: true },
    planId: { type: Schema.Types.ObjectId, ref: 'Plan' },
    addOns: [{ type: String }],
    removals: [{ type: String }],
    overrides: {
      type: {
        modules: [{ type: String }],
        limits: { type: Schema.Types.Mixed },
      },
      required: false,
      _id: false,
    },
    status: { type: String, enum: SUBSCRIPTION_STATUSES, default: 'trialing', index: true },
    periodStart: { type: Date },
    periodEnd: { type: Date },
    trialEndsAt: { type: Date },
    graceEndsAt: { type: Date },
    isPlatformOwned: { type: Boolean, default: false },
    notes: { type: String },
  },
  { timestamps: true, tenantScoped: false } as never,
);

export default mongoose.model<ISubscription>('Subscription', subscriptionSchema);
