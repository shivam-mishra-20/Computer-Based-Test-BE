import mongoose, { Document, Schema } from 'mongoose';

export type CommentTargetType = 'material' | 'homework';

export interface IMaterialComment extends Document {
  targetType: CommentTargetType;
  targetId: mongoose.Types.ObjectId;
  author: mongoose.Types.ObjectId;
  content: string;
  // Optional parent for threaded replies
  parentComment?: mongoose.Types.ObjectId;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const materialCommentSchema = new Schema<IMaterialComment>({
  targetType: { type: String, enum: ['material', 'homework'], required: true },
  targetId: { type: Schema.Types.ObjectId, required: true },
  author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true, maxlength: 2000 },
  parentComment: { type: Schema.Types.ObjectId, ref: 'MaterialComment' },
  isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

// Indexes
materialCommentSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
materialCommentSchema.index({ author: 1, createdAt: -1 });
materialCommentSchema.index({ parentComment: 1 });

export default mongoose.model<IMaterialComment>('MaterialComment', materialCommentSchema);
