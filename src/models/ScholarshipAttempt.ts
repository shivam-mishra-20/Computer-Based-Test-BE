import mongoose, { Document, Schema } from 'mongoose';

export interface IScholarshipAttempt extends Document {
  attemptId: string;
  name: string;
  phone: string;
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
  questions: string[]; // Store which questions were in the test
  subjectQuestions: Record<string, string[]>; // Questions per subject
}

const ScholarshipAttemptSchema = new Schema(
  {
    attemptId: { type: String, unique: true, required: true, index: true },
    name: { type: String, required: true },
    phone: { type: String, required: true },
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
    questions: [String],
    subjectQuestions: { type: Map, of: [String], default: new Map() },
  },
  { timestamps: true }
);

export default mongoose.model<IScholarshipAttempt>('ScholarshipAttempt', ScholarshipAttemptSchema);
