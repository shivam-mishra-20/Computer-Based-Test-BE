import mongoose, { Document, Schema } from 'mongoose';

/**
 * Academic and operational policy, per organization.
 *
 * ── Why one document and not five collections ───────────────────────────────
 * ClassLevel, Subject and OrgRoom each got their own collection because each is
 * a REFERENCED ENTITY with its own lifecycle — records point at them, they are
 * listed, ordered, activated and deactivated independently.
 *
 * Policy is not like that. Nothing references "the marking scheme"; it is read
 * as a unit whenever an exam is created, it changes as a set, and splitting it
 * into `ExamPolicy`, `GradingPolicy`, `AttendancePolicy` collections would mean
 * four reads to answer one question and four documents to keep consistent. One
 * document per organization, read once, is the honest shape.
 *
 * ── Every field is OPTIONAL, and that is deliberate ─────────────────────────
 * An absent field means "use the platform default", and the platform defaults
 * are exactly today's hardcoded values. So an organization with no policy
 * document — which is every organization right now — behaves precisely as
 * production does today. Configuration starts applying when someone configures
 * something, never as a side effect of this model existing.
 */

export interface IMarkingScheme {
  correct?: number;
  incorrect?: number;
  unattempted?: number;
}

export interface IExamPolicy {
  markingScheme?: IMarkingScheme;
  /** % of the duration that must elapse before a voluntary submit is allowed. */
  submitLockPercent?: number;
  defaultDurationMins?: number;
  lateEntryMins?: number;
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
  antiCheat?: boolean;
  /** Violations tolerated before auto-submit. */
  violationThreshold?: number;
}

export interface IGradingPolicy {
  passPercentage?: number;
  /** Ordered, highest first: [{ grade: 'A+', minPercent: 90 }, …] */
  gradeBands?: { grade: string; minPercent: number }[];
}

export interface IAttendancePolicy {
  officialInTime?: string;
  officialOutTime?: string;
  graceMinutes?: number;
  fullDayMinHours?: number;
  partialFullDayMinHours?: number;
  halfTimeRequiredHours?: number;
  lateDeductionPct?: number;
}

export interface ILeavePolicy {
  annualQuota?: number;
  requiresApproval?: boolean;
}

/**
 * Batch display rules.
 *
 * Replaces the hardcoded `MERGED_BATCH_NAME = 'Advanced/Basic'` and the
 * `isAdvancedLabel`/`isBasicLabel` predicates in `batchConfigService.ts`, which
 * fold two specific Abhigyan batch names into one combined label. A coaching
 * institute running JEE-Main / JEE-Adv / NEET / Foundation has no such pairing,
 * and today the merge simply never fires for them — harmless by luck rather
 * than by design.
 */
export interface IBatchPolicy {
  /** e.g. [{ merge: ['Advanced','Basic'], into: 'Advanced/Basic' }] */
  mergeRules?: { merge: string[]; into: string }[];
}

export interface ILocalePolicy {
  timezone?: string;
  currency?: string;
  language?: string;
}

export interface IOrgPolicy extends Document {
  orgId: string;
  branchId?: string | null;
  exam?: IExamPolicy;
  grading?: IGradingPolicy;
  attendance?: IAttendancePolicy;
  leave?: ILeavePolicy;
  batch?: IBatchPolicy;
  locale?: ILocalePolicy;
  createdAt: Date;
  updatedAt: Date;
}

const orgPolicySchema = new Schema<IOrgPolicy>(
  {
    exam: {
      type: {
        markingScheme: {
          type: { correct: Number, incorrect: Number, unattempted: Number },
          required: false,
          _id: false,
        },
        submitLockPercent: Number,
        defaultDurationMins: Number,
        lateEntryMins: Number,
        shuffleQuestions: Boolean,
        shuffleOptions: Boolean,
        antiCheat: Boolean,
        violationThreshold: Number,
      },
      required: false,
      _id: false,
    },
    grading: {
      type: {
        passPercentage: Number,
        gradeBands: [{ grade: String, minPercent: Number, _id: false }],
      },
      required: false,
      _id: false,
    },
    attendance: {
      type: {
        officialInTime: String,
        officialOutTime: String,
        graceMinutes: Number,
        fullDayMinHours: Number,
        partialFullDayMinHours: Number,
        halfTimeRequiredHours: Number,
        lateDeductionPct: Number,
      },
      required: false,
      _id: false,
    },
    leave: {
      type: { annualQuota: Number, requiresApproval: Boolean },
      required: false,
      _id: false,
    },
    batch: {
      type: {
        mergeRules: [{ merge: [String], into: String, _id: false }],
      },
      required: false,
      _id: false,
    },
    locale: {
      type: { timezone: String, currency: String, language: String },
      required: false,
      _id: false,
    },
  },
  { timestamps: true },
);

// One policy document per organization.
orgPolicySchema.index({ orgId: 1 }, { unique: true });

export default mongoose.model<IOrgPolicy>('OrgPolicy', orgPolicySchema);
