import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * An invoice the platform issues to an organization.
 *
 *   draft  ──issue──▶  issued  ──paid in full──▶  paid
 *     │                  │
 *     └──delete          └──void (unpaid only, with a reason)
 *
 * A draft has no number and can be edited or deleted. ISSUING assigns the next
 * number in the financial year (InvoiceCounter), freezes the lines and totals,
 * and copies the seller (BillingProfile) and buyer (Org.billing) onto the
 * invoice, so a later edit of either never rewrites an invoice already sent.
 * An issued invoice is never edited; a mistake is voided and reissued, and a
 * voided number is never reused.
 *
 * Money is integer minor units (paise). Tax fields follow the Indian GST shape
 * (CGST + SGST inside one state, IGST across states) but are only computed when
 * the platform's billing profile has a GSTIN and a rate — see
 * core/billing/invoices.ts. Nothing here claims GST compliance; the profile and
 * the format need review before invoices are sent to customers.
 *
 * Financial evidence: retained when an organization is deleted (orgDeletion
 * RETAINED). NOT tenant-scoped; organization admins read their own issued
 * invoices through core/billing, filtered by the principal's orgId.
 */

export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void';
export const INVOICE_STATUSES: InvoiceStatus[] = ['draft', 'issued', 'paid', 'void'];

export interface IInvoiceLine {
  description: string;
  sacCode?: string;
  quantity: number;
  unitPriceMinor: number;
  amountMinor: number;
}

export interface IInvoiceParty {
  name?: string;
  legalName?: string;
  gstin?: string;
  pan?: string;
  address?: string;
  city?: string;
  pincode?: string;
  stateCode?: string;
  stateName?: string;
  email?: string;
  phone?: string;
}

export interface IInvoiceTax {
  regime: 'none' | 'gst';
  ratePercent?: number;
  /** True when line amounts already include GST (it is carved out, not added). */
  inclusive?: boolean;
  placeOfSupply?: string;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalMinor: number;
}

export interface IInvoice extends Document {
  orgId: Types.ObjectId;
  subscriptionId?: Types.ObjectId;
  status: InvoiceStatus;
  number?: string;
  financialYear?: string;
  sequence?: number;
  periodStart?: Date;
  periodEnd?: Date;
  billingInterval?: string;
  planKey?: string;
  planVersion?: number;
  lines: IInvoiceLine[];
  currency: string;
  /** Taxable value: lines net of any GST carved out of inclusive prices. */
  subtotalMinor: number;
  tax: IInvoiceTax;
  totalMinor: number;
  amountPaidMinor: number;
  seller?: IInvoiceParty;
  buyer?: IInvoiceParty;
  notes?: string;
  /** How to pay, copied from the billing profile at issue. */
  paymentInstructions?: string;
  /** A short claim while the invoice is being numbered (see issueInvoice). */
  issuingAt?: Date | null;
  issuedAt?: Date;
  dueAt?: Date;
  paidAt?: Date;
  voidedAt?: Date;
  voidReason?: string;
  paymentIds: Types.ObjectId[];
  createdBy?: { id?: string; role?: string };
  issuedBy?: { id?: string; role?: string };
  /**
   * `self-serve`: an institute's own order from its admin panel (core/billing/
   * selfServe). Paying it moves the subscription onto `planKey`/`planVersion`
   * — or starts one. Staff-drafted invoices have no origin and never change
   * the plan when paid.
   */
  origin?: 'self-serve';
  /** What the order was, as the institute chose it. */
  order?: {
    kind: 'new' | 'renewal' | 'upgrade' | 'downgrade';
    by?: { id?: string; email?: string };
    /** Staff put the institute on the ordered plan before the payment arrived. */
    appliedAt?: Date;
    appliedBy?: { id?: string; email?: string };
  };
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const partySchema = new Schema<IInvoiceParty>(
  {
    name: String,
    legalName: String,
    gstin: String,
    pan: String,
    address: String,
    city: String,
    pincode: String,
    stateCode: String,
    stateName: String,
    email: String,
    phone: String,
  },
  { _id: false, tenantScoped: false } as never,
);

const lineSchema = new Schema<IInvoiceLine>(
  {
    description: { type: String, required: true, maxlength: 300 },
    sacCode: { type: String, maxlength: 8 },
    quantity: { type: Number, required: true, min: 1 },
    unitPriceMinor: { type: Number, required: true, min: 0 },
    amountMinor: { type: Number, required: true, min: 0 },
  },
  { _id: false, tenantScoped: false } as never,
);

const invoiceSchema = new Schema<IInvoice>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription' },
    status: { type: String, enum: INVOICE_STATUSES, default: 'draft' },
    number: { type: String },
    financialYear: { type: String },
    sequence: { type: Number },
    periodStart: { type: Date },
    periodEnd: { type: Date },
    billingInterval: { type: String },
    planKey: { type: String },
    planVersion: { type: Number },
    lines: { type: [lineSchema], default: [] },
    currency: { type: String, default: 'INR' },
    subtotalMinor: { type: Number, default: 0 },
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
      default: () => ({ regime: 'none', cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalMinor: 0 }),
      _id: false,
    },
    totalMinor: { type: Number, default: 0 },
    amountPaidMinor: { type: Number, default: 0 },
    seller: { type: partySchema, required: false },
    buyer: { type: partySchema, required: false },
    notes: { type: String, maxlength: 1000 },
    paymentInstructions: { type: String, maxlength: 1000 },
    issuingAt: { type: Date, default: null },
    issuedAt: { type: Date },
    dueAt: { type: Date },
    paidAt: { type: Date },
    voidedAt: { type: Date },
    voidReason: { type: String, maxlength: 500 },
    paymentIds: [{ type: Schema.Types.ObjectId, ref: 'Payment' }],
    createdBy: { type: { id: String, role: String }, required: false, _id: false },
    issuedBy: { type: { id: String, role: String }, required: false, _id: false },
    origin: { type: String, enum: ['self-serve'] },
    order: {
      type: {
        kind: { type: String, enum: ['new', 'renewal', 'upgrade', 'downgrade'] },
        by: { type: { id: String, email: String }, _id: false },
        appliedAt: { type: Date },
        appliedBy: { type: { id: String, email: String }, _id: false },
      },
      required: false,
      _id: false,
    },
    revision: { type: Number, default: 0 },
  },
  { timestamps: true, tenantScoped: false } as never,
);

// A number is assigned once and never twice: unique among numbered invoices.
invoiceSchema.index({ number: 1 }, { unique: true, partialFilterExpression: { number: { $type: 'string' } } });
invoiceSchema.index({ orgId: 1, createdAt: -1 });
invoiceSchema.index({ status: 1, dueAt: 1 });
// An institute's open order (draft or issued) — at most one is allowed (selfServe.ts).
invoiceSchema.index({ orgId: 1, origin: 1, status: 1 });

export default mongoose.model<IInvoice>('Invoice', invoiceSchema);
