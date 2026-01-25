import mongoose, { Document, Schema } from 'mongoose';

export type HomeworkStatus = 'draft' | 'published' | 'closed';
export type AssignmentType = 'all' | 'class' | 'batch' | 'students';

export interface IHomeworkAttachment {
  fileUrl: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
}

export interface IHomework extends Document {
  title: string;
  description?: string;
  instructions?: string;
  // Optional linked material
  material?: mongoose.Types.ObjectId;
  // Direct attachments
  attachments: IHomeworkAttachment[];
  // Assignment targeting
  assignmentType: AssignmentType;
  assignedClasses: string[];
  assignedBatches: string[];
  assignedStudents: mongoose.Types.ObjectId[];
  // Due date
  dueDate?: Date;
  // Teacher who created
  createdBy: mongoose.Types.ObjectId;
  subject: string;
  classLevel: string;
  status: HomeworkStatus;
  // Allow late submissions
  allowLateSubmission: boolean;
  // Max points/marks (optional)
  maxPoints?: number;
  createdAt: Date;
  updatedAt: Date;
}

const attachmentSchema = new Schema<IHomeworkAttachment>({
  fileUrl: { type: String, required: true },
  fileName: { type: String, required: true },
  mimeType: { type: String, required: true },
  fileSize: { type: Number }
}, { _id: false });

const homeworkSchema = new Schema<IHomework>({
  title: { type: String, required: true },
  description: { type: String },
  instructions: { type: String },
  material: { type: Schema.Types.ObjectId, ref: 'Material' },
  attachments: [attachmentSchema],
  assignmentType: { type: String, enum: ['all', 'class', 'batch', 'students'], default: 'class', required: true },
  assignedClasses: [{ type: String }],
  assignedBatches: [{ type: String }],
  assignedStudents: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  dueDate: { type: Date },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  subject: { type: String, required: true, index: true },
  classLevel: { type: String, required: true, index: true },
  status: { type: String, enum: ['draft', 'published', 'closed'], default: 'draft', index: true },
  allowLateSubmission: { type: Boolean, default: false },
  maxPoints: { type: Number }
}, { timestamps: true });

// Indexes
homeworkSchema.index({ createdBy: 1, status: 1 });
homeworkSchema.index({ assignmentType: 1, assignedClasses: 1, status: 1 });
homeworkSchema.index({ assignmentType: 1, assignedBatches: 1, status: 1 });
homeworkSchema.index({ assignmentType: 1, assignedStudents: 1, status: 1 });
homeworkSchema.index({ dueDate: 1, status: 1 });

export default mongoose.model<IHomework>('Homework', homeworkSchema);
