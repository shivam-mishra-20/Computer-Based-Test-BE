import mongoose, { Document, Schema, Types } from 'mongoose';

export type QuestionType = 'mcq' | 'truefalse' | 'fill' | 'short' | 'long';
export type Difficulty = 'easy' | 'medium' | 'hard';

export interface IOption {
  _id: Types.ObjectId;
  text: string;
  isCorrect?: boolean; // stored, but must never leak via APIs to students
}

export interface IQuestion extends Document {
  text: string;
  type: QuestionType;
  options?: IOption[]; // for MCQ
  correctAnswerText?: string; // for fill/short/long baseline answer or keywords
  tags: {
    subject?: string;
    topic?: string;
    difficulty?: Difficulty;
  };
  explanation?: string;
  createdBy: Types.ObjectId;
  isActive: boolean;
}

const optionSchema = new Schema<IOption>(
  {
    text: { type: String, required: true },
    isCorrect: { type: Boolean, default: false },
  },
  { _id: true }
);

const questionSchema = new Schema<IQuestion>(
  {
    text: { type: String, required: true },
    type: { type: String, enum: ['mcq', 'truefalse', 'fill', 'short', 'long'], required: true },
    options: { type: [optionSchema], default: undefined },
    correctAnswerText: { type: String },
    tags: {
      subject: { type: String },
      topic: { type: String },
      difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium', index: true },
    },
    explanation: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model<IQuestion>('Question', questionSchema);
