import mongoose, { Document, Schema } from 'mongoose';

export interface IBookmark extends Document {
  studentId: mongoose.Types.ObjectId;
  courseId: mongoose.Types.ObjectId;
  lectureId: string;
  lectureTitle: string;
  timestamp: number; // position in video at time of bookmark
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const bookmarkSchema = new Schema<IBookmark>({
  studentId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  courseId: { type: Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
  lectureId: { type: String, required: true },
  lectureTitle: { type: String, required: true },
  timestamp: { type: Number, default: 0 },
  note: { type: String }
}, { timestamps: true });

// Compound index for efficient queries
bookmarkSchema.index({ studentId: 1, courseId: 1, lectureId: 1 }, { unique: true });

export default mongoose.model<IBookmark>('Bookmark', bookmarkSchema);
