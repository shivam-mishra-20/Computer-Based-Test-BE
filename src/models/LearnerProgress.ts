import mongoose, { Document, Schema } from 'mongoose';

/**
 * A public learner's progress against a single public resource.
 *
 * DELIBERATELY SEPARATE from `CourseProgress`, which is keyed to `courseId` and
 * carries `enrolledAt` — institute enrollment semantics that must not acquire a
 * second, non-enrolled meaning. Writing learner playback into CourseProgress
 * would put public learners into institute course analytics.
 *
 * Progress is per-RESOURCE rather than per-course because the public library is
 * a flat set of StudyResources; chapters are a display grouping, not an entity.
 */

export const COMPLETION_THRESHOLD = 0.9; // 90% watched counts as finished

export interface ILearnerProgress extends Document {
  learnerId: mongoose.Types.ObjectId;
  resourceId: mongoose.Types.ObjectId;
  /** Seconds into the video. 0 for materials. */
  positionSec: number;
  /** Total duration in seconds when known; 0 when the resource has none. */
  durationSec: number;
  /** 0–1. Derived on write so list queries never have to compute it. */
  percent: number;
  completed: boolean;
  completedAt?: Date;
  lastAccessedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const learnerProgressSchema = new Schema<ILearnerProgress>(
  {
    learnerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    resourceId: { type: Schema.Types.ObjectId, ref: 'StudyResource', required: true },
    positionSec: { type: Number, default: 0, min: 0 },
    durationSec: { type: Number, default: 0, min: 0 },
    percent: { type: Number, default: 0, min: 0, max: 1 },
    completed: { type: Boolean, default: false },
    completedAt: { type: Date },
    lastAccessedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

learnerProgressSchema.index({ learnerId: 1, resourceId: 1 }, { unique: true });
// "Continue learning" — most recently touched, still unfinished.
learnerProgressSchema.index({ learnerId: 1, completed: 1, lastAccessedAt: -1 });

export default mongoose.model<ILearnerProgress>('LearnerProgress', learnerProgressSchema);
