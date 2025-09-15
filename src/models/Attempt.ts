import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IAnswerItem {
  questionId: Types.ObjectId; // original question id
  chosenOptionId?: Types.ObjectId; // for MCQ/truefalse
  textAnswer?: string; // for fill/short/long
  isMarkedForReview?: boolean;
  timeSpentSec?: number;
  isCorrect?: boolean; // computed by auto-grader where applicable
  scoreAwarded?: number; // per question score
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
  startedAt?: Date;
  submittedAt?: Date;
  status: AttemptStatus;
  // Snapshot for randomization per student
  snapshot: {
    sectionOrder: Types.ObjectId[]; // ids of sections in randomized order
    questionOrderBySection: Record<string, Types.ObjectId[]>; // key: sectionId
    optionOrderByQuestion?: Record<string, Types.ObjectId[]>; // key: questionId
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
    },
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
