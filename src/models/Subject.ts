import mongoose, { Document, Schema } from 'mongoose';

/**
 * A subject, per organization.
 *
 * Replaces `CURRICULUM_SUBJECTS` — a fixed 15-entry Indian K-12 list in
 * `config/subjects.ts`. That list is right for Abhigyan and wrong for a JEE/NEET
 * coaching institute offering only PCM/PCB, and wrong again for a training body
 * whose "subjects" are compliance topics.
 *
 * The existing constant's own comment concedes the shape of the problem: it
 * describes itself as "a picker convenience list, not a registry", with
 * content-derived subjects unioned on top at runtime. This makes it a registry.
 */

export interface ISubject extends Document {
  orgId: string;
  branchId?: string | null;
  name: string;
  code?: string;
  order: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const subjectSchema = new Schema<ISubject>(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

subjectSchema.index({ orgId: 1, name: 1 }, { unique: true });

export default mongoose.model<ISubject>('Subject', subjectSchema);
