import mongoose, { Document, Schema } from 'mongoose';

/**
 * The terms of one plan at one point in time. IMMUTABLE once written.
 *
 * ── Why versions ────────────────────────────────────────────────────────────
 * A Plan is edited in the console. If subscriptions read the Plan directly,
 * lowering Growth's student limit — or removing a module from it — would
 * silently change the deal for every customer already on Growth, which is
 * exactly the sort of change a customer notices first and forgives last.
 *
 * So the terms are frozen here. Editing a plan's terms writes version n+1 and
 * moves the plan's `currentVersion`; existing subscriptions stay pinned to the
 * version they were sold (`Subscription.planKey` + `planVersion`). Moving a
 * customer onto new terms is an explicit, audited plan change.
 *
 * GLOBAL, like Plan: the catalogue belongs to the platform.
 */

export interface IPlanVersion extends Document {
  planKey: string;
  version: number;
  name: string;
  /** Module keys included. Dependencies are expanded at resolution time. */
  modules: string[];
  /** -1 = unlimited; absent = not limited by this plan. */
  limits: Record<string, number>;
  price: {
    monthly?: number;
    annual?: number;
    setupFee?: number;
    currency: string;
  };
  /** Priced per customer (Enterprise): never self-selected, never shown with a price. */
  customPricing: boolean;
  trialDays: number;
  createdBy?: { id?: string; email?: string };
  changeNote?: string;
  createdAt: Date;
}

const planVersionSchema = new Schema<IPlanVersion>(
  {
    planKey: { type: String, required: true, lowercase: true, trim: true },
    version: { type: Number, required: true, min: 1 },
    name: { type: String, required: true },
    modules: [{ type: String }],
    limits: { type: Schema.Types.Mixed, default: () => ({}) },
    price: {
      type: {
        monthly: Number,
        annual: Number,
        setupFee: Number,
        currency: { type: String, default: 'INR' },
      },
      default: () => ({ currency: 'INR' }),
      _id: false,
    },
    customPricing: { type: Boolean, default: false },
    trialDays: { type: Number, default: 14 },
    createdBy: {
      type: { id: String, email: String },
      required: false,
      _id: false,
    },
    changeNote: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, tenantScoped: false } as never,
);

// One row per (plan, version). This is also what makes two simultaneous edits
// of one plan safe: both compute version n+1, and only one insert succeeds.
planVersionSchema.index({ planKey: 1, version: 1 }, { unique: true });

export default mongoose.model<IPlanVersion>('PlanVersion', planVersionSchema);
