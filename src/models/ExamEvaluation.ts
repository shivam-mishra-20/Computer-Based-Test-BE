import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * ExamEvaluation
 * ----------------
 * Test-level evaluation record (one per Exam). This is the missing first-class
 * "test" entity for the Teacher Review module. It owns everything that is
 * decided at the level of the whole test rather than a single attempt:
 *   - the official total marks (override) and how it propagates,
 *   - exam-scoped objective answer-key corrections (non-destructive: the shared
 *     question bank is never mutated),
 *   - the publish-state machine, and
 *   - an append-only version history of every publish/republish event.
 *
 * The per-attempt scores still live on the Attempt; this record is the source
 * of truth for how those attempts are scaled and presented.
 */

export type ReviewState = 'draft' | 'under_review' | 'published' | 'republished';
export type OverrideMode = 'scale' | 'denominator';

export interface IAnswerKeyOverride {
  // Option-based objective questions (mcq / multi / truefalse / assertion).
  optionIds?: string[];
  // Text/numeric/fill questions.
  correctText?: string;
}

// Test-level marking scheme (e.g. +4 correct / -1 incorrect / 0 not attempted).
export interface IMarkingScheme {
  correct: number;
  incorrect: number;
  unattempted: number;
}

// Optional per-question marks override (lets a teacher weight individual
// questions differently from the test default).
export interface IQuestionMarks {
  correct?: number;
  incorrect?: number;
  unattempted?: number;
}

export interface IEvaluationVersion {
  version: number;
  event: 'created' | 'recompute' | 'total_marks_changed' | 'answer_key_changed' | 'marking_scheme_changed' | 'question_marks_changed' | 'published' | 'republished' | 'unpublished' | 'state_changed';
  reviewState: ReviewState;
  totalMarks?: number;
  note?: string;
  by?: Types.ObjectId;
  at: Date;
  // Lightweight stats snapshot at the time of the event (for the history view).
  stats?: {
    totalAttempts?: number;
    avgScore?: number;
    avgPercentage?: number;
    highest?: number;
    lowest?: number;
  };
}

export interface IEvaluationStats {
  totalAttempts: number;
  pendingReviews: number;
  gradedAttempts: number;
  avgScore: number;
  avgPercentage: number;
  highest: number;
  lowest: number;
  // Percentage-band distribution: keys 0-9,10-19,...,90-100.
  distribution: Record<string, number>;
  lastRecomputedAt?: Date;
}

export interface IExamEvaluation extends Document {
  examId: Types.ObjectId;
  reviewState: ReviewState;
  // Official total marks for the whole test. null => use the computed base
  // (sum of per-question max). Setting this rescales/relabels every attempt.
  totalMarksOverride?: number | null;
  overrideMode: OverrideMode;
  // Immutable computed base total (sum of per-question max) captured at the
  // last recompute, so rescaling is always idempotent from a stable base.
  baseTotalMarks?: number;
  // Test-level marking scheme applied during grading.
  markingScheme: IMarkingScheme;
  // Per-question marks overrides, keyed by questionId.
  questionMarks: Map<string, IQuestionMarks>;
  // Exam-scoped objective answer-key corrections, keyed by questionId.
  answerKeyOverrides: Map<string, IAnswerKeyOverride>;
  publishedAt?: Date | null;
  publishedBy?: Types.ObjectId | null;
  // True when marks/answer key changed since the last publish and a republish
  // is pending (used to surface "changes not yet published" in the UI).
  pendingRepublish: boolean;
  versions: IEvaluationVersion[];
  stats: IEvaluationStats;
  createdAt: Date;
  updatedAt: Date;
}

const answerKeyOverrideSchema = new Schema<IAnswerKeyOverride>(
  {
    optionIds: { type: [String], default: undefined },
    correctText: { type: String },
  },
  { _id: false }
);

const questionMarksSchema = new Schema<IQuestionMarks>(
  {
    correct: { type: Number },
    incorrect: { type: Number },
    unattempted: { type: Number },
  },
  { _id: false }
);

const versionSchema = new Schema<IEvaluationVersion>(
  {
    version: { type: Number, required: true },
    event: {
      type: String,
      enum: ['created', 'recompute', 'total_marks_changed', 'answer_key_changed', 'marking_scheme_changed', 'question_marks_changed', 'published', 'republished', 'unpublished', 'state_changed'],
      required: true,
    },
    reviewState: { type: String, enum: ['draft', 'under_review', 'published', 'republished'], required: true },
    totalMarks: { type: Number },
    note: { type: String },
    by: { type: Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
    stats: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const examEvaluationSchema = new Schema<IExamEvaluation>(
  {
    examId: { type: Schema.Types.ObjectId, ref: 'Exam', required: true, unique: true, index: true },
    reviewState: {
      type: String,
      enum: ['draft', 'under_review', 'published', 'republished'],
      default: 'draft',
      index: true,
    },
    totalMarksOverride: { type: Number, default: null },
    overrideMode: { type: String, enum: ['scale', 'denominator'], default: 'scale' },
    baseTotalMarks: { type: Number },
    markingScheme: {
      correct: { type: Number, default: 1 },
      incorrect: { type: Number, default: 0 },
      unattempted: { type: Number, default: 0 },
    },
    questionMarks: {
      type: Map,
      of: questionMarksSchema,
      default: () => new Map(),
    },
    answerKeyOverrides: {
      type: Map,
      of: answerKeyOverrideSchema,
      default: () => new Map(),
    },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    pendingRepublish: { type: Boolean, default: false },
    versions: { type: [versionSchema], default: [] },
    stats: {
      totalAttempts: { type: Number, default: 0 },
      pendingReviews: { type: Number, default: 0 },
      gradedAttempts: { type: Number, default: 0 },
      avgScore: { type: Number, default: 0 },
      avgPercentage: { type: Number, default: 0 },
      highest: { type: Number, default: 0 },
      lowest: { type: Number, default: 0 },
      distribution: { type: Schema.Types.Mixed, default: () => ({}) },
      lastRecomputedAt: { type: Date },
    },
  },
  { timestamps: true }
);

export default mongoose.model<IExamEvaluation>('ExamEvaluation', examEvaluationSchema);
