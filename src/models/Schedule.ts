import mongoose, { Document, Schema } from 'mongoose';

export interface ISchedule extends Document {
  title?: string;
  description?: string;
  scheduleType: 'regular' | 'custom';
  type: 'class' | 'exam' | 'event' | 'holiday';
  // For regular schedules (weekly recurring)
  dayOfWeek?: number; // 0=Sunday, 1=Monday, ... 6=Saturday
  startTimeSlot: string; // "14:30" format for regular, or full time for custom
  endTimeSlot: string;   // "15:30" format
  // For custom schedules (specific date)
  date?: Date;
  // Class details
  subject: string;
  classLevel: string;
  batch: string;
  roomNumber: number; // 1-10
  // Instructor (String to support both Firebase IDs and MongoDB ObjectIds)
  teacherId?: string;
  teacherName?: string; // Denormalized for quick display
  // For custom single-student sessions (String IDs for Firebase compatibility)
  students?: string[];
  // Metadata
  createdBy: mongoose.Types.ObjectId;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const scheduleSchema = new Schema<ISchedule>({
  title: { type: String },
  description: { type: String },
  scheduleType: { type: String, enum: ['regular', 'custom'], required: true, index: true },
  type: { type: String, enum: ['class', 'exam', 'event', 'holiday'], default: 'class' },
  dayOfWeek: { type: Number, min: 0, max: 6, index: true },
  startTimeSlot: { type: String, required: true },
  endTimeSlot: { type: String, required: true },
  date: { type: Date, index: true },
  subject: { type: String, required: true },
  classLevel: { type: String, required: true, index: true },
  batch: { type: String, required: true, index: true },
  roomNumber: { type: Number, min: 1, max: 10, required: true },
  teacherId: { type: String }, // String for Firebase ID compatibility
  teacherName: { type: String },
  students: [{ type: String }], // String array for Firebase ID compatibility
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

// Compound indexes for efficient queries
scheduleSchema.index({ classLevel: 1, batch: 1, dayOfWeek: 1 });
scheduleSchema.index({ teacherId: 1, dayOfWeek: 1 });
scheduleSchema.index({ roomNumber: 1, dayOfWeek: 1, startTimeSlot: 1 });
scheduleSchema.index({ date: 1, classLevel: 1, batch: 1 });

export default mongoose.model<ISchedule>('Schedule', scheduleSchema);
