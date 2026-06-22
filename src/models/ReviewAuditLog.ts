import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * ReviewAuditLog
 * --------------
 * Permanent, append-only audit trail for every Teacher Review modification.
 *
 * This is deliberately SEPARATE from the generic `AuditLog` model, which has a
 * 30-day TTL index and would purge evaluation history. Review/grading changes
 * must remain traceable indefinitely, so this collection has NO TTL.
 *
 * Every entry captures who changed what, the previous value, the new value and
 * when — satisfying the "Audit & Change History" requirement.
 */

export type ReviewAuditAction =
  | 'total_marks_changed'
  | 'answer_key_changed'
  | 'marking_scheme_changed'
  | 'question_marks_changed'
  | 'subjective_score_changed'
  | 'manual_score_changed'
  | 'attempt_published'
  | 'attempt_unpublished'
  | 'state_changed'
  | 'recompute'
  | 'bulk_publish'
  | 'bulk_recompute'
  | 'bulk_approve_subjective'
  | 'attempt_deleted'
  | 'dedupe';

export interface IReviewAuditLog extends Document {
  examId: Types.ObjectId;
  attemptId?: Types.ObjectId; // present for per-attempt actions
  questionId?: string; // present for answer-key / subjective changes
  studentId?: Types.ObjectId;
  actorId?: Types.ObjectId; // teacher/admin who made the change
  actorName?: string;
  action: ReviewAuditAction;
  field?: string; // e.g. 'totalMarks', 'scoreAwarded', 'reviewState'
  oldValue?: any;
  newValue?: any;
  note?: string;
  meta?: Record<string, any>;
  createdAt: Date;
}

const reviewAuditLogSchema = new Schema<IReviewAuditLog>(
  {
    examId: { type: Schema.Types.ObjectId, ref: 'Exam', required: true, index: true },
    attemptId: { type: Schema.Types.ObjectId, ref: 'Attempt', index: true },
    questionId: { type: String },
    studentId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    actorName: { type: String },
    action: { type: String, required: true, index: true },
    field: { type: String },
    oldValue: { type: Schema.Types.Mixed },
    newValue: { type: Schema.Types.Mixed },
    note: { type: String },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Common access pattern: history for one exam, newest first. (No TTL on purpose.)
reviewAuditLogSchema.index({ examId: 1, createdAt: -1 });

export default mongoose.model<IReviewAuditLog>('ReviewAuditLog', reviewAuditLogSchema);
