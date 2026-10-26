import mongoose, { Document, Schema } from 'mongoose';

/**
 * The last invoice number used in one financial year (April–March), per
 * prefix. Incremented atomically when an invoice is issued, so two invoices
 * issued at the same moment get consecutive numbers, never the same one.
 *
 * A number taken by an issue that then fails to save is skipped, not reused:
 * the gap is visible and explainable, a duplicate is neither.
 *
 * Platform-owned and NOT tenant-scoped.
 */

export interface IInvoiceCounter extends Document {
  prefix: string;
  financialYear: string;
  seq: number;
}

const invoiceCounterSchema = new Schema<IInvoiceCounter>(
  {
    prefix: { type: String, required: true },
    financialYear: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true, tenantScoped: false } as never,
);

invoiceCounterSchema.index({ prefix: 1, financialYear: 1 }, { unique: true });

export default mongoose.model<IInvoiceCounter>('InvoiceCounter', invoiceCounterSchema);
