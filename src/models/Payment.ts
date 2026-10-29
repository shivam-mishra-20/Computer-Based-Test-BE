import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * A payment the platform has evidence of — provider-neutral.
 *
 * Today every payment is `provider: 'manual'`: platform staff confirm a bank
 * transfer, UPI payment or cheque and record its reference. A gateway added
 * later writes the same record with its own `provider` and `providerPaymentId`,
 * from a VERIFIED webhook — never from a client saying "it worked".
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * (provider, orgId, reference) is unique. Recording the same reference twice —
 * a double click, a retried request, two staff members — produces one payment
 * and one period extension, not two. A future webhook gets the same guarantee
 * from its provider event id.
 *
 * Amounts are integer minor units (paise) so no rupee total is ever a float.
 *
 * NOT tenant-scoped: platform accounting. An organization's admins read their
 * own rows through core/subscriptions, filtered by the principal's orgId.
 */

export type PaymentStatus = 'confirmed' | 'failed';
export const PAYMENT_METHODS = ['bank_transfer', 'upi', 'cheque', 'cash', 'card', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface IPayment extends Document {
  orgId: Types.ObjectId;
  subscriptionId?: Types.ObjectId;
  /** The invoice this payment settles, when it settles one (in full — see core/billing/invoices). */
  invoiceId?: Types.ObjectId;
  provider: string;
  /** Bank / UPI / cheque reference, or the provider's payment id. */
  reference: string;
  providerPaymentId?: string;
  method: PaymentMethod;
  status: PaymentStatus;
  amountMinor: number;
  currency: string;
  receivedAt: Date;
  /** The service period this payment covers, once applied. */
  periodStart?: Date;
  periodEnd?: Date;
  /** Whether the payment has been applied to the subscription's lifecycle. */
  applied: boolean;
  appliedAt?: Date;
  /**
   * A short claim held while the payment is being applied, so two requests
   * carrying the same reference cannot both extend the period. A claim older
   * than two minutes is treated as abandoned.
   */
  applyingAt?: Date | null;
  /** Why it was not applied (e.g. the subscription could not take a payment). */
  applyError?: string;
  failureReason?: string;
  recordedBy?: { id?: string; email?: string; role?: string };
  notes?: string;
  /**
   * Where a gateway holds this money (provider `cashfree`): the order it was
   * paid on, or the auto-pay mandate charge. What a refund is sent against.
   */
  gateway?: { kind: 'order' | 'mandate'; orderId?: string; subscriptionId?: string; chargePaymentId?: string };
  /** Returned through refunds (core/billing/refundRequests), in paise. */
  refundedMinor?: number;
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<IPayment>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription' },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    provider: { type: String, required: true, default: 'manual' },
    reference: { type: String, required: true, trim: true, maxlength: 120 },
    providerPaymentId: { type: String },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    status: { type: String, enum: ['confirmed', 'failed'], required: true },
    amountMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },
    receivedAt: { type: Date, required: true },
    periodStart: { type: Date },
    periodEnd: { type: Date },
    applied: { type: Boolean, default: false },
    appliedAt: { type: Date },
    applyingAt: { type: Date, default: null },
    applyError: { type: String },
    failureReason: { type: String, maxlength: 500 },
    recordedBy: {
      type: { id: String, email: String, role: String },
      required: false,
      _id: false,
    },
    notes: { type: String, maxlength: 1000 },
    gateway: {
      type: { kind: { type: String, enum: ['order', 'mandate'] }, orderId: String, subscriptionId: String, chargePaymentId: String },
      _id: false,
      required: false,
    },
    refundedMinor: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, tenantScoped: false } as never,
);

// Per organization: a cheque number is only unique within one payer's bank.
paymentSchema.index({ provider: 1, orgId: 1, reference: 1 }, { unique: true });
paymentSchema.index({ orgId: 1, receivedAt: -1 });
// One confirmed payment settles an invoice: two people recording different
// references for the same invoice at once cannot both succeed.
paymentSchema.index(
  { invoiceId: 1 },
  { unique: true, partialFilterExpression: { invoiceId: { $exists: true }, status: 'confirmed' } },
);

export default mongoose.model<IPayment>('Payment', paymentSchema);
