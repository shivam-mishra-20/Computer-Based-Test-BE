import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * One Cashfree checkout for one invoice an organization pays online — a
 * renewal, an upgrade it ordered, or an invoice staff issued. The amount is
 * the invoice's balance when the order was created; paying it settles the
 * invoice through the same `settleInvoice` staff use (provider `cashfree`,
 * reference = Cashfree's payment id), which applies or extends the plan.
 * See core/billing/invoiceCheckout.ts.
 *
 *   pending ──paid (verified with Cashfree)──▶ paid ──settled──▶ (paymentId set)
 *      └──expired / failed / superseded
 *
 * Platform accounting: NOT tenant-scoped, retained when an organization is deleted.
 */

export type InvoiceCheckoutStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'superseded';

export interface IInvoiceCheckout extends Document {
  orgId: Types.ObjectId;
  invoiceId: Types.ObjectId;
  provider: 'cashfree';
  environment: 'sandbox' | 'production';
  orderId: string;
  cfOrderId?: string;
  paymentSessionId?: string;
  expiresAt?: Date;
  status: InvoiceCheckoutStatus;
  amountMinor: number;
  currency: string;
  invoiceNumber?: string;
  payment?: { cfPaymentId: string; method: string; group?: string; bankReference?: string; message?: string; amountMinor: number; paidAt: Date };
  providerStatus?: string;
  lastAttempt?: { status: string; message?: string; at?: Date };
  lastCheckedAt?: Date;
  lastCheckedBy?: 'tenant' | 'webhook' | 'staff' | 'system';
  paidAt?: Date;
  settledAt?: Date;
  /** The Payment the settlement recorded. */
  paymentId?: Types.ObjectId;
  settleError?: string;
  createdBy?: { id?: string; email?: string };
  createdAt: Date;
  updatedAt: Date;
}

const invoiceCheckoutSchema = new Schema<IInvoiceCheckout>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
    provider: { type: String, enum: ['cashfree'], default: 'cashfree' },
    environment: { type: String, enum: ['sandbox', 'production'], required: true },
    orderId: { type: String, required: true, maxlength: 45 },
    cfOrderId: { type: String },
    paymentSessionId: { type: String, select: false },
    expiresAt: { type: Date },
    status: { type: String, enum: ['pending', 'paid', 'failed', 'expired', 'superseded'], default: 'pending' },
    amountMinor: { type: Number, required: true, min: 100 },
    currency: { type: String, default: 'INR' },
    invoiceNumber: { type: String },
    payment: {
      type: { cfPaymentId: String, method: String, group: String, bankReference: String, message: String, amountMinor: Number, paidAt: Date },
      _id: false,
      required: false,
    },
    providerStatus: { type: String },
    lastAttempt: { type: { status: String, message: String, at: Date }, _id: false, required: false },
    lastCheckedAt: { type: Date },
    lastCheckedBy: { type: String, enum: ['tenant', 'webhook', 'staff', 'system'] },
    paidAt: { type: Date },
    settledAt: { type: Date },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
    settleError: { type: String, maxlength: 500 },
    createdBy: { type: { id: String, email: String }, _id: false, required: false },
  },
  { timestamps: true, tenantScoped: false } as never,
);

invoiceCheckoutSchema.index({ orderId: 1 }, { unique: true });
invoiceCheckoutSchema.index({ invoiceId: 1, createdAt: -1 });
invoiceCheckoutSchema.index({ orgId: 1, createdAt: -1 });

export default mongoose.model<IInvoiceCheckout>('InvoiceCheckout', invoiceCheckoutSchema);
