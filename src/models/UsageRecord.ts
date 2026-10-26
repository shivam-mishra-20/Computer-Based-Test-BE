import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * Append-only metering.
 *
 * ── Why this exists before billing does ─────────────────────────────────────
 * You cannot bill retroactively for data you never collected. Recording usage
 * from day one costs almost nothing and is impossible to backfill; the first
 * three customers are also precisely when you learn which meters actually
 * correlate with value, and that lesson is only available if the numbers were
 * being kept while you weren't looking.
 *
 * Deliberately NOT tenant-scoped by the plugin: usage is platform accounting.
 * A tenant reading or writing its own usage record could understate what it
 * owes, so the collection is reachable only through core/subscriptions/usage.
 *
 * ── Append-only ─────────────────────────────────────────────────────────────
 * Increments are recorded as separate documents per period bucket rather than
 * mutating a running total. A lost update on a counter is invisible; a missing
 * append is detectable by comparing against the source of truth.
 *
 * ── The ledger for metered usage ────────────────────────────────────────────
 * Used for meters with no other authoritative record (AI generations): each
 * accepted request appends a `reservation` (+1); a request or job that fails
 * appends one `refund` (−1) naming the reservation. Usage for a period is the
 * sum of `value`. The partial unique index on `refundOf` makes a second refund
 * of the same reservation impossible, however many failure paths report it.
 * Seats (students, staff) and builds are NOT recorded here: they are counted
 * from the records themselves, which are the source of truth.
 */

export interface IUsageRecord extends Document {
  orgId: Types.ObjectId;
  /** Limit / meter key, e.g. 'aiGenerationsMonthly'. */
  meter: string;
  value: number;
  /** Bucket start — the calendar month (IST) for monthly meters. */
  periodStart: Date;
  kind?: 'reservation' | 'refund';
  /** For a refund: the reservation it cancels. */
  refundOf?: Types.ObjectId;
  /** What the reservation paid for, once known (an async job's record). */
  subject?: { type: string; id: string };
  actor?: { id?: string; role?: string };
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

// A field literally named `type` needs its own type key, or Mongoose reads it
// as the declaration of the whole sub-document.
const subjectSchema = new Schema(
  { type: { $type: String }, id: { $type: String } },
  { _id: false, typeKey: '$type', tenantScoped: false } as never,
);

const usageRecordSchema = new Schema<IUsageRecord>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
    meter: { type: String, required: true, index: true },
    value: { type: Number, required: true, default: 0 },
    periodStart: { type: Date, required: true, index: true },
    kind: { type: String, enum: ['reservation', 'refund'] },
    refundOf: { type: Schema.Types.ObjectId },
    subject: { type: subjectSchema, required: false },
    actor: {
      type: { id: String, role: String },
      required: false,
      _id: false,
    },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false }, tenantScoped: false } as never,
);

// The query that matters: "usage for this org, this meter, this period".
usageRecordSchema.index({ orgId: 1, meter: 1, periodStart: -1 });
// One refund per reservation, whichever failure path gets there first.
usageRecordSchema.index({ refundOf: 1 }, { unique: true, partialFilterExpression: { refundOf: { $exists: true } } });
// Finding the reservation behind a failed job.
usageRecordSchema.index({ 'subject.type': 1, 'subject.id': 1 }, { partialFilterExpression: { 'subject.id': { $exists: true } } });

export default mongoose.model<IUsageRecord>('UsageRecord', usageRecordSchema);
