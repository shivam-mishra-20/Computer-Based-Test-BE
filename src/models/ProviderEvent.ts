import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * Every event a payment provider has sent, once — the idempotency and replay
 * record for a future gateway (core/billing/provider.ts).
 *
 * (provider, eventId) is unique, so a provider delivering the same event twice
 * — which every provider does — is processed once. Stored BEFORE processing,
 * with the outcome written after, so a crash mid-processing is visible rather
 * than silently retried into a double payment.
 *
 * No provider is registered today (payments are confirmed manually), so this
 * collection stays empty until one is. Financial evidence: retained when an
 * organization is deleted. Platform-owned and NOT tenant-scoped.
 */

export interface IProviderEvent extends Document {
  provider: string;
  eventId: string;
  type: string;
  occurredAt: Date;
  receivedAt: Date;
  orgId?: Types.ObjectId;
  invoiceId?: Types.ObjectId;
  reference?: string;
  amountMinor?: number;
  /** SHA-256 of the raw body, so the stored event can be matched to what was received. */
  payloadHash: string;
  status: 'received' | 'processed' | 'rejected' | 'failed';
  outcome?: string;
  paymentId?: Types.ObjectId;
  processedAt?: Date;
}

const providerEventSchema = new Schema<IProviderEvent>(
  {
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    type: { type: String, required: true },
    occurredAt: { type: Date, required: true },
    receivedAt: { type: Date, default: Date.now },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org' },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    reference: { type: String },
    amountMinor: { type: Number },
    payloadHash: { type: String, required: true },
    status: { type: String, enum: ['received', 'processed', 'rejected', 'failed'], default: 'received' },
    outcome: { type: String, maxlength: 500 },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
    processedAt: { type: Date },
  },
  { timestamps: false, tenantScoped: false } as never,
);

providerEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

export default mongoose.model<IProviderEvent>('ProviderEvent', providerEventSchema);
