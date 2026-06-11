import mongoose, { Document, Schema, Types, Model } from 'mongoose';

/**
 * Dynamic per-class question schema.
 * We avoid a global Questions collection and instead store questions
 * in collections named by class, e.g., `class_7`, `class_8`, etc.
 *
 * Collection naming: only lowercase letters, numbers and underscores.
 * Example: Class "7" => collection "class_7"; Class "Class 10" => "class_10".
 */

export type ClassQuestionType = 'mcq' | 'truefalse' | 'fill' | 'short' | 'long' | 'assertionreason' | 'integer';
export type ClassDifficulty = 'easy' | 'medium' | 'hard';

export interface IClassOption {
  _id: Types.ObjectId;
  text: string;
  isCorrect?: boolean;
}

export interface IClassQuestion extends Document {
  // Core
  text: string;
  type: ClassQuestionType;
  options?: IClassOption[];
  correctAnswerText?: string;
  integerAnswer?: number;
  assertion?: string;
  reason?: string;
  assertionIsTrue?: boolean;
  reasonIsTrue?: boolean;
  reasonExplainsAssertion?: boolean;

  // Media — legacy flat fields (kept for backward compat)
  diagramUrl?: string;
  diagramAlt?: string;

  // Rich diagram (vector SVG or raster URL)
  diagram?: {
    url?: string;        // Firebase/cloud URL for raster PNG/JPEG
    svgInline?: string;  // Inline SVG string for vector diagrams
    alt?: string;
    kind?: 'image' | 'vector';
    width?: number;
    height?: number;
    pageNumber?: number;
  };

  // Structured table data
  tableData?: {
    headers: string[];
    rows: string[][];
    html: string;
    caption?: string;
    pageNumber?: number;
  };

  // Flat metadata (no nested tags/metadata)
  subject: string;      // e.g., Physics, Mathematics
  board?: string;       // e.g., CBSE
  chapter?: string;     // e.g., Quadrilaterals
  topic?: string;       // optional subtopic
  section?: string;     // e.g., Objective/Short/Long
  marks?: number;       // default marks
  difficulty: ClassDifficulty;

  // Solution / explanation
  explanation?: string;
  solutionText?: string;

  // PYQ (Previous Year Question) metadata
  isPYQ?: boolean;
  pyqYear?: number;
  pyqExam?: string;
  pyqShift?: string;

  // Audit
  createdBy: Types.ObjectId;
  source?: 'AI' | 'Smart Import' | 'Manual' | 'Upload';
  isActive: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const optionSchema = new Schema<IClassOption>(
  {
    text: { type: String, required: true },
    isCorrect: { type: Boolean, default: false },
  },
  { _id: true }
);

export const classQuestionSchema = new Schema<IClassQuestion>(
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

    // Rich diagram — stored as Mixed to support both vector SVG and raster URL
    diagram: { type: mongoose.Schema.Types.Mixed, default: undefined },

    // Structured table — Mixed supports 2D rows array natively
    tableData: { type: mongoose.Schema.Types.Mixed, default: undefined },

    subject: { type: String, index: true, required: true },
    board: { type: String, index: true },
    chapter: { type: String, index: true },
    topic: { type: String, index: true },
    section: { type: String },
    marks: { type: Number },
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium', index: true },

    explanation: { type: String },

    isPYQ: { type: Boolean, default: false, index: true },
    pyqYear: { type: Number, index: true },
    pyqExam: { type: String },
    pyqShift: { type: String },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    source: { type: String, enum: ['AI', 'Smart Import', 'Manual', 'Upload'], default: 'Manual' },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Helpful indexes
classQuestionSchema.index({ subject: 1, board: 1, chapter: 1, type: 1 });
classQuestionSchema.index({ text: 'text' });

// Cache to avoid model recompilation
const modelCache: Record<string, Model<IClassQuestion>> = {};

/**
 * Format a class name to a valid collection id (lowercase, underscores).
 */
export function formatClassCollection(className: string): string {
  const normalized = (className || '').toString().trim().toLowerCase();
  // Extract digits if present, else replace spaces with underscores
  const digits = normalized.match(/\d+/)?.[0];
  if (digits) return `class_${digits}`;
  return `class_${normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

/**
 * Get (or create) a per-class model bound to a specific collection.
 */
export function getClassQuestionModel(className: string): Model<IClassQuestion> {
  const collection = formatClassCollection(className);
  // Use unique model name per collection to avoid name collisions
  const modelName = `ClassQuestion_${collection}`;
  if (modelCache[modelName]) return modelCache[modelName];

  const model = (mongoose.models[modelName] as Model<IClassQuestion>) ||
    mongoose.model<IClassQuestion>(modelName, classQuestionSchema, collection);

  modelCache[modelName] = model;
  return model;
}
