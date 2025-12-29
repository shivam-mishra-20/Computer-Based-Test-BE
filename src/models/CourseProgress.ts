import mongoose, { Document, Schema } from 'mongoose';

// Track student's course progress
export interface ICourseProgress extends Document {
  studentId: mongoose.Types.ObjectId;
  courseId: mongoose.Types.ObjectId;
  completedLectures: string[]; // lecture IDs
  lastAccessedAt: Date;
  progressPercent: number;
  enrolledAt: Date;
  completedAt?: Date;
  timeSpent: number; // in minutes
  lecturePositions: Map<string, number>; // lectureId -> position in seconds
  lastWatchedLectureId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const courseProgressSchema = new Schema<ICourseProgress>({
  studentId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  courseId: { type: Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
  completedLectures: [{ type: String }],
  lastAccessedAt: { type: Date, default: Date.now },
  progressPercent: { type: Number, default: 0 },
  enrolledAt: { type: Date, default: Date.now },
  completedAt: { type: Date },
  timeSpent: { type: Number, default: 0 },
  lecturePositions: { type: Map, of: Number, default: new Map() }, // lectureId -> position in seconds
  lastWatchedLectureId: { type: String }
}, { timestamps: true });

// Compound index for student-course queries
courseProgressSchema.index({ studentId: 1, courseId: 1 }, { unique: true });

export default mongoose.model<ICourseProgress>('CourseProgress', courseProgressSchema);
