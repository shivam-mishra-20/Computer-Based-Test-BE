import mongoose, { Document, Schema } from 'mongoose';

/**
 * The platform's own billing identity — the SELLER on every invoice.
 *
 * One document (key: 'platform'). Empty until platform staff fill it in, and
 * nothing here is defaulted to a real-looking value: a legal name, GSTIN or
 * tax rate the platform did not provide would put invented tax information on
 * a customer's invoice. Until `gstin` AND `gstRatePercent` are set, invoices
 * carry no GST and say plainly that they are not tax invoices
 * (core/billing/invoices.ts).
 *
 * Copied onto each invoice when it is ISSUED, so editing the profile never
 * rewrites an invoice already sent.
 *
 * Platform-owned and NOT tenant-scoped.
 */

export interface IBillingProfile extends Document {
  key: 'platform';
  legalName?: string;
  tradeName?: string;
  address?: string;
  city?: string;
  pincode?: string;
  /** GST state code of the seller's registered place of business, e.g. "24". */
  stateCode?: string;
  gstin?: string;
  pan?: string;
  /** Combined GST rate charged on subscriptions, e.g. 18. Unset = no GST is computed. */
  gstRatePercent?: number;
  /** SAC code printed on subscription lines. */
  sacCode?: string;
  /** Whether plan prices already include GST (false = GST is added on top). */
  planPricesIncludeGst: boolean;
  /** Invoice number prefix, e.g. "INV". The full number is ≤ 16 characters. */
  invoicePrefix: string;
  /** Days between issue and due date. */
  paymentTermsDays: number;
  email?: string;
  phone?: string;
  /** How to pay — printed on the invoice as given. */
  paymentInstructions?: string;
  updatedBy?: { id?: string; email?: string };
  createdAt: Date;
  updatedAt: Date;
}

const billingProfileSchema = new Schema<IBillingProfile>(
  {
    key: { type: String, enum: ['platform'], default: 'platform', unique: true },
    legalName: { type: String, trim: true, maxlength: 200 },
    tradeName: { type: String, trim: true, maxlength: 200 },
    address: { type: String, trim: true, maxlength: 500 },
    city: { type: String, trim: true, maxlength: 100 },
    pincode: { type: String, trim: true, maxlength: 10 },
    stateCode: { type: String, trim: true, maxlength: 2 },
    gstin: { type: String, trim: true, uppercase: true, maxlength: 15 },
    pan: { type: String, trim: true, uppercase: true, maxlength: 10 },
    gstRatePercent: { type: Number, min: 0, max: 28 },
    sacCode: { type: String, trim: true, maxlength: 8 },
    planPricesIncludeGst: { type: Boolean, default: false },
    invoicePrefix: { type: String, trim: true, uppercase: true, default: 'INV', maxlength: 6 },
    paymentTermsDays: { type: Number, default: 7, min: 0, max: 90 },
    email: { type: String, trim: true, lowercase: true, maxlength: 200 },
    phone: { type: String, trim: true, maxlength: 30 },
    paymentInstructions: { type: String, trim: true, maxlength: 1000 },
    updatedBy: { type: { id: String, email: String }, required: false, _id: false },
  },
  { timestamps: true, tenantScoped: false } as never,
);

export default mongoose.model<IBillingProfile>('BillingProfile', billingProfileSchema);
