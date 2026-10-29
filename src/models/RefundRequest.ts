import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * A request to return money taken through Cashfree, decided by platform staff.
 * See core/billing/refundRequests.ts.
 *
 *   open ──approve (amount, note)──▶ refunding ──Cashfree──▶ refunded
 *     │                                   └──────────────────▶ failed (retry by approving again)
 *     └──decline (note shown to the requester)
 *
 * What is being refunded is one of:
 *   registration  money paid with an application, before it was approved
 *                 (RegistrationPayment) — always in full
 *   payment       an organization's Payment taken through Cashfree: its first
 *                 payment carried over at approval, an invoice paid online, or
 *                 a renewal charged to its auto-pay mandate
 *
 * The suggestion is what the refund policy gives (core/billing/refundPolicy);
 * staff may approve a different amount up to what is still refundable.
 * Retained when an organization is deleted. NOT tenant-scoped.
 */

export type RefundRequestStatus = 'open' | 'refunding' | 'refunded' | 'declined' | 'failed';

export interface IRefundRequest extends Document {
  source: 'registration' | 'payment';
  registrationPaymentId?: Types.ObjectId;
  registrationId?: Types.ObjectId;
  orgId?: Types.ObjectId;
  paymentId?: Types.ObjectId;
  invoiceId?: Types.ObjectId;
  /** Where Cashfree holds the money: an order, or a charge on a mandate. */
  gateway: { kind: 'order' | 'mandate'; orderId?: string; subscriptionId?: string; chargePaymentId?: string; cfPaymentId?: string };
  paidMinor: number;
  requestedMinor: number;
  reason: string;
  requestedBy: { kind: 'applicant' | 'tenant' | 'platform' | 'system'; id?: string; email?: string; name?: string };
  status: RefundRequestStatus;
  suggestion?: { amountMinor: number; rule: string; explanation: string };
  decision?: { by?: { id?: string; email?: string }; at: Date; note?: string; amountMinor?: number; endSubscription?: boolean };
  refund?: {
    refundId: string;
    attempt: number;
    cfRefundId?: string;
    status: 'pending' | 'success' | 'failed';
    providerStatus?: string;
    amountMinor: number;
    arn?: string;
    requestedAt: Date;
    processedAt?: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const refundRequestSchema = new Schema<IRefundRequest>(
  {
    source: { type: String, enum: ['registration', 'payment'], required: true },
    registrationPaymentId: { type: Schema.Types.ObjectId, ref: 'RegistrationPayment' },
    registrationId: { type: Schema.Types.ObjectId, ref: 'OrganizationRegistration' },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org' },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    gateway: {
      type: { kind: { type: String, enum: ['order', 'mandate'] }, orderId: String, subscriptionId: String, chargePaymentId: String, cfPaymentId: String },
      _id: false,
      required: true,
    },
    paidMinor: { type: Number, required: true, min: 0 },
    requestedMinor: { type: Number, required: true, min: 0 },
    reason: { type: String, required: true, maxlength: 1000 },
    requestedBy: {
      type: { kind: { type: String, enum: ['applicant', 'tenant', 'platform', 'system'] }, id: String, email: String, name: String },
      _id: false,
      required: true,
    },
    status: { type: String, enum: ['open', 'refunding', 'refunded', 'declined', 'failed'], default: 'open' },
    suggestion: { type: { amountMinor: Number, rule: String, explanation: String }, _id: false, required: false },
    decision: {
      type: { by: { type: { id: String, email: String }, _id: false }, at: Date, note: String, amountMinor: Number, endSubscription: Boolean },
      _id: false,
      required: false,
    },
    refund: {
      type: {
        refundId: String,
        attempt: Number,
        cfRefundId: String,
        status: { type: String, enum: ['pending', 'success', 'failed'] },
        providerStatus: String,
        amountMinor: Number,
        arn: String,
        requestedAt: Date,
        processedAt: Date,
      },
      _id: false,
      required: false,
    },
  },
  { timestamps: true, tenantScoped: false } as never,
);

refundRequestSchema.index({ status: 1, createdAt: -1 });
refundRequestSchema.index({ orgId: 1, createdAt: -1 });
refundRequestSchema.index({ registrationPaymentId: 1 });
refundRequestSchema.index({ paymentId: 1 });
refundRequestSchema.index({ 'refund.refundId': 1 }, { sparse: true });

export default mongoose.model<IRefundRequest>('RefundRequest', refundRequestSchema);
