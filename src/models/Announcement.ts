import mongoose, { Document, Schema } from 'mongoose';

export type AnnouncementPriority = 'low' | 'normal' | 'high' | 'urgent';
export type AnnouncementTarget = 'all' | 'students' | 'teachers' | 'class' | 'batch';

export interface IAnnouncement extends Document {
  title: string;
  content: string;
  priority: AnnouncementPriority;
  target: AnnouncementTarget;
  targetClass?: string;
  targetBatch?: string;
  createdBy: mongoose.Types.ObjectId;
  isPublished: boolean;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const announcementSchema = new Schema<IAnnouncement>({
  title: { type: String, required: true },
  content: { type: String, required: true },
  priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
  target: { type: String, enum: ['all', 'students', 'teachers', 'class', 'batch'], default: 'all' },
  targetClass: { type: String, index: true },
  targetBatch: { type: String, index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  isPublished: { type: Boolean, default: true, index: true },
  expiresAt: { type: Date }
}, { timestamps: true });

// Index for efficient queries
announcementSchema.index({ isPublished: 1, createdAt: -1 });
announcementSchema.index({ target: 1, targetClass: 1, targetBatch: 1 });

export default mongoose.model<IAnnouncement>('Announcement', announcementSchema);
