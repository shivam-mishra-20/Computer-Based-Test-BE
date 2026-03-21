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
