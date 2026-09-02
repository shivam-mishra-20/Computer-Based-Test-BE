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
  /**
   * Validity window for a REGULAR (weekly recurring) schedule.
   *
   * Without this, a weekly slot has no beginning and no end: a row created
   * today is indistinguishable from one that has run all year, so any report
   * that expands the timetable onto past dates projects today's roster
   * backwards over months it never applied to. That is silently wrong, and
   * historical workload and efficiency reporting cannot be trusted without it.
   *
   * Both ends are optional and both are INCLUSIVE:
   *   effectiveFrom absent → consumers fall back to `createdAt`, because a
   *     schedule cannot have applied before it existed. Set it explicitly to
   *     backdate a slot that really did run earlier.
   *   effectiveTo absent → open-ended, still running.
   *
   * Ignored for `custom` schedules, which already carry their own single date.
   */
  effectiveFrom?: Date;
  effectiveTo?: Date;
  // Class details
  subject: string;
  classLevel: string;
  batch?: string;
  batches?: string[];
  roomNumber: number; // 1-11
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
  effectiveFrom: { type: Date },
  effectiveTo: { type: Date },
  subject: { type: String, required: true },
  classLevel: { type: String, required: true, index: true },
  batch: { type: String, default: '', index: true },
  batches: [{ type: String, index: true }],
  roomNumber: { type: Number, min: 1, max: 11, required: true },
  teacherId: { type: String }, // String for Firebase ID compatibility
  teacherName: { type: String },
  students: [{ type: String }], // String array for Firebase ID compatibility
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

/** An end before the start would silently match no dates at all. */
scheduleSchema.pre('validate', function (next) {
  const doc = this as any;
  if (doc.effectiveFrom && doc.effectiveTo && doc.effectiveTo < doc.effectiveFrom) {
    return next(new Error('effectiveTo cannot be earlier than effectiveFrom'));
  }
  next();
});

// A retired weekly slot is `isActive: false` with an `effectiveTo`; historical
// reports read it back through this index while every live view keeps filtering
// on `isActive` alone and never sees it.
scheduleSchema.index({ scheduleType: 1, effectiveFrom: 1, effectiveTo: 1 });

// Compound indexes for efficient queries
scheduleSchema.index({ classLevel: 1, batch: 1, dayOfWeek: 1 });
scheduleSchema.index({ classLevel: 1, batches: 1, dayOfWeek: 1 });
scheduleSchema.index({ teacherId: 1, dayOfWeek: 1 });
scheduleSchema.index({ roomNumber: 1, dayOfWeek: 1, startTimeSlot: 1 });
scheduleSchema.index({ date: 1, classLevel: 1, batch: 1 });
scheduleSchema.index({ date: 1, classLevel: 1, batches: 1 });

export default mongoose.model<ISchedule>('Schedule', scheduleSchema);
