import mongoose, { Document, Schema } from 'mongoose';

export type DoubtStatus = 'pending' | 'in-progress' | 'resolved';

export interface IDoubt extends Document {
  student: mongoose.Types.ObjectId;
  teacher?: mongoose.Types.ObjectId;
  subject: string;
  topic?: string;
  chapter?: string;
  question: string;
  images?: string[];
  status: DoubtStatus;
  reply?: string;
  replyImages?: string[];
  repliedAt?: Date;
  batch?: string;
  classLevel?: string;
  priority: 'low' | 'normal' | 'high';
  createdAt: Date;
  updatedAt: Date;
}

const doubtSchema = new Schema<IDoubt>({
  student: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  teacher: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  subject: { type: String, required: true, index: true },
  topic: { type: String },
  chapter: { type: String },
  question: { type: String, required: true },
  images: [{ type: String }],
  status: { 
    type: String, 
    enum: ['pending', 'in-progress', 'resolved'], 
    default: 'pending', 
    index: true 
  },
  reply: { type: String },
  replyImages: [{ type: String }],
  repliedAt: { type: Date },
  batch: { type: String, index: true },
  classLevel: { type: String, index: true },
  priority: { 
    type: String, 
    enum: ['low', 'normal', 'high'], 
    default: 'normal' 
  },
}, { timestamps: true });

// Compound indexes for efficient queries
doubtSchema.index({ status: 1, teacher: 1, createdAt: -1 });
doubtSchema.index({ batch: 1, subject: 1, status: 1 });
doubtSchema.index({ student: 1, createdAt: -1 });

export default mongoose.model<IDoubt>('Doubt', doubtSchema);
