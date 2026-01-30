import mongoose, { Document, Schema } from 'mongoose';

export type ResourceType = 'video' | 'pdf';
export type ResourceStatus = 'draft' | 'published' | 'archived';

export interface IStudyResource extends Document {
  title: string;
  description: string;
  type: ResourceType; // 'video' or 'pdf'
  resourceUrl: string; // YouTube URL or Firebase Storage URL
  thumbnailUrl?: string; // Thumbnail image URL
  category: string; // e.g., 'Mathematics', 'Physics', 'Chemistry'
  subject: string;
  classLevel: string;
  batch?: string;
  tags: string[];
  uploadedBy: mongoose.Types.ObjectId;
  status: ResourceStatus;
  
  // For videos
  youtubeVideoId?: string;
  duration?: number; // Duration in seconds for videos
  viewCount?: number;
  
  // For PDFs
  fileSize?: number; // File size in bytes
  pageCount?: number;
  downloadCount?: number;
  
  // Common
  isPublic: boolean; // Available to guest users
  isFeatured: boolean;
  
  createdAt: Date;
  updatedAt: Date;
}

const studyResourceSchema = new Schema<IStudyResource>({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  type: { type: String, enum: ['video', 'pdf'], required: true, index: true },
  resourceUrl: { type: String, required: true },
  thumbnailUrl: { type: String },
  category: { type: String, required: true, index: true },
  subject: { type: String, required: true, index: true },
  classLevel: { type: String, required: true, index: true },
  batch: { type: String, index: true },
  tags: [{ type: String }],
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['draft', 'published', 'archived'], default: 'published', index: true },
  
  // Video-specific
  youtubeVideoId: { type: String },
  duration: { type: Number },
  viewCount: { type: Number, default: 0 },
  
  // PDF-specific
  fileSize: { type: Number },
  pageCount: { type: Number },
  downloadCount: { type: Number, default: 0 },
  
  // Common
  isPublic: { type: Boolean, default: true }, // Visible to guest users
  isFeatured: { type: Boolean, default: false },
}, { timestamps: true });

// Pre-save hook to extract YouTube video ID
studyResourceSchema.pre('save', function(next) {
  const resource = this;
  if (resource.type === 'video' && !resource.youtubeVideoId && resource.resourceUrl) {
    const match = resource.resourceUrl.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=|youtube\.com\/embed\/)([^#&?]*)/);
    if (match && match[1]) {
      resource.youtubeVideoId = match[1];
    }
  }
  next();
});

// Indexes for efficient queries
studyResourceSchema.index({ type: 1, status: 1, classLevel: 1, subject: 1 });
studyResourceSchema.index({ isPublic: 1, isFeatured: 1 });
studyResourceSchema.index({ tags: 1 });

export default mongoose.model<IStudyResource>('StudyResource', studyResourceSchema);
