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
 * owes, so the collection is reachable only from `/api/platform/*`.
 *
 * ── Append-only ─────────────────────────────────────────────────────────────
 * Increments are recorded as separate documents per period bucket rather than
 * mutating a running total. A lost update on a counter is invisible; a missing
 * append is detectable by comparing against the source of truth.
 */

export interface IUsageRecord extends Document {
  orgId: Types.ObjectId;
  /** Meter key from the module registry, e.g. 'ai.generations'. */
  meter: string;
  value: number;
  /** Bucket start — month for billing meters, day for operational ones. */
  periodStart: Date;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

const usageRecordSchema = new Schema<IUsageRecord>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
    meter: { type: String, required: true, index: true },
    value: { type: Number, required: true, default: 0 },
    periodStart: { type: Date, required: true, index: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false }, tenantScoped: false } as never,
);

// The query that matters: "usage for this org, this meter, this period".
usageRecordSchema.index({ orgId: 1, meter: 1, periodStart: -1 });

export default mongoose.model<IUsageRecord>('UsageRecord', usageRecordSchema);
