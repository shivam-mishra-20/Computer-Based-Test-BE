import mongoose, { Document, Schema } from 'mongoose';

export interface IFileMetadata extends Document {
  url: string;
  storagePath: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  uploadedBy: mongoose.Types.ObjectId;
  relatedDoubtId?: mongoose.Types.ObjectId;
  relatedMessageId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const fileMetadataSchema = new Schema<IFileMetadata>({
  url: { type: String, required: true },
  storagePath: { type: String, required: true, unique: true },
  fileName: { type: String, required: true },
  fileType: { type: String, required: true },
  fileSize: { type: Number, required: true },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  relatedDoubtId: { type: Schema.Types.ObjectId, ref: 'Doubt', index: true },
  relatedMessageId: { type: String, index: true },
}, { timestamps: true });

// Compound index for efficient queries
fileMetadataSchema.index({ relatedDoubtId: 1, createdAt: -1 });
fileMetadataSchema.index({ uploadedBy: 1, createdAt: -1 });

export default mongoose.model<IFileMetadata>('FileMetadata', fileMetadataSchema);
