import mongoose, { Document, Schema } from 'mongoose';
import { ADMISSION_STREAMS } from './Lead';

// ── AdmissionSeat ───────────────────────────────────────────────────────────
// How many students an institute will admit to one class (and stream, for 11
// and 12) in one session. Entered by admins; the public "seats left" figure is
// computed from it — capacity less confirmed admissions and offers still held —
// so the website can no longer show a number nobody maintains.

export interface IAdmissionSeat extends Document {
  orgId?: string;
  session: string;
  classLevel: number;
  /** '' for classes that are not split by stream. */
  stream: string;
  capacity: number;
  updatedByName?: string;
  createdAt: Date;
  updatedAt: Date;
}

const admissionSeatSchema = new Schema<IAdmissionSeat>(
  {
    session: { type: String, required: true, maxlength: 7 },
    classLevel: { type: Number, required: true, min: 1, max: 12 },
    stream: { type: String, enum: [...ADMISSION_STREAMS, ''], default: '' },
    capacity: { type: Number, required: true, min: 0, max: 1000 },
    updatedByName: { type: String, maxlength: 80 },
  },
  { timestamps: true },
);

// `orgId` is added by the tenant plugin; listing it keeps the key tenant-local.
admissionSeatSchema.index({ orgId: 1, session: 1, classLevel: 1, stream: 1 }, { unique: true });

export default mongoose.model<IAdmissionSeat>('AdmissionSeat', admissionSeatSchema);
