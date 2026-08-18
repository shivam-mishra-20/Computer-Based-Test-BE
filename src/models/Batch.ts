import mongoose, { Document, Schema } from 'mongoose';

export interface IBatch extends Document {
  name: string;
  classLevels: string[];
  isDefault: boolean;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

const batchSchema = new Schema<IBatch>({
  // NOT globally unique. Two coaching institutes both running a "NEET" batch is
  // completely normal, and the original global index made the second one
  // impossible — it silently failed during Org 002 onboarding, producing 3
  // batches out of 4 with only a console warning.
  name: { type: String, required: true },
  classLevels: [{ type: String, required: true }],
  isDefault: { type: Boolean, default: false },
  description: { type: String }
}, { timestamps: true });

// Index for efficient queries
batchSchema.index({ classLevels: 1 });

/**
 * Batch names are unique WITHIN an organization.
 *
 * Added alongside the legacy global `name_1` index rather than replacing it in
 * one step — the same discipline used for User.email. Dropping both at once
 * leaves a window with no uniqueness at all if the new index fails to build,
 * and duplicates created in that window cannot be un-created.
 *
 * The old global index must still be dropped for multi-tenancy to work; that is
 * a deliberate migration step (scripts/safety/drop-legacy-batch-index.ts), not
 * a side effect of deploying this file.
 */
batchSchema.index({ orgId: 1, name: 1 }, { unique: true });

export default mongoose.model<IBatch>('Batch', batchSchema);
