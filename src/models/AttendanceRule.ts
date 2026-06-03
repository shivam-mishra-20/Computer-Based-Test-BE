import mongoose, { Document, Schema } from 'mongoose';
import { UserRole } from './User';

export type UserType = 'full_time' | 'half_time';

export interface IAttendanceRule extends Document {
  // Scope — exactly one of userId or role must be set.
  // userId takes precedence: user-specific rule overrides any role rule.
  userId?: mongoose.Types.ObjectId;
  role?: UserRole;

  userType: UserType;

  // Official shift times in "HH:MM" 24-hour format
  officialInTime: string;
  officialOutTime: string;
  // Minutes of grace before a punch-in is counted as late (default 0)
  graceMinutes: number;

  // Full-time thresholds (hours; used only when userType = 'full_time')
  fullDayMinHours: number;         // >= this → Full Day
  partialFullDayMinHours: number;  // >= this but < fullDayMinHours → Partial Full Day

  // Half-time threshold (hours; used only when userType = 'half_time')
  halfTimeRequiredHours: number;

  // Salary deduction percentages (0–100)
  lateDeductionPct: number;           // Full-time: deduction applied on top for lateness
  partialFullDayDeductionPct: number; // Full-time: 8–9 h window (default 25 → ¼ salary)
  halfDayDeductionPct: number;        // Full-time: < 8 h (default 50 → ½ salary)
  halfTimeLateDeductionPct: number;   // Half-time: any lateness (default 50 → ½ salary)

  label?: string; // Optional admin-facing name for this rule

  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const attendanceRuleSchema = new Schema<IAttendanceRule>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    role: { type: String, enum: ['admin', 'teacher', 'student'], index: true },

    userType: { type: String, enum: ['full_time', 'half_time'], required: true, default: 'full_time' },

    officialInTime: { type: String, required: true, default: '10:30' },
    officialOutTime: { type: String, required: true, default: '19:30' },
    graceMinutes: { type: Number, required: true, default: 0, min: 0, max: 60 },

    fullDayMinHours: { type: Number, required: true, default: 9, min: 0 },
    partialFullDayMinHours: { type: Number, required: true, default: 8, min: 0 },
    halfTimeRequiredHours: { type: Number, required: true, default: 4, min: 0 },

    lateDeductionPct: { type: Number, required: true, default: 0, min: 0, max: 100 },
    partialFullDayDeductionPct: { type: Number, required: true, default: 25, min: 0, max: 100 },
    halfDayDeductionPct: { type: Number, required: true, default: 50, min: 0, max: 100 },
    halfTimeLateDeductionPct: { type: Number, required: true, default: 50, min: 0, max: 100 },

    label: { type: String },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// Enforce: a rule is either user-specific OR role-level, not both.
attendanceRuleSchema.index({ userId: 1 }, { unique: true, sparse: true });
attendanceRuleSchema.index({ role: 1 }, {
  unique: true,
  sparse: true,
  partialFilterExpression: { userId: { $exists: false } },
});

export default mongoose.model<IAttendanceRule>('AttendanceRule', attendanceRuleSchema);
