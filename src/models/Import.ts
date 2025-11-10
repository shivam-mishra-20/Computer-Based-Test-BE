import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IImport extends Document {
  subject: string;
  topic: string;
  uploadedBy: Types.ObjectId;
  questionIds: Types.ObjectId[]; // refs to ImportedQuestion
  questionCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const importSchema = new Schema<IImport>(
  {
    subject: { type: String, required: true, index: true },
    topic: { type: String, required: true, index: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    questionIds: [{ type: Schema.Types.ObjectId, ref: 'ImportedQuestion' }],
    questionCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Ensure uniqueness per user/subject/topic
importSchema.index({ uploadedBy: 1, subject: 1, topic: 1 }, { unique: true });

export const ImportModel = mongoose.model<IImport>('Import', importSchema);
