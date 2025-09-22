import mongoose, { Document, Schema, Types } from 'mongoose';

export type QuestionType = 'mcq' | 'truefalse' | 'fill' | 'short' | 'long' | 'assertionreason' | 'integer';
export type Difficulty = 'easy' | 'medium' | 'hard';

export interface IOption {
  _id: Types.ObjectId;
  text: string;
  isCorrect?: boolean; // stored, but must never leak via APIs to students
}

export interface IQuestion extends Document {
  text: string;
  type: QuestionType;
  options?: IOption[]; // for MCQ / truefalse if stored as options
  correctAnswerText?: string; // for fill/short/long/integer baseline answer or keywords
  integerAnswer?: number; // for integer type (JEE style)
  assertion?: string; // for assertion-reason
  reason?: string; // for assertion-reason
  assertionIsTrue?: boolean; // evaluation flags
  reasonIsTrue?: boolean;
  reasonExplainsAssertion?: boolean; // if reason correctly explains assertion
  // Optional diagram associated with the question
  diagramUrl?: string;
  diagramAlt?: string;
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
    type: { type: String, enum: ['mcq', 'truefalse', 'fill', 'short', 'long', 'assertionreason', 'integer'], required: true },
    options: { type: [optionSchema], default: undefined },
    correctAnswerText: { type: String },
    integerAnswer: { type: Number },
    assertion: { type: String },
    reason: { type: String },
    assertionIsTrue: { type: Boolean },
    reasonIsTrue: { type: Boolean },
    reasonExplainsAssertion: { type: Boolean },
    diagramUrl: { type: String },
    diagramAlt: { type: String },
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

questionSchema.index({ 'tags.subject': 1, 'tags.topic': 1, 'tags.difficulty': 1, createdAt: -1 });
questionSchema.index({ text: 'text' });

export default mongoose.model<IQuestion>('Question', questionSchema);
