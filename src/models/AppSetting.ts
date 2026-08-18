import { Schema, model, Document } from 'mongoose';

/**
 * Arbitrary key/value settings.
 *
 * ── Why `key` is no longer globally unique ──────────────────────────────────
 * `key` carried `unique: true`, which makes a setting name unique across the
 * ENTIRE platform. That is the same defect `batches.name` had, with the same
 * consequence and a worse blast radius: two institutes cannot both hold a
 * `MORNING_TIME_SLOTS` row, so the second one to save its timetable either
 * fails or overwrites the first one's schedule.
 *
 * Uniqueness is now per organization. The legacy global index still exists on
 * databases created before this change and is removed by
 * `scripts/safety/drop-legacy-global-indexes.ts` — deliberately a separate,
 * supervised step, because dropping an index is data-affecting and the compound
 * one has to exist first.
 *
 * `orgId` itself is added by the global tenancy plugin, not declared here.
 */

export interface IAppSetting extends Document {
  key: string;
  value: any;
  description?: string;
  updatedBy?: string;
  updatedAt: Date;
  createdAt: Date;
}

const AppSettingSchema = new Schema<IAppSetting>(
  {
    key: { type: String, required: true, index: true },
    value: { type: Schema.Types.Mixed, required: true },
    description: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

// Not sparse — deliberately. On a COMPOUND index, `sparse` skips a document
// only when it has none of the indexed fields, so a legacy row with a `key` and
// no `orgId` would be indexed either way; sparse would only add confusion.
//
// This builds cleanly on existing data because every pre-migration row indexes
// as `{ null, key }`, and those are all distinct — `key` was globally unique,
// which is precisely the constraint being replaced.
AppSettingSchema.index({ orgId: 1, key: 1 }, { unique: true });

export default model<IAppSetting>('AppSetting', AppSettingSchema);
