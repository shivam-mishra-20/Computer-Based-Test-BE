import mongoose, { Document, Schema } from 'mongoose';

export type MaterialType =
  | 'pdf'
  | 'video'
  | 'document'
  | 'link'
  | 'image'
  | 'other';
export type AssignmentType = 'all' | 'class' | 'batch' | 'students';

export interface IMaterialVersion {
  version: number;
  fileUrl: string;
  fileSize?: number;
  fileName?: string;
  mimeType?: string;
  uploadedAt: Date;
  notes?: string;
}

export interface IMaterial extends Document {
  title: string;
  description?: string;
  type: MaterialType;
  fileUrl: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  subject: string;
  classLevel: string;
  chapter?: string;
  uploadedBy: mongoose.Types.ObjectId;
  downloadCount: number;
  isPublished: boolean;
  // Versioning
  version: number;
  versions: IMaterialVersion[];
  // Assignment targeting
  assignmentType: AssignmentType;
  assignedClasses: string[];
  assignedBatches: string[];
  assignedStudents: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const materialVersionSchema = new Schema<IMaterialVersion>(
  {
    version: { type: Number, required: true },
    fileUrl: { type: String, required: true },
    fileSize: { type: Number },
    fileName: { type: String },
    mimeType: { type: String },
    uploadedAt: { type: Date, default: Date.now },
    notes: { type: String },
  },
  { _id: false },
);

const materialSchema = new Schema<IMaterial>(
  {
    title: { type: String, required: true },
    description: { type: String },
    type: {
      type: String,
      enum: ['pdf', 'video', 'document', 'link', 'image', 'other'],
      default: 'pdf',
    },
    fileUrl: { type: String, required: true },
    fileName: { type: String },
    mimeType: { type: String },
    fileSize: { type: Number },
    subject: { type: String, required: true, index: true },
    classLevel: { type: String, required: true, index: true },
    chapter: { type: String },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    downloadCount: { type: Number, default: 0 },
    isPublished: { type: Boolean, default: true, index: true },
    // Versioning
    version: { type: Number, default: 1 },
    versions: [materialVersionSchema],
    // Assignment targeting
    assignmentType: {
      type: String,
      enum: ['all', 'class', 'batch', 'students'],
      default: 'class',
    },
    assignedClasses: [{ type: String }],
    assignedBatches: [{ type: String }],
    assignedStudents: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true },
);

// Indexes for efficient queries
materialSchema.index({ isPublished: 1, classLevel: 1, subject: 1 });
materialSchema.index({ assignmentType: 1, assignedClasses: 1 });
materialSchema.index({ assignmentType: 1, assignedBatches: 1 });
materialSchema.index({ assignmentType: 1, assignedStudents: 1 });

export default mongoose.model<IMaterial>('Material', materialSchema);
