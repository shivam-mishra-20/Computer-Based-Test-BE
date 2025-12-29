import mongoose, { Document, Schema } from 'mongoose';

export interface ISchedule extends Document {
  title: string;
  description?: string;
  type: 'class' | 'exam' | 'event' | 'holiday';
  startTime: Date;
  endTime: Date;
  subject?: string;
  classLevel?: string;
  batch?: string;
  instructor?: mongoose.Types.ObjectId;
  location?: string;
  isRecurring: boolean;
  recurringPattern?: 'daily' | 'weekly' | 'monthly';
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const scheduleSchema = new Schema<ISchedule>({
  title: { type: String, required: true },
  description: { type: String },
  type: { type: String, enum: ['class', 'exam', 'event', 'holiday'], default: 'class' },
  startTime: { type: Date, required: true, index: true },
  endTime: { type: Date, required: true },
  subject: { type: String },
  classLevel: { type: String, index: true },
  batch: { type: String, index: true },
  instructor: { type: Schema.Types.ObjectId, ref: 'User' },
  location: { type: String },
  isRecurring: { type: Boolean, default: false },
  recurringPattern: { type: String, enum: ['daily', 'weekly', 'monthly'] },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

// Index for efficient date-range queries
scheduleSchema.index({ startTime: 1, endTime: 1 });
scheduleSchema.index({ classLevel: 1, batch: 1, startTime: 1 });

export default mongoose.model<ISchedule>('Schedule', scheduleSchema);
