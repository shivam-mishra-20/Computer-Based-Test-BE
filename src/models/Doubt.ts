import mongoose, { Document, Schema } from 'mongoose';

export type DoubtStatus = 'pending' | 'in-progress' | 'resolved';

export interface IAttachment {
  _id?: string;
  fileId: mongoose.Types.ObjectId;
  fileName: string;
  fileType: string;
  fileSize: number;
  url: string;
  storagePath: string;
}

export interface IMessage {
  _id?: string;
  sender: mongoose.Types.ObjectId;
  senderRole: 'student' | 'teacher' | 'admin';
  message: string;
  attachments?: IAttachment[];
  createdAt: Date;
}

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
  messages: IMessage[];
  createdAt: Date;
  updatedAt: Date;
}

const attachmentSchema = new Schema<IAttachment>({
  fileId: { type: Schema.Types.ObjectId, ref: 'FileMetadata', required: true },
  fileName: { type: String, required: true },
  fileType: { type: String, required: true },
  fileSize: { type: Number, required: true },
  url: { type: String, required: true },
  storagePath: { type: String, required: true }
}, { _id: true });

const messageSchema = new Schema<IMessage>({
  sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  senderRole: { type: String, enum: ['student', 'teacher', 'admin'], required: true },
  message: { type: String, required: true },
  attachments: [attachmentSchema],
  createdAt: { type: Date, default: Date.now }
}, { _id: true });

const doubtSchema = new Schema<IDoubt>({
  student: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  teacher: { type: Schema.Types.ObjectId, ref: 'User', required: false, index: true },
  subject: { type: String, default: 'General' },
  topic: { type: String },
  chapter: { type: String },
  question: { type: String, default: '' },
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
  messages: [messageSchema],
}, { timestamps: true });

// Compound indexes for efficient queries
doubtSchema.index({ status: 1, teacher: 1, createdAt: -1 });
doubtSchema.index({ batch: 1, subject: 1, status: 1 });
doubtSchema.index({ student: 1, createdAt: -1 });

export default mongoose.model<IDoubt>('Doubt', doubtSchema);
