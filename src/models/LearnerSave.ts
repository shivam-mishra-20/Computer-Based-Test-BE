import mongoose, { Document, Schema } from 'mongoose';

/**
 * A public learner's saved item.
 *
 * DELIBERATELY SEPARATE from the existing `Bookmark` model. Bookmark is
 * institute machinery: it is keyed to `courseId` + `lectureId` and carries a
 * video timestamp, so it presumes course enrollment — a relationship a public
 * learner does not have. Reusing it would either force fake course ids onto
 * learner rows or loosen a model the institute app depends on.
 *
 * `itemType` exists so chapters (and anything later) can be saved without a
 * migration, but nothing beyond the two real content types is implemented —
 * the enum grows when a feature actually needs it.
 */

export type LearnerSaveItemType = 'RESOURCE';

export interface ILearnerSave extends Document {
  learnerId: mongoose.Types.ObjectId;
  itemType: LearnerSaveItemType;
  /** StudyResource _id. Kept as ObjectId so it can be $lookup'd / populated. */
  resourceId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const learnerSaveSchema = new Schema<ILearnerSave>(
  {
    learnerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    itemType: { type: String, enum: ['RESOURCE'], default: 'RESOURCE', required: true },
    resourceId: { type: Schema.Types.ObjectId, ref: 'StudyResource', required: true },
  },
  { timestamps: true },
);

// One save per learner per item; makes the toggle idempotent.
learnerSaveSchema.index({ learnerId: 1, itemType: 1, resourceId: 1 }, { unique: true });
// "My saves, newest first" — the only read pattern the UI has.
learnerSaveSchema.index({ learnerId: 1, createdAt: -1 });

export default mongoose.model<ILearnerSave>('LearnerSave', learnerSaveSchema);
