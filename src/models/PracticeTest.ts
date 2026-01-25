import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IDifficultyDistribution {
  easy: number;   // Percentage (0-100)
  medium: number;
  hard: number;
}

export interface IDuration {
  type: 'total' | 'per-question' | 'none';
  totalMins?: number;        // For 'total' type
  perQuestionSecs?: number;  // For 'per-question' type
}

export interface IMarkingScheme {
  correct: number;      // Points for correct answer (+1 default)
  incorrect: number;    // Points for wrong answer (0 default, can be negative)
  unattempted: number;  // Points for unattempted (0 default)
}

export interface IFilters {
  subjects: string[];
  chapters: string[];  // Empty array means "All Chapters"
  difficulty: IDifficultyDistribution;
}

export type PracticeTestStatus = 'created' | 'in-progress' | 'completed';

export interface IPracticeTest extends Document {
  userId: Types.ObjectId;
  title: string;
  classLevel: string;           // Student's class level (e.g., "Class 11")
  filters: IFilters;
  questionCount: number;        // Requested count
  actualQuestionCount: number;  // Actual fetched (may differ if insufficient)
  questionIds: Types.ObjectId[];
  duration: IDuration;
  markingScheme: IMarkingScheme;
  preset?: string;              // Preset name if created from one
  status: PracticeTestStatus;
  insufficientQuestionsWarning?: string;  // Warning message if fewer questions available
  createdAt: Date;
  updatedAt: Date;
}

const difficultyDistributionSchema = new Schema<IDifficultyDistribution>(
  {
    easy: { type: Number, required: true, min: 0, max: 100, default: 30 },
    medium: { type: Number, required: true, min: 0, max: 100, default: 50 },
    hard: { type: Number, required: true, min: 0, max: 100, default: 20 },
  },
  { _id: false }
);

const durationSchema = new Schema<IDuration>(
  {
    type: { type: String, enum: ['total', 'per-question', 'none'], required: true, default: 'none' },
    totalMins: { type: Number, min: 1 },
    perQuestionSecs: { type: Number, min: 10 },
  },
  { _id: false }
);

const markingSchemeSchema = new Schema<IMarkingScheme>(
  {
    correct: { type: Number, required: true, default: 1 },
    incorrect: { type: Number, required: true, default: 0 },
    unattempted: { type: Number, required: true, default: 0 },
  },
  { _id: false }
);

const filtersSchema = new Schema<IFilters>(
  {
    subjects: [{ type: String, required: true }],
    chapters: [{ type: String }], // Empty means all chapters
    difficulty: { type: difficultyDistributionSchema, required: true },
  },
  { _id: false }
);

const practiceTestSchema = new Schema<IPracticeTest>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true },
    classLevel: { type: String, required: true, index: true },
    filters: { type: filtersSchema, required: true },
    questionCount: { type: Number, required: true, min: 1, max: 200 },
    actualQuestionCount: { type: Number, required: true, min: 0 },
    questionIds: [{ type: Schema.Types.ObjectId, ref: 'Question', required: true }],
    duration: { type: durationSchema, required: true },
    markingScheme: { type: markingSchemeSchema, required: true },
    preset: { type: String },
    status: { 
      type: String, 
      enum: ['created', 'in-progress', 'completed'], 
      default: 'created',
      index: true 
    },
    insufficientQuestionsWarning: { type: String },
  },
  { timestamps: true }
);

// Compound indexes for efficient queries
practiceTestSchema.index({ userId: 1, status: 1, createdAt: -1 });
practiceTestSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model<IPracticeTest>('PracticeTest', practiceTestSchema);
