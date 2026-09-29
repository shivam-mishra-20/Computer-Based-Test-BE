import mongoose, { Document, Schema } from 'mongoose';

export interface IScholarshipAttempt extends Document {
  attemptId: string;
  name: string;
  phone: string;
  phoneNormalized?: string;
  attemptAccessKey?: string;
  scholarshipTestId?: string;
  scholarshipTestName?: string;
  scholarshipShareLink?: string;
  resultPublicToken?: string;
  classLevel: number;
  durationMins: number;
  startedAt: Date;
  submittedAt?: Date;
  status: 'in-progress' | 'submitted';
  answers: Array<{
    questionId: string;
    chosenOptionId?: string;
    textAnswer?: string;
    isCorrect?: boolean;
    marks?: number;
    markedForReview?: boolean;
  }>;
  totalScore?: number;
  maxScore?: number;
  resultPublished?: boolean;
  adminReview?: {
    isReviewed: boolean;
    reviewedBy?: string;
    reviewedAt?: Date;
    notes?: string;
  };
  scholarshipAward?: {
    percentage?: number;
    earlyBirdDiscountPercentage?: number;
    amount?: number;
    notes?: string;
    updatedBy?: string;
    updatedAt?: Date;
  };
  batch?: string; // Batch assignment (e.g., "Batch A", "Morning Session", etc.)
  batchAssignedAt?: Date; // When batch was assigned
  batchAssignedBy?: string; // Admin who assigned the batch
  questions: string[]; // Store which questions were in the test
  subjectQuestions: Record<string, string[]>; // Questions per subject

  // ── AGTS (Abhigyan Gurukul Test Series) ──────────────────────────────────
  // This collection is the test engine's attempt store and keeps its original
  // name so no migration is needed. AGTS attempts are marked by `program`;
  // everything below is optional, so legacy scholarship attempts are untouched.
  program?: 'agts' | 'scholarship';
  leadId?: mongoose.Types.ObjectId;
  /** Server-computed scoring snapshot (assessmentScoring). Never client input. */
  scoring?: {
    correct: number;
    incorrect: number;
    skipped: number;
    ungraded: number;
    percentage: number;
    accuracy: number;
    timeTakenSec: number;
    gradedAt: Date;
    version: number;
  };
  /** Server-computed report (assessmentAnalytics.analyzeAttempt). */
  analysis?: Record<string, unknown>;
  autoSubmitted?: boolean;
  submitReason?: 'candidate' | 'time-up' | 'expired' | 'focus-violations';
}

const ScholarshipAttemptSchema = new Schema(
  {
    attemptId: { type: String, unique: true, required: true, index: true },
    name: { type: String, required: true },
    phone: { type: String, required: true },
    phoneNormalized: { type: String, index: true },
    attemptAccessKey: { type: String, default: '', index: true },
    scholarshipTestId: { type: String, index: true },
    scholarshipTestName: { type: String, default: '' },
    scholarshipShareLink: { type: String, default: '', index: true },
    resultPublicToken: { type: String, default: '', index: true },
    classLevel: { type: Number, required: true, min: 7, max: 12 },
    durationMins: { type: Number, default: 60 },
    startedAt: { type: Date, default: Date.now },
    submittedAt: { type: Date, default: null },
    status: { type: String, enum: ['in-progress', 'submitted'], default: 'in-progress' },
    answers: [
      {
        questionId: String,
        chosenOptionId: String,
        textAnswer: String,
        isCorrect: Boolean,
        marks: Number,
        markedForReview: Boolean,
      },
    ],
    totalScore: { type: Number, default: 0 },
    maxScore: { type: Number, default: 0 },
    resultPublished: { type: Boolean, default: false },
    adminReview: {
      isReviewed: { type: Boolean, default: false },
      reviewedBy: { type: String, default: '' },
      reviewedAt: { type: Date, default: null },
      notes: { type: String, default: '' },
    },
    scholarshipAward: {
      percentage: { type: Number, default: 0 },
      earlyBirdDiscountPercentage: { type: Number, default: 0 },
      amount: { type: Number, default: 0 },
      notes: { type: String, default: '' },
      updatedBy: { type: String, default: '' },
      updatedAt: { type: Date, default: null },
    },
    batch: { type: String, default: null, index: true },
    batchAssignedAt: { type: Date, default: null },
    batchAssignedBy: { type: String, default: '' },
    questions: [String],
    subjectQuestions: { type: Map, of: [String], default: new Map() },

    program: { type: String, enum: ['agts', 'scholarship'], index: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', index: true },
    scoring: {
      type: new Schema(
        {
          correct: Number,
          incorrect: Number,
          skipped: Number,
          ungraded: Number,
          percentage: Number,
          accuracy: Number,
          timeTakenSec: Number,
          gradedAt: Date,
          version: Number,
        },
        { _id: false }
      ),
      default: undefined,
    },
    analysis: { type: Schema.Types.Mixed, default: undefined },
    autoSubmitted: { type: Boolean },
    submitReason: { type: String, enum: ['candidate', 'time-up', 'expired', 'focus-violations'] },
  },
  { timestamps: true }
);

// Enforce: only one attempt per phone per scholarship test (for non-legacy records).
// Partial index keeps legacy attempts (missing scholarshipTestId/phoneNormalized) unaffected.
ScholarshipAttemptSchema.index(
  { phoneNormalized: 1, scholarshipTestId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      phoneNormalized: { $exists: true, $ne: '' },
      scholarshipTestId: { $exists: true, $ne: '' },
    },
  }
);

export default mongoose.model<IScholarshipAttempt>('ScholarshipAttempt', ScholarshipAttemptSchema);
