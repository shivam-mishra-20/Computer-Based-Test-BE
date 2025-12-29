import mongoose, { Document, Schema } from 'mongoose';

export type MaterialType = 'pdf' | 'video' | 'document' | 'link' | 'other';

export interface IMaterial extends Document {
  title: string;
  description?: string;
  type: MaterialType;
  fileUrl: string;
  fileSize?: number; // in bytes
  subject: string;
  classLevel: string;
  batch?: string;
  chapter?: string;
  uploadedBy: mongoose.Types.ObjectId;
  downloadCount: number;
  isPublished: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const materialSchema = new Schema<IMaterial>({
  title: { type: String, required: true },
  description: { type: String },
  type: { type: String, enum: ['pdf', 'video', 'document', 'link', 'other'], default: 'pdf' },
  fileUrl: { type: String, required: true },
  fileSize: { type: Number },
  subject: { type: String, required: true, index: true },
  classLevel: { type: String, required: true, index: true },
  batch: { type: String, index: true },
  chapter: { type: String },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  downloadCount: { type: Number, default: 0 },
  isPublished: { type: Boolean, default: true, index: true }
}, { timestamps: true });

// Index for efficient queries
materialSchema.index({ isPublished: 1, classLevel: 1, subject: 1 });

export default mongoose.model<IMaterial>('Material', materialSchema);
