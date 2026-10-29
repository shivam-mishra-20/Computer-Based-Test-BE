import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * A payment an institute makes WHILE APPLYING — before it is an organization.
 *
 * `Payment` and `Invoice` both belong to an organization (orgId is required),
 * and an applicant has none until platform staff approve the application. So
 * the money taken at checkout is recorded here, against the registration, and
 * carried over at approval: the organization is created, this payment is
 * recorded as its `Payment` (provider `cashfree`, reference = Cashfree's
 * payment id) and starts its subscription ACTIVE on the plan it paid for.
 * See core/billing/registrationPayments.ts.
 *
 *   pending ──paid (verified with Cashfree)──▶ paid ──approval──▶ applied
 *      │                                        │
 *      ├──expired / failed / superseded          └──refund (before approval)
 *
 * One registration can have several rows: each checkout attempt is a Cashfree
 * order. Only one is normally paid; should two ever be (a second tab), both
 * are shown to staff and the later one refunded.
 *
 * The plan, the lines and the tax are FROZEN when the order is created — the
 * amount Cashfree charges is computed from them, and the invoice issued later
 * prints them as they were, whatever the catalogue or the billing profile
 * says by then.
 *
 * Amounts are integer minor units (paise). Platform accounting: NOT
 * tenant-scoped, and retained like Payment and Invoice.
 */

export type RegistrationPaymentStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'superseded';
export const REGISTRATION_PAYMENT_STATUSES: RegistrationPaymentStatus[] = ['pending', 'paid', 'failed', 'expired', 'superseded'];

export type RefundStatus = 'pending' | 'success' | 'failed';

export interface IRegistrationPayment extends Document {
  registrationId: Types.ObjectId;
  provider: 'cashfree';
  environment: 'sandbox' | 'production';
  /** Our order id, sent to Cashfree; unique. */
  orderId: string;
  cfOrderId?: string;
  /** Opens the hosted checkout for this order. Not a secret, but never listed to staff. */
  paymentSessionId?: string;
  expiresAt?: Date;
  status: RegistrationPaymentStatus;
  planKey: string;
  planVersion: number;
  planName: string;
  billingInterval: 'monthly' | 'annual';
  lines: { description: string; sacCode?: string; quantity: number; unitPriceMinor: number; amountMinor: number }[];
  subtotalMinor: number;
  tax: {
    regime: 'none' | 'gst';
    ratePercent?: number;
    inclusive?: boolean;
    placeOfSupply?: string;
    cgstMinor: number;
    sgstMinor: number;
    igstMinor: number;
    totalMinor: number;
  };
  totalMinor: number;
  currency: string;
  customer: { name?: string; email?: string; phone?: string; organizationName?: string };
  /** Filled from Cashfree once the order is paid. */
  payment?: {
    cfPaymentId: string;
    method: string;
    group?: string;
    bankReference?: string;
    message?: string;
    amountMinor: number;
    paidAt: Date;
  };
  /** The last thing Cashfree said, for an order that is not paid. */
  providerStatus?: string;
  lastAttempt?: { status: string; message?: string; at?: Date };
  lastCheckedAt?: Date;
  /** Who last made us look: the applicant returning, the webhook, or staff. */
  lastCheckedBy?: 'applicant' | 'webhook' | 'staff' | 'system';
  paidAt?: Date;
  /** Carried over at approval. */
  orgId?: Types.ObjectId;
  appliedAt?: Date;
  paymentId?: Types.ObjectId;
  applyError?: string;
  invoiceId?: Types.ObjectId;
  /** A short claim while the invoice is being numbered, so two clicks issue one. */
  invoicingAt?: Date | null;
  refund?: {
    refundId: string;
    /** 1 for the first request; a retry after a refused refund uses a new id. */
    attempt?: number;
    cfRefundId?: string;
    status: RefundStatus;
    providerStatus?: string;
    amountMinor: number;
    reason?: string;
    arn?: string;
    requestedAt: Date;
    processedAt?: Date;
    requestedBy?: { id?: string; email?: string };
    /** The RefundRequest that decided it (core/billing/refundRequests). */
    refundRequestId?: string;
  };
  createdIp?: string;
  createdAt: Date;
  updatedAt: Date;
}

const lineSchema = new Schema(
  {
    description: { type: String, required: true, maxlength: 300 },
    sacCode: { type: String, maxlength: 8 },
    quantity: { type: Number, required: true, min: 1 },
    unitPriceMinor: { type: Number, required: true, min: 0 },
    amountMinor: { type: Number, required: true, min: 0 },
  },
  { _id: false, tenantScoped: false } as never,
);

const registrationPaymentSchema = new Schema<IRegistrationPayment>(
  {
    registrationId: { type: Schema.Types.ObjectId, ref: 'OrganizationRegistration', required: true },
    provider: { type: String, enum: ['cashfree'], default: 'cashfree' },
    environment: { type: String, enum: ['sandbox', 'production'], required: true },
    orderId: { type: String, required: true, maxlength: 45 },
    cfOrderId: { type: String },
    paymentSessionId: { type: String, select: false },
    expiresAt: { type: Date },
    status: { type: String, enum: REGISTRATION_PAYMENT_STATUSES, default: 'pending' },
    planKey: { type: String, required: true },
    planVersion: { type: Number, required: true },
    planName: { type: String, required: true },
    billingInterval: { type: String, enum: ['monthly', 'annual'], required: true },
    lines: { type: [lineSchema], default: [] },
    subtotalMinor: { type: Number, required: true, min: 0 },
    tax: {
      type: {
        regime: { type: String, enum: ['none', 'gst'], default: 'none' },
        ratePercent: Number,
        inclusive: Boolean,
        placeOfSupply: String,
        cgstMinor: { type: Number, default: 0 },
        sgstMinor: { type: Number, default: 0 },
        igstMinor: { type: Number, default: 0 },
        totalMinor: { type: Number, default: 0 },
      },
      _id: false,
      default: () => ({ regime: 'none', cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalMinor: 0 }),
    },
    totalMinor: { type: Number, required: true, min: 100 },
    currency: { type: String, default: 'INR' },
    customer: {
      type: { name: String, email: String, phone: String, organizationName: String },
      _id: false,
      default: () => ({}),
    },
    payment: {
      type: {
        cfPaymentId: String,
        method: String,
        group: String,
        bankReference: String,
        message: String,
        amountMinor: Number,
        paidAt: Date,
      },
      _id: false,
      required: false,
    },
    providerStatus: { type: String },
    lastAttempt: { type: { status: String, message: String, at: Date }, _id: false, required: false },
    lastCheckedAt: { type: Date },
    lastCheckedBy: { type: String, enum: ['applicant', 'webhook', 'staff', 'system'] },
    paidAt: { type: Date },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org' },
    appliedAt: { type: Date },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
    applyError: { type: String, maxlength: 500 },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    invoicingAt: { type: Date, default: null },
    refund: {
      type: {
        refundId: String,
        attempt: Number,
        cfRefundId: String,
        status: { type: String, enum: ['pending', 'success', 'failed'] },
        providerStatus: String,
        amountMinor: Number,
        reason: String,
        arn: String,
        requestedAt: Date,
        processedAt: Date,
        requestedBy: { type: { id: String, email: String }, _id: false },
        refundRequestId: String,
      },
      _id: false,
      required: false,
    },
    createdIp: { type: String, maxlength: 64 },
  },
  { timestamps: true, tenantScoped: false } as never,
);

registrationPaymentSchema.index({ orderId: 1 }, { unique: true });
registrationPaymentSchema.index({ registrationId: 1, createdAt: -1 });
registrationPaymentSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model<IRegistrationPayment>('RegistrationPayment', registrationPaymentSchema);
