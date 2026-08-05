import mongoose, { Document, Schema } from 'mongoose';

// ── Class Request ───────────────────────────────────────────────────────────
// A prospective/existing student asking for a class, submitted from the public
// (unauthenticated) web page or the mobile guest flow. One canonical collection
// feeds one admin queue — see routes/api/classRequestRoutes.ts.
//
// Class and subject are stored as validated snapshot STRINGS, not references:
// this repo has no Class or Subject collection (classes come from
// config/studentBatchConfig, subjects are free-text on Question/StudyResource),
// and inventing one here would duplicate an existing concept. Batch keeps a
// real reference to the canonical Batch registry where one can be resolved,
// with the name snapshotted alongside so the row still reads correctly if a
// batch is later renamed or removed.

export type ClassRequestSource = 'APP' | 'WEB';
export type ClassRequestStatus =
  | 'PENDING'
  | 'CONTACTED'
  | 'APPROVED'
  | 'REJECTED';

export const CLASS_REQUEST_SOURCES: ClassRequestSource[] = ['APP', 'WEB'];
export const CLASS_REQUEST_STATUSES: ClassRequestStatus[] = [
  'PENDING',
  'CONTACTED',
  'APPROVED',
  'REJECTED',
];

export interface IClassRequest extends Document {
  name: string;
  classValue: string; // bare digit form ("11"), consistent with exams/schedules
  batchId?: mongoose.Types.ObjectId; // canonical Batch when resolvable
  batchName: string; // snapshot, survives renames
  subject: string;
  /** Human-readable timing. Free text from the public web form; a formatted
   *  date+time string when submitted from the app. Always populated so the
   *  admin queue has one field it can always render. */
  preferredTiming: string;
  /** Exact instant chosen in the app's date/time picker. Absent for the public
   *  web form, which only collects free text. */
  preferredAt?: Date;
  reason?: string;

  // ── Teacher-submitted audience ──────────────────────────────────────────
  // A teacher can raise a request for several batches at once, or for a set of
  // named students. Both are optional; a student's own request uses neither.
  batchNames?: string[];
  studentIds?: mongoose.Types.ObjectId[];

  source: ClassRequestSource;
  status: ClassRequestStatus;

  remarks?: string;
  assignedTeacher?: mongoose.Types.ObjectId;

  isContacted: boolean;
  reviewedAt?: Date;
  reviewedBy?: mongoose.Types.ObjectId;

  // Set ONLY from a verified session when the submitter happened to be signed
  // in (e.g. a teacher raising a request from the app). Never client-supplied,
  // and absent for genuine guest submissions.
  requestedBy?: mongoose.Types.ObjectId;
  requestedByRole?: string;

  // Abuse/audit context — never returned by the public endpoint.
  submittedIp?: string;

  createdAt: Date;
  updatedAt: Date;
}

const classRequestSchema = new Schema<IClassRequest>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    classValue: {
      type: String,
      required: true,
      trim: true,
      maxlength: 20,
      index: true,
    },
    batchId: { type: Schema.Types.ObjectId, ref: 'Batch' },
    batchName: { type: String, required: true, trim: true, maxlength: 80 },
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      index: true,
    },
    preferredTiming: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    preferredAt: { type: Date },
    reason: { type: String, trim: true, maxlength: 1000 },

    batchNames: [{ type: String, trim: true, maxlength: 80 }],
    studentIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],

    source: {
      type: String,
      enum: CLASS_REQUEST_SOURCES,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: CLASS_REQUEST_STATUSES,
      default: 'PENDING',
      required: true,
      index: true,
    },

    remarks: { type: String, trim: true, maxlength: 1000 },
    assignedTeacher: { type: Schema.Types.ObjectId, ref: 'User' },

    isContacted: { type: Boolean, default: false },
    reviewedAt: { type: Date },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },

    requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    requestedByRole: { type: String },

    submittedIp: { type: String, maxlength: 64, select: false },
  },
  { timestamps: true },
);

// Admin queue is "newest first, optionally filtered by status".
classRequestSchema.index({ createdAt: -1 });
classRequestSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model<IClassRequest>(
  'ClassRequest',
  classRequestSchema,
);
