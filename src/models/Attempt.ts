import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IAnswerItem {
  questionId: Types.ObjectId; // original question id
  chosenOptionId?: Types.ObjectId; // for MCQ/truefalse
  textAnswer?: string; // for fill/short/long
  isMarkedForReview?: boolean;
  timeSpentSec?: number;
  isCorrect?: boolean; // computed by auto-grader where applicable
  scoreAwarded?: number; // per question score
  rubricScore?: number; // 0..1 for subjective grading
  aiFeedback?: string; // brief AI feedback for subjective answers
  // Teacher's manual per-question mark for THIS student. When set (a number),
  // it overrides the auto-grade/subjective score and PERSISTS through every
  // recompute (gradeAttemptRaw honours it first). Unset (undefined/null) means
  // "fall back to automatic grading". Tracks who/when for the audit trail.
  manualScore?: number;
  manualScoreBy?: Types.ObjectId;
  manualScoreAt?: Date;
  // Monotonic per-attempt sequence number assigned by the client when this
  // answer was made locally (offline-sync ordering/idempotency). A merge is
  // skipped if the stored clientSeq is already >= the incoming one, so a
  // stale/out-of-order queued write can never clobber a newer answer.
  clientSeq?: number;
  clientTs?: Date;
}

export interface IActivityLog {
  at: Date;
  type: 'focus-lost' | 'fullscreen-exit' | 'suspicious' | 'navigation';
  meta?: Record<string, any>;
}

export type AttemptStatus = 'created' | 'in-progress' | 'submitted' | 'auto-submitted' | 'graded';

export interface IAttempt extends Document {
  examId?: Types.ObjectId;  // For teacher-assigned exams
  practiceTestId?: Types.ObjectId;  // For student-created practice tests
  userId: Types.ObjectId;
  mode?: 'practice' | 'live' | 'adaptive';
  startedAt?: Date;
  submittedAt?: Date;
  status: AttemptStatus;
  // Snapshot for randomization per student
  snapshot: {
    sectionOrder: Types.ObjectId[]; // ids of sections in randomized order
    questionOrderBySection: Record<string, Types.ObjectId[]>; // key: sectionId
    optionOrderByQuestion?: Record<string, Types.ObjectId[]>; // key: questionId
    adaptiveState?: {
      asked: Types.ObjectId[];
      currentDifficulty: 'easy' | 'medium' | 'hard';
      topicMix?: Record<string, number>;
    };
  };
  answers: IAnswerItem[];
  totalScore?: number;
  maxScore?: number;
  // Immutable auto/teacher-graded raw values (before any test-level total-marks
  // override). The propagation engine always rescales from these so repeated
  // total-marks edits stay idempotent and never compound.
  rawTotalScore?: number;
  rawMaxScore?: number;
  // Effective percentage (0-100) after any override is applied. Cached so every
  // reader (student portal, analytics, exports) shows the same value.
  percentage?: number;
  // Rank within this exam's attempters (1 = highest), refreshed on every
  // recompute/publish. Standard competition ranking (1,2,2,4).
  rankInTest?: number;
  // Percentile (0-100) within this exam's cohort: the % of attempts this
  // student scored strictly higher than. Refreshed on every recompute.
  percentile?: number;
  resultPublished?: boolean;
  activityLogs?: IActivityLog[];
  lastHeartbeatAt?: Date;
}

const answerSchema = new Schema<IAnswerItem>(
  {
    questionId: { type: Schema.Types.ObjectId, ref: 'Question', required: true },
    chosenOptionId: { type: Schema.Types.ObjectId },
    textAnswer: { type: String },
    isMarkedForReview: { type: Boolean, default: false },
    timeSpentSec: { type: Number, default: 0 },
    isCorrect: { type: Boolean },
    scoreAwarded: { type: Number },
    rubricScore: { type: Number, min: 0, max: 1 },
    aiFeedback: { type: String },
    manualScore: { type: Number },
    manualScoreBy: { type: Schema.Types.ObjectId, ref: 'User' },
    manualScoreAt: { type: Date },
    clientSeq: { type: Number },
    clientTs: { type: Date },
  },
  { _id: false }
);

const attemptSchema = new Schema<IAttempt>(
  {
    examId: { type: Schema.Types.ObjectId, ref: 'Exam', index: true },
    practiceTestId: { type: Schema.Types.ObjectId, ref: 'PracticeTest', index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    startedAt: { type: Date },
    submittedAt: { type: Date },
    status: { type: String, enum: ['created', 'in-progress', 'submitted', 'auto-submitted', 'graded'], default: 'created', index: true },
    snapshot: {
      sectionOrder: [{ type: Schema.Types.ObjectId, required: true }],
      questionOrderBySection: { type: Schema.Types.Mixed, required: true },
      optionOrderByQuestion: { type: Schema.Types.Mixed },
      adaptiveState: {
        asked: [{ type: Schema.Types.ObjectId }],
        currentDifficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
        topicMix: { type: Schema.Types.Mixed },
      },
    },
    mode: { type: String, enum: ['practice', 'live', 'adaptive'], index: true },
    answers: { type: [answerSchema], default: [] },
    totalScore: { type: Number },
    maxScore: { type: Number },
    rawTotalScore: { type: Number },
    rawMaxScore: { type: Number },
    percentage: { type: Number },
    rankInTest: { type: Number },
    percentile: { type: Number },
    resultPublished: { type: Boolean, default: false },
    lastHeartbeatAt: { type: Date },
    activityLogs: [
      {
        at: { type: Date, default: Date.now },
        type: { type: String, enum: ['focus-lost', 'fullscreen-exit', 'suspicious', 'navigation'], required: true },
        meta: { type: Schema.Types.Mixed },
      },
    ],
  },
  { timestamps: true }
);

// Unique index for regular exams (only when examId exists)
attemptSchema.index(
  { examId: 1, userId: 1 }, 
  { unique: true, partialFilterExpression: { examId: { $exists: true, $ne: null } }, name: 'examId_1_userId_1_v2' }
);
// Unique index for practice tests (only when practiceTestId exists)
attemptSchema.index(
  { practiceTestId: 1, userId: 1 }, 
  { unique: true, partialFilterExpression: { practiceTestId: { $exists: true, $ne: null } }, name: 'practiceTestId_1_userId_1_v2' }
);

export default mongoose.model<IAttempt>('Attempt', attemptSchema);
