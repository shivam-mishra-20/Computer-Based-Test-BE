import mongoose, { Document, Schema } from 'mongoose';

export type LeaveStatus = 'pending' | 'approved' | 'rejected';
export type LeaveType = 'sick' | 'personal' | 'emergency' | 'vacation' | 'other';

export interface ILeave extends Document {
  teacherId: string; // Support both MongoDB ObjectId and Firebase UID
  teacherName: string;
  teacherEmail: string;
  leaveType: LeaveType;
  startDate: Date;
  endDate: Date;
  reason: string;
  status: LeaveStatus;
  approvedBy?: mongoose.Types.ObjectId;
  approvedAt?: Date;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const leaveSchema = new Schema<ILeave>({
  teacherId: { type: String, required: true, index: true },
  teacherName: { type: String, required: true },
  teacherEmail: { type: String, required: true },
  leaveType: { 
    type: String, 
    enum: ['sick', 'personal', 'emergency', 'vacation', 'other'], 
    required: true 
  },
  startDate: { type: Date, required: true, index: true },
  endDate: { type: Date, required: true, index: true },
  reason: { type: String, required: true },
  status: { 
    type: String, 
    enum: ['pending', 'approved', 'rejected'], 
    default: 'pending',
    index: true 
  },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  approvedAt: { type: Date },
  rejectionReason: { type: String }
}, { timestamps: true });

// Compound indexes for efficient queries
leaveSchema.index({ teacherId: 1, status: 1 });
leaveSchema.index({ startDate: 1, endDate: 1 });
leaveSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model<ILeave>('Leave', leaveSchema);
