import mongoose, { Document, Schema } from 'mongoose';

export type ProgressStatus = 'not_started' | 'viewed' | 'in_progress' | 'completed' | 'submitted';
export type TargetType = 'material' | 'homework';

export interface IStudentProgress extends Document {
  student: mongoose.Types.ObjectId;
  targetType: TargetType;
  targetId: mongoose.Types.ObjectId;
  status: ProgressStatus;
  // Timestamps for status changes
  viewedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  submittedAt?: Date;
  // Submission details (for homework)
  submissionUrl?: string;
  submissionFileName?: string;
  submissionNotes?: string;
  // Teacher feedback
  grade?: number;
  feedback?: string;
  gradedBy?: mongoose.Types.ObjectId;
  gradedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const studentProgressSchema = new Schema<IStudentProgress>({
  student: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  targetType: { type: String, enum: ['material', 'homework'], required: true },
  targetId: { type: Schema.Types.ObjectId, required: true, refPath: 'targetTypeRef' },
  status: { 
    type: String, 
    enum: ['not_started', 'viewed', 'in_progress', 'completed', 'submitted'], 
    default: 'not_started' 
  },
  viewedAt: { type: Date },
  startedAt: { type: Date },
  completedAt: { type: Date },
  submittedAt: { type: Date },
  submissionUrl: { type: String },
  submissionFileName: { type: String },
  submissionNotes: { type: String },
  grade: { type: Number },
  feedback: { type: String },
  gradedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  gradedAt: { type: Date }
}, { timestamps: true });

// Virtual for dynamic ref path
studentProgressSchema.virtual('targetTypeRef').get(function() {
  return this.targetType === 'material' ? 'Material' : 'Homework';
});

// Compound unique index to ensure one progress record per student per target
studentProgressSchema.index({ student: 1, targetType: 1, targetId: 1 }, { unique: true });
studentProgressSchema.index({ targetType: 1, targetId: 1, status: 1 });

export default mongoose.model<IStudentProgress>('StudentProgress', studentProgressSchema);
