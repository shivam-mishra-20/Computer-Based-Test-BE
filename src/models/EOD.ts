import mongoose, { Document, Schema } from 'mongoose';

export interface IClassReport {
  scheduleId?: mongoose.Types.ObjectId;
  subject: string;
  classLevel: string;
  batch: string;
  startTime: string;
  endTime: string;
  wasHeld: boolean;
  topicsCovered?: string;
  homework?: string;
  studentsPresent?: number;
  studentsAbsent?: number;
  remarks?: string;
}

export interface IDailyWorkReport {
  activities: string[];
  summary: string;
  blockers?: string;
  tomorrowPlan?: string;
  workWindow: {
    startTime: string;
    endTime: string;
  };
  submittedAt: Date;
  updatedAt: Date;
}

export interface IEOD extends Document {
  teacherId: string; // Support both MongoDB ObjectId and Firebase UID
  teacherName: string;
  date: Date;
  classes: IClassReport[];
  additionalNotes?: string;
  dailyWorkReport?: IDailyWorkReport;
  submittedAt: Date;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  reviewNotes?: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: Date;
  updatedAt: Date;
}

const classReportSchema = new Schema<IClassReport>({
  scheduleId: { type: Schema.Types.ObjectId, ref: 'Schedule' },
  subject: { type: String, required: true },
  classLevel: { type: String, required: true },
  batch: { type: String, required: true },
  startTime: { type: String, required: true },
  endTime: { type: String, required: true },
  wasHeld: { type: Boolean, required: true },
  topicsCovered: { type: String },
  homework: { type: String },
  studentsPresent: { type: Number },
  studentsAbsent: { type: Number },
  remarks: { type: String }
}, { _id: false });

const dailyWorkReportSchema = new Schema<IDailyWorkReport>({
  activities: [{ type: String, trim: true }],
  summary: { type: String, trim: true },
  blockers: { type: String, trim: true },
  tomorrowPlan: { type: String, trim: true },
  workWindow: {
    startTime: { type: String, default: '10:30' },
    endTime: { type: String, default: '19:30' }
  },
  submittedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { _id: false });

const eodSchema = new Schema<IEOD>({
  teacherId: { type: String, required: true, index: true },
  teacherName: { type: String, required: true },
  date: { type: Date, required: true, index: true },
  classes: [classReportSchema],
  additionalNotes: { type: String },
  dailyWorkReport: { type: dailyWorkReportSchema },
  submittedAt: { type: Date, default: Date.now },
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: { type: Date },
  reviewNotes: { type: String },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }
}, { timestamps: true });

// Compound index for efficient queries
eodSchema.index({ teacherId: 1, date: 1 }, { unique: true });
eodSchema.index({ date: 1, status: 1 });

export default mongoose.model<IEOD>('EOD', eodSchema);
