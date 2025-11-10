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
  // Enhanced metadata for paper creation filtering
  metadata?: {
    class?: string;        // e.g., "Class 10", "Class 11"
    board?: string;        // e.g., "CBSE", "GSEB", "JEE", "NEET"
    chapter?: string;      // Chapter name
    section?: string;      // e.g., "Objective", "Short Answer", "Long Answer"
    marks?: number;        // Default marks for this question
    source?: string;       // e.g., "AI", "Smart Import", "Manual", "Upload"
  };
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
      subject: { type: String, index: true },
      topic: { type: String, index: true },
      difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium', index: true },
    },
    explanation: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    isActive: { type: Boolean, default: true },
    metadata: {
      class: { type: String, index: true },
      board: { type: String, index: true },
      chapter: { type: String, index: true },
      section: { type: String },
      marks: { type: Number },
      source: { type: String, enum: ['AI', 'Smart Import', 'Manual', 'Upload'], default: 'Manual' },
    },
  },
  { timestamps: true }
);

// Enhanced indexes for paper creation filtering
questionSchema.index({ 'tags.subject': 1, 'tags.topic': 1, 'tags.difficulty': 1, createdAt: -1 });
questionSchema.index({ 'metadata.class': 1, 'tags.subject': 1, 'metadata.board': 1 });
questionSchema.index({ 'metadata.chapter': 1, 'tags.subject': 1 });
questionSchema.index({ text: 'text' });

export default mongoose.model<IQuestion>('Question', questionSchema);
