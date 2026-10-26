import mongoose, { Document, Schema, Types } from 'mongoose';
// The statuses, what each permits and the transitions between them are defined
// ONCE, in core/subscriptions/lifecycle.ts. Re-exported here so existing
// imports keep working.
import {
  BILLING_INTERVALS,
  READABLE_STATUSES,
  SUBSCRIPTION_STATUSES,
  WRITABLE_STATUSES,
  type BillingInterval,
  type SubscriptionStatus,
} from '../core/subscriptions/lifecycle';

/**
 * An organization's commercial state.
 *
 * NOT tenant-scoped, deliberately. This collection is the platform's record of
 * what a customer bought, and it must be unreachable from tenant APIs — a
 * tenant that could write its own Subscription could grant itself every paid
 * module. Isolation here is by TOKEN AUDIENCE (only `/api/platform/*` may write
 * it), which is structural: a bug in tenant RBAC cannot reach it, because the
 * route is not mounted on the tenant surface at all.
 *
 * `suspended` degrades to read-only rather than locking the door. If a payment
 * fails on the morning of a board practice exam and five hundred students
 * cannot open their paper, that is not contract enforcement — it is the end of
 * a customer relationship. `past_due` keeps full access during the grace period
 * precisely so that never happens by accident.
 */

export { READABLE_STATUSES, SUBSCRIPTION_STATUSES, WRITABLE_STATUSES };
export type { SubscriptionStatus };

export interface ISubscription extends Document {
  orgId: Types.ObjectId;
  planId?: Types.ObjectId;
  /**
   * The plan TERMS this organization signed up to: a key and an immutable
   * PlanVersion. Editing a plan writes a new version, so it never changes what
   * an existing subscriber gets — moving them onto the new terms is an explicit
   * plan change. A subscription with only `planId` predates versioning and
   * follows the plan's current terms until it is pinned.
   */
  planKey?: string;
  planVersion?: number;
  billingInterval: BillingInterval;
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
  /** What lifting a suspension or cancellation returns to (lifecycle.ts). */
  resumeStatus?: SubscriptionStatus;
  cancelledAt?: Date;
  expiredAt?: Date;
  /**
   * The institute asked to stop at the end of its current trial or paid
   * period (self-serve, org-admin). The clock then cancels instead of starting
   * grace (lifecycle.ts). Any renewal — a payment, an activation, a trial —
   * clears it; so does the institute withdrawing it.
   */
  cancelAtPeriodEnd?: boolean;
  /** Who asked to cancel at period end, when, and why. Kept for the console. */
  cancellationRequest?: { at?: Date; by?: { id?: string; email?: string }; reason?: string };
  /**
   * Optimistic concurrency. Every lifecycle write is conditional on the
   * revision it read, so two staff actions — or a staff action and the clock —
   * racing on one subscription cannot both apply.
   */
  revision?: number;
  /**
   * When the lifecycle took this subscription over. Only a MANAGED subscription
   * has its status enforced (read-only after grace, when suspended or
   * cancelled), its limits enforced, and its dates advanced by the clock.
   *
   * Set by every lifecycle write (a trial, an activation, a payment, a plan
   * assignment, any staff decision). A subscription written before the
   * lifecycle existed has no such date and keeps exactly the access it had —
   * deploying this code changes nothing for it until staff act on it.
   */
  managedSince?: Date;
  /** The trial end the "trial ends soon" notice was sent for — once per trial end. */
  trialReminderFor?: Date;
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
    planKey: { type: String, lowercase: true, trim: true },
    planVersion: { type: Number },
    billingInterval: { type: String, enum: BILLING_INTERVALS, default: 'monthly' },
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
    resumeStatus: { type: String, enum: SUBSCRIPTION_STATUSES },
    cancelledAt: { type: Date },
    expiredAt: { type: Date },
    cancelAtPeriodEnd: { type: Boolean },
    cancellationRequest: {
      type: { at: Date, by: { type: { id: String, email: String }, _id: false }, reason: String },
      required: false,
      _id: false,
    },
    revision: { type: Number, default: 0 },
    managedSince: { type: Date },
    trialReminderFor: { type: Date },
    isPlatformOwned: { type: Boolean, default: false },
    notes: { type: String },
  },
  { timestamps: true, tenantScoped: false } as never,
);

// The sweep's query: what is due to change by itself.
subscriptionSchema.index({ status: 1, trialEndsAt: 1 });
subscriptionSchema.index({ status: 1, periodEnd: 1 });
subscriptionSchema.index({ status: 1, graceEndsAt: 1 });

export default mongoose.model<ISubscription>('Subscription', subscriptionSchema);
