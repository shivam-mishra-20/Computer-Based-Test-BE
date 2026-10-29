import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * An organization's auto-pay authorisation: a Cashfree ON_DEMAND subscription
 * (UPI Autopay, eNACH or a card standing instruction) the institute approves
 * once. Each renewal invoice is then charged through it, for the invoice's
 * amount and never above `maxAmountMinor` — the ceiling the institute saw and
 * approved. Cashfree sends the pre-debit notice. See core/billing/autopay.ts.
 *
 *   pending ──bank approves──▶ active ──charge per renewal──▶ …
 *      │                        ├──on_hold / paused (Cashfree or the customer)
 *      └──expired               └──cancelled (institute, staff, or at the bank)
 *
 * At most one LIVE mandate per organization (`live`, set while pending,
 * active, paused or on hold). Platform accounting: NOT tenant-scoped.
 */

export type MandateStatus = 'pending' | 'active' | 'paused' | 'on_hold' | 'cancelled' | 'expired' | 'failed';
export const LIVE_MANDATE_STATUSES: MandateStatus[] = ['pending', 'active', 'paused', 'on_hold'];

export interface IMandateCharge {
  /** Ours, sent to Cashfree; one per invoice per attempt. */
  paymentId: string;
  cfPaymentId?: string;
  invoiceId: Types.ObjectId;
  amountMinor: number;
  scheduledFor: Date;
  status: 'pending' | 'success' | 'failed';
  providerStatus?: string;
  failureReason?: string;
  raisedAt: Date;
  checkedAt?: Date;
  settledAt?: Date;
  /** The Payment the settlement recorded. */
  ledgerPaymentId?: Types.ObjectId;
  settleError?: string;
}

export interface IAutopayMandate extends Document {
  orgId: Types.ObjectId;
  provider: 'cashfree';
  environment: 'sandbox' | 'production';
  /** Ours; Cashfree's `subscription_id`. */
  subscriptionId: string;
  cfSubscriptionId?: string;
  sessionId?: string;
  status: MandateStatus;
  live?: boolean;
  providerStatus?: string;
  maxAmountMinor: number;
  billingInterval: 'monthly' | 'annual';
  method?: string;
  /** UMN (UPI), UMRN (mandate) or the card enrolment id. */
  reference?: string;
  /** Where the browser goes after authorising (the admin panel's own address). */
  returnTo?: string;
  authorizedAt?: Date;
  cancelledAt?: Date;
  cancelReason?: string;
  lastCheckedAt?: Date;
  charges: IMandateCharge[];
  createdBy?: { id?: string; email?: string };
  createdAt: Date;
  updatedAt: Date;
}

const chargeSchema = new Schema<IMandateCharge>(
  {
    paymentId: { type: String, required: true },
    cfPaymentId: { type: String },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
    amountMinor: { type: Number, required: true, min: 100 },
    scheduledFor: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
    providerStatus: { type: String },
    failureReason: { type: String, maxlength: 300 },
    raisedAt: { type: Date, required: true },
    checkedAt: { type: Date },
    settledAt: { type: Date },
    ledgerPaymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
    settleError: { type: String, maxlength: 500 },
  },
  { _id: false, tenantScoped: false } as never,
);

const mandateSchema = new Schema<IAutopayMandate>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    provider: { type: String, enum: ['cashfree'], default: 'cashfree' },
    environment: { type: String, enum: ['sandbox', 'production'], required: true },
    subscriptionId: { type: String, required: true, maxlength: 250 },
    cfSubscriptionId: { type: String },
    sessionId: { type: String, select: false },
    status: { type: String, enum: ['pending', 'active', 'paused', 'on_hold', 'cancelled', 'expired', 'failed'], default: 'pending' },
    live: { type: Boolean },
    providerStatus: { type: String },
    maxAmountMinor: { type: Number, required: true, min: 100 },
    billingInterval: { type: String, enum: ['monthly', 'annual'], required: true },
    method: { type: String },
    reference: { type: String },
    returnTo: { type: String, maxlength: 400 },
    authorizedAt: { type: Date },
    cancelledAt: { type: Date },
    cancelReason: { type: String, maxlength: 500 },
    lastCheckedAt: { type: Date },
    charges: { type: [chargeSchema], default: [] },
    createdBy: { type: { id: String, email: String }, _id: false, required: false },
  },
  { timestamps: true, tenantScoped: false } as never,
);

mandateSchema.index({ subscriptionId: 1 }, { unique: true });
// One live mandate per organization.
mandateSchema.index({ orgId: 1 }, { unique: true, partialFilterExpression: { live: true } });
mandateSchema.index({ status: 1 });
mandateSchema.index({ 'charges.status': 1 });

export default mongoose.model<IAutopayMandate>('AutopayMandate', mandateSchema);
