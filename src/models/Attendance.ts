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
  source: 'webhook' | 'manual' | 'sync';
  idempotencyKey?: string;
  metadata?: any;
  clockIn?: string;
  clockOut?: string;
  lateIn?: string;
  earlyOut?: string;
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
  notes: { type: String },
  source: { type: String, enum: ['webhook', 'manual', 'sync', 'external'], default: 'manual' },
  // NOT `unique` — see the compound { orgId, idempotencyKey } index below.
  idempotencyKey: { type: String, sparse: true, index: true },
  metadata: { type: Schema.Types.Mixed },
  clockIn: { type: String },
  clockOut: { type: String },
  lateIn: { type: String },
  earlyOut: { type: String }
}, { timestamps: true });

// Compound index for efficient queries
//
// ── Tenant-scoped uniqueness ────────────────────────────────────────────────
// The legacy index below is globally unique, which on a shared database means
// this constraint spans every institute on the platform. The compound index is
// the replacement; the legacy one is removed by
// `scripts/safety/drop-legacy-global-indexes.ts` as a separate, supervised
// migration — create replacement, verify, only then remove.
// `idempotencyKey` is `etime-<punchCode>-<date>`, and punch codes come from
// each institute's own eTimeOffice hardware — two organizations both having
// employee "101" is ordinary. Globally unique meant the second one's
// attendance for that day was silently swallowed as a duplicate.
attendanceSchema.index({ orgId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
attendanceSchema.index({ studentId: 1, date: -1 });
attendanceSchema.index({ date: 1, classLevel: 1, batch: 1 });
// idempotencyKey index is already created via unique: true in schema definition

export default mongoose.model<IAttendance>('Attendance', attendanceSchema);
