import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * A class level, per organization.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * `SUPPORTED_CLASS_VALUES = ['7','8','9','10','11','12']`, hardcoded in two
 * places. `normalizeClassValue()` matches `/(\d{1,2})/` and returns `null` for
 * anything else, so a coaching institute's "Dropper" batch — a real and common
 * Indian class label — fails validation silently, with an error no admin could
 * act on. A K-6 school cannot onboard at all.
 *
 * ── key vs label ────────────────────────────────────────────────────────────
 * `key` is the stable identifier stored on data ("11", "dropper"). `label` is
 * what a human sees ("Class 11", "Dropper Batch") and may be renamed freely
 * without touching a single existing record.
 *
 * This separation is also the eventual cure for the `"11"` vs `"Class 11"` split
 * that forces normalization helpers into roughly ten files today: once records
 * reference a ClassLevel, there is exactly one spelling.
 *
 * `aliases` exists for the transition — it lets a lookup accept every legacy
 * spelling already sitting in production without a data migration.
 */

export interface IClassLevel extends Document {
  orgId: string;
  branchId?: string | null;
  /** Stable identifier. Lowercase, no spaces. */
  key: string;
  /** Human-facing name. Renameable. */
  label: string;
  /** Every legacy spelling that should resolve to this level. */
  aliases: string[];
  order: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const classLevelSchema = new Schema<IClassLevel>(
  {
    key: { type: String, required: true, lowercase: true, trim: true },
    label: { type: String, required: true, trim: true },
    aliases: [{ type: String, trim: true }],
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// orgId is added by the global tenant plugin; the compound index leads with it
// so a scoped query never scans another organization's rows.
classLevelSchema.index({ orgId: 1, key: 1 }, { unique: true });
classLevelSchema.index({ orgId: 1, order: 1 });

export default mongoose.model<IClassLevel>('ClassLevel', classLevelSchema);
