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
  orgId?: string | null;
  branchId?: string | null;
  name: string;
  /** Lowercased, whitespace-collapsed `name`. Derived, never set directly. */
  nameLower: string;
  code?: string;
  order: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const subjectSchema = new Schema<ISubject>(
  {
    name: { type: String, required: true, trim: true },
    nameLower: { type: String, required: true },
    code: { type: String, trim: true },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

/**
 * Keeps `nameLower` in sync with `name` for every write path — `save`,
 * `create`, AND `insertMany` (`insertMany` validates each doc by default, so
 * this fires there too, which is what makes the console's bulk
 * `setOrganizationConfig` replace get case-insensitive dedup for free).
 */
subjectSchema.pre('validate', function (next) {
  if (typeof this.name === 'string') {
    this.nameLower = this.name.replace(/\s+/g, ' ').trim().toLowerCase();
  }
  next();
});

// Case-insensitive uniqueness per org (or per the shared no-tenant bucket,
// where `orgId` is null for every document — see subjectService.ts). This is
// the real race guard: two simultaneous creates for the same subject collide
// on this index, and the loser is reported back as a conflict rather than
// silently producing a duplicate.
subjectSchema.index({ orgId: 1, nameLower: 1 }, { unique: true });

export default mongoose.model<ISubject>('Subject', subjectSchema);
