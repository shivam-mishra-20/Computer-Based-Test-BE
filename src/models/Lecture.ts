import mongoose, { Document, Schema } from 'mongoose';

export type LectureStatus = 'draft' | 'published' | 'archived';

export interface ILecture extends Document {
  title: string;
  description?: string;
  youtubeVideoId: string;
  duration?: number; // in minutes
  subject: string;
  classLevel: string;
  chapter?: string;
  topic?: string;
  instructor: mongoose.Types.ObjectId;
  status: LectureStatus;
  order: number;
  tags?: string[];
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const lectureSchema = new Schema<ILecture>({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  youtubeVideoId: { type: String, required: true },
  duration: { type: Number },
  subject: { type: String, required: true, index: true },
  classLevel: { type: String, required: true, index: true },
  chapter: { type: String, index: true },
  topic: { type: String },
  instructor: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { 
    type: String, 
    enum: ['draft', 'published', 'archived'], 
    default: 'draft', 
    index: true 
  },
  order: { type: Number, default: 0 },
  tags: [{ type: String }],
  viewCount: { type: Number, default: 0 },
}, { timestamps: true });

// Compound indexes for efficient queries
lectureSchema.index({ instructor: 1, status: 1, classLevel: 1 });
lectureSchema.index({ subject: 1, chapter: 1, order: 1 });
lectureSchema.index({ classLevel: 1, subject: 1, status: 1 });

export default mongoose.model<ILecture>('Lecture', lectureSchema);
