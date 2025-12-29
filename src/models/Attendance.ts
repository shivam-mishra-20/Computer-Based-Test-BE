import mongoose, { Document, Schema } from 'mongoose';

export interface IAttendance extends Document {
  studentId: mongoose.Types.ObjectId;
  date: Date;
  status: 'present' | 'absent' | 'late' | 'excused';
  classLevel?: string;
  batch?: string;
  subject?: string;
  markedBy: mongoose.Types.ObjectId;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const attendanceSchema = new Schema<IAttendance>({
  studentId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  date: { type: Date, required: true, index: true },
  status: { type: String, enum: ['present', 'absent', 'late', 'excused'], required: true },
  classLevel: { type: String, index: true },
  batch: { type: String, index: true },
  subject: { type: String },
  markedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  notes: { type: String }
}, { timestamps: true });

// Compound index for efficient queries
attendanceSchema.index({ studentId: 1, date: -1 });
attendanceSchema.index({ date: 1, classLevel: 1, batch: 1 });

export default mongoose.model<IAttendance>('Attendance', attendanceSchema);
