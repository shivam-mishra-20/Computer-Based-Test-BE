import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * A public learner's attempt at a public test.
 *
 * ── Why this is NOT the existing Attempt model ───────────────────────────────
 * This is the single most important isolation decision in the assessment work.
 *
 * `Attempt` is read by fourteen institute modules, and the audit found queries
 * that are not scoped at all — `teacherRoutes.ts:223` does
 * `Attempt.find({ /* we'd need exam filter *​/ })`, returning EVERY attempt in
 * the database for a teacher's dashboard. Others aggregate across attempts for
 * leaderboards, exam analytics and admin reporting.
 *
 * If public learners wrote into `Attempt`, their results would surface in
 * teacher dashboards, institute leaderboards and admin analytics — silently,
 * and with no filter to add because several of those queries have no scope to
 * narrow. A separate collection makes the leak impossible by construction
 * rather than by discipline.
 *
 * ── What IS reused ───────────────────────────────────────────────────────────
 * The answer shape mirrors `IAnswerItem` closely enough that
 * `gradeObjective(question, answer)` from attemptService grades these
 * unchanged. Scoring stays server-authoritative: the client sends choices, the
 * server decides marks.
 */

export type PublicAttemptStatus = 'in-progress' | 'submitted' | 'auto-submitted';

export interface IPublicAnswer {
  questionId: Types.ObjectId;
  /** MCQ / true-false. */
  chosenOptionId?: Types.ObjectId;
  /** Fill / integer / multi-select (stored as a JSON array of ids). */
  textAnswer?: string;
  markedForReview?: boolean;
  timeSpentSec?: number;

  // ── Server-computed. The client never supplies these. ──
  isCorrect?: boolean;
  scoreAwarded?: number;
}

export interface IPublicAttempt extends Document {
  learnerId: Types.ObjectId;
  testId: Types.ObjectId;

  status: PublicAttemptStatus;
  startedAt: Date;
  submittedAt?: Date;
  /**
   * Absolute deadline, fixed when the attempt is created from the test's
   * duration. The timer is server-owned: a client clock cannot extend it, and a
   * resumed attempt gets the real remaining time rather than a fresh countdown.
   */
  expiresAt: Date;

  /**
   * Per-attempt ordering, resolved at start when the test shuffles. Stored so a
   * resumed attempt shows the same paper in the same order.
   */
  snapshot: {
    questionOrder: Types.ObjectId[];
    optionOrderByQuestion?: Record<string, Types.ObjectId[]>;
  };

  answers: IPublicAnswer[];

  // ── Results. Written once, at submit, by the server. ──
  totalScore?: number;
  maxScore?: number;
  percentage?: number;
  correctCount?: number;
  incorrectCount?: number;
  unattemptedCount?: number;
  /** Time actually spent, for the analysis screen. */
  durationSec?: number;

  /**
   * Per-subject and per-difficulty breakdowns, computed at submit from the
   * questions' own tags. Denormalised so the analysis screen is one read and
   * the history list never re-aggregates.
   */
  bySubject?: {
    subject: string;
    correct: number;
    total: number;
    score: number;
  }[];
  byDifficulty?: { difficulty: string; correct: number; total: number }[];

  createdAt: Date;
  updatedAt: Date;
}

const answerSchema = new Schema<IPublicAnswer>(
  {
    questionId: {
      type: Schema.Types.ObjectId,
      ref: 'Question',
      required: true,
    },
    chosenOptionId: { type: Schema.Types.ObjectId },
    textAnswer: { type: String },
    markedForReview: { type: Boolean, default: false },
    timeSpentSec: { type: Number, default: 0 },
    isCorrect: { type: Boolean },
    scoreAwarded: { type: Number },
  },
  { _id: false },
);

const publicAttemptSchema = new Schema<IPublicAttempt>(
  {
    learnerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    testId: {
      type: Schema.Types.ObjectId,
      ref: 'PublicTest',
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ['in-progress', 'submitted', 'auto-submitted'],
      default: 'in-progress',
      index: true,
    },
    startedAt: { type: Date, default: Date.now },
    submittedAt: { type: Date },
    expiresAt: { type: Date, required: true },

    snapshot: {
      questionOrder: [{ type: Schema.Types.ObjectId }],
      optionOrderByQuestion: { type: Schema.Types.Mixed },
    },

    answers: { type: [answerSchema], default: [] },

    totalScore: { type: Number },
    maxScore: { type: Number },
    percentage: { type: Number },
    correctCount: { type: Number },
    incorrectCount: { type: Number },
    unattemptedCount: { type: Number },
    durationSec: { type: Number },

    bySubject: [
      {
        _id: false,
        subject: String,
        correct: Number,
        total: Number,
        score: Number,
      },
    ],
    byDifficulty: [
      {
        _id: false,
        difficulty: String,
        correct: Number,
        total: Number,
      },
    ],
  },
  { timestamps: true },
);

/** "My attempts", newest first — the history list's only read pattern. */
publicAttemptSchema.index({ learnerId: 1, createdAt: -1 });
/** Resume: does this learner have a live attempt at this test? */
publicAttemptSchema.index({ learnerId: 1, testId: 1, status: 1 });
/** Analytics over a learner's finished attempts. */
publicAttemptSchema.index({ learnerId: 1, status: 1, submittedAt: -1 });

export default mongoose.model<IPublicAttempt>('PublicAttempt', publicAttemptSchema);
