import mongoose, { Document, Schema } from 'mongoose';

/**
 * A sellable package: modules + limits + price.
 *
 * GLOBAL, not tenant-scoped — the catalogue is the platform's, and a plan
 * filtered by organization would be invisible to the organization considering
 * buying it.
 *
 * Prices live here rather than in the module registry because they change
 * without a deploy. Module *definitions* are code; module *packaging* is data.
 */

export interface IPlanLimits {
  students?: number;
  teachers?: number;
  admins?: number;
  storageGb?: number;
  aiGenerationsMonthly?: number;
  examsMonthly?: number;
  /** -1 means unlimited. Absent means "not limited by this plan". */
  [key: string]: number | undefined;
}

export interface IPlanPrice {
  monthly?: number;
  annual?: number;
  currency?: string;
  setupFee?: number;
}

export interface IPlan extends Document {
  key: string;
  name: string;
  description?: string;
  /** Module keys included. Dependencies are expanded at resolution time. */
  modules: string[];
  limits: IPlanLimits;
  price: IPlanPrice;
  /** Hidden plans still resolve for existing subscribers; they are just not sold. */
  isPublic: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const planSchema = new Schema<IPlan>(
  {
    key: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    description: { type: String },
    modules: [{ type: String }],
    limits: { type: Schema.Types.Mixed, default: () => ({}) },
    price: {
      type: {
        monthly: Number,
        annual: Number,
        currency: { type: String, default: 'INR' },
        setupFee: Number,
      },
      required: false,
      _id: false,
    },
    // A withdrawn plan must keep resolving for organizations already on it —
    // pulling a plan from sale cannot retroactively disable a paying customer.
    isPublic: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true, tenantScoped: false } as never,
);

export default mongoose.model<IPlan>('Plan', planSchema);
