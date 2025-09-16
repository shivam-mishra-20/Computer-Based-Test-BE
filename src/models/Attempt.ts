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
}

export interface IActivityLog {
  at: Date;
  type: 'focus-lost' | 'fullscreen-exit' | 'suspicious' | 'navigation';
  meta?: Record<string, any>;
}

export type AttemptStatus = 'created' | 'in-progress' | 'submitted' | 'auto-submitted' | 'graded';

export interface IAttempt extends Document {
  examId: Types.ObjectId;
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
  resultPublished?: boolean;
  activityLogs?: IActivityLog[];
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
  },
  { _id: false }
);

const attemptSchema = new Schema<IAttempt>(
  {
    examId: { type: Schema.Types.ObjectId, ref: 'Exam', required: true, index: true },
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
    resultPublished: { type: Boolean, default: false },
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

attemptSchema.index({ examId: 1, userId: 1 }, { unique: true });

export default mongoose.model<IAttempt>('Attempt', attemptSchema);
