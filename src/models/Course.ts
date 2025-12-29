import mongoose, { Document, Schema } from 'mongoose';

export type CourseStatus = 'draft' | 'published' | 'archived';

export interface ICourse extends Document {
  title: string;
  description: string;
  subject: string;
  classLevel: string;
  batch?: string;
  instructor: mongoose.Types.ObjectId;
  thumbnail?: string;
  duration?: number; // in hours
  lectureCount?: number;
  status: CourseStatus;
  isFree: boolean;
  enrolledStudents: mongoose.Types.ObjectId[];
  syllabus?: {
    title: string;
    description?: string;
    lectures: {
      title: string;
      videoUrl?: string;
      duration?: number; // in minutes
      order: number;
    }[];
  }[];
  createdAt: Date;
  updatedAt: Date;
}

const courseSchema = new Schema<ICourse>({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  subject: { type: String, required: true, index: true },
  classLevel: { type: String, required: true, index: true },
  batch: { type: String, index: true },
  instructor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  thumbnail: { type: String },
  duration: { type: Number },
  lectureCount: { type: Number, default: 0 },
  status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft', index: true },
  isFree: { type: Boolean, default: false },
  enrolledStudents: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  syllabus: [{
    title: { type: String, required: true },
    description: { type: String },
    lectures: [{
      title: { type: String, required: true },
      videoUrl: { type: String },
      duration: { type: Number },
      order: { type: Number, default: 0 }
    }]
  }]
}, { timestamps: true });

// Index for efficient queries
courseSchema.index({ status: 1, classLevel: 1, subject: 1 });

export default mongoose.model<ICourse>('Course', courseSchema);
