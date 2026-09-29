import mongoose, { Document, Schema } from 'mongoose';

/**
 * A parent's relationship to one student, inside one organization.
 *
 * ── Why a model of its own ──────────────────────────────────────────────────
 * A parent is not a student with a flag, and a child is not a field on the
 * parent: one parent may have three children at an institute, and a child may
 * have two parents with separate accounts. So the relationship is a document —
 * many-to-many, tenant-scoped by the plugin (`orgId` is stamped and filtered
 * like every other tenant model), with a lifecycle of its own.
 *
 * ── The lifecycle ───────────────────────────────────────────────────────────
 *   pending   created when a parent registers (or asks to add a ward) AND the
 *             server has matched the ward's institute-issued student code to
 *             that ward's registered phone number. Grants NOTHING.
 *   verified  an administrator of the organization — or platform staff — has
 *             confirmed it. Only now can the parent read anything about the
 *             student.
 *   revoked   removed by an administrator. Kept, not deleted, so "who could see
 *             this child and when" stays answerable.
 *
 * ── What a client can never do ──────────────────────────────────────────────
 * Choose or change `studentId`. It is set by the server from the verification
 * match and no endpoint accepts it as input for an existing link. A parent who
 * wants another ward creates a NEW pending link, which goes through the same
 * match and the same approval.
 */
export type GuardianLinkStatus = 'pending' | 'verified' | 'revoked';

export interface IGuardianLink extends Document {
  orgId: string;
  parentId: mongoose.Types.ObjectId;
  studentId: mongoose.Types.ObjectId;
  status: GuardianLinkStatus;
  /** How the server matched the ward. Recorded, so an audit can tell. */
  method: 'student-code+phone';
  requestedAt: Date;
  verifiedAt?: Date;
  /** A tenant admin's user id, or a platform staff id — see `verifiedByKind`. */
  verifiedBy?: string;
  verifiedByKind?: 'org-admin' | 'platform';
  revokedAt?: Date;
  revokedBy?: string;
  revokedByKind?: 'org-admin' | 'platform';
}

const guardianLinkSchema = new Schema<IGuardianLink>(
  {
    orgId: { type: String, required: true, index: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    studentId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: ['pending', 'verified', 'revoked'], required: true, default: 'pending', index: true },
    method: { type: String, enum: ['student-code+phone'], required: true },
    requestedAt: { type: Date, default: Date.now },
    verifiedAt: Date,
    verifiedBy: String,
    verifiedByKind: { type: String, enum: ['org-admin', 'platform'] },
    revokedAt: Date,
    revokedBy: String,
    revokedByKind: { type: String, enum: ['org-admin', 'platform'] },
  },
  { timestamps: true },
);

// One relationship per parent per child per organization. A revoked link is
// re-opened as pending rather than duplicated.
guardianLinkSchema.index({ orgId: 1, parentId: 1, studentId: 1 }, { unique: true });

export default mongoose.model<IGuardianLink>('GuardianLink', guardianLinkSchema);
