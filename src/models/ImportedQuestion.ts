import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IImportedQuestion extends Document {
  // Basic question data
  text: string;
  type: 'mcq' | 'truefalse' | 'fill' | 'short' | 'long' | 'assertionreason' | 'integer';
  subject?: string;
  topic?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  
  // MCQ specific fields
  options?: Array<{
    text: string;
    isCorrect: boolean;
  }>;
  
  // Other answer types
  correctAnswerText?: string;
  integerAnswer?: number;
  
  // Assertion-Reason specific
  assertion?: string;
  reason?: string;
  assertionIsTrue?: boolean;
  reasonIsTrue?: boolean;
  reasonExplainsAssertion?: boolean;
  
  // Diagram
  diagramUrl?: string;
  
  // Import metadata
  importBatch: Types.ObjectId; // Reference to ImportBatch
  originalText: string; // Raw extracted text before processing
  confidence: number; // AI confidence score (0-1)
  needsReview: boolean; // Flag for manual review
  
  // Enhanced metadata (for paper creation)
  class?: string;
  board?: string;
  chapter?: string;
  section?: string;
  marks?: number;
  
  // Processing status
  status: 'extracted' | 'processed' | 'reviewed' | 'approved' | 'rejected';
  
  // Question source info
  pageNumber?: number;
  questionNumber?: string; // Original question number from paper
  
  // Admin fields
  extractedBy: Types.ObjectId; // Admin who imported
  reviewedBy?: Types.ObjectId; // Admin who reviewed
  createdAt: Date;
  updatedAt: Date;
}

export interface IImportBatch extends Document {
  // Batch metadata
  fileName: string;
  originalFileName: string;
  fileType: 'pdf' | 'image';
  fileSize: number;
  
  // Processing info
  totalPages: number;
  totalQuestions: number;
  processedQuestions: number;
  approvedQuestions: number;
  rejectedQuestions: number;
  
  // Status tracking
  status: 'uploading' | 'processing' | 'completed' | 'failed';
  processingStarted?: Date;
  processingCompleted?: Date;
  
  // Error handling
  processingErrors?: Array<{
    page?: number;
    error: string;
    timestamp: Date;
  }>;
  
  // OCR and AI metadata
  // 'nvidia-vision' is the current provider; legacy values kept so historical
  // records still validate.
  ocrProvider: 'pdf-parse' | 'nvidia-vision' | 'tesseract' | 'google-vision' | 'groq' | 'gemini';
  processingModel: string;
  totalProcessingTime?: number; // milliseconds

  // Smart Import review buffer (services/importPreview): the extracted
  // questions, gzipped JSON, until the teacher saves them or it expires.
  // `select: false` — never part of an ordinary batch read or response.
  previewData?: Buffer;
  previewExpiresAt?: Date;

  // What this record tracks. Absent/'smart-import' = a Smart Import upload;
  // 'ai-generate' = a background AI question-generation job
  // (services/aiGenerationJobs), which Smart Import listings exclude.
  kind?: 'smart-import' | 'ai-generate';
  // Background-job progress (ai-generate): current step, the page being read,
  // and a liveness beat so a job that died with its process is reported as
  // interrupted instead of "processing" forever.
  stage?: 'queued' | 'reading' | 'ocr' | 'generating' | 'completed' | 'failed';
  currentPage?: number;
  heartbeatAt?: Date;
  errorCode?: string;
  errorMessage?: string;
  // ai-generate: the request's form fields and the generator's metadata,
  // returned with the questions exactly as the synchronous endpoint does.
  generationOptions?: Record<string, unknown>;
  generationMetadata?: Record<string, unknown>;

  // Admin fields
  uploadedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const importedQuestionSchema = new Schema<IImportedQuestion>(
  {
    text: { type: String, required: true },
    type: { 
      type: String, 
      enum: ['mcq', 'truefalse', 'fill', 'short', 'long', 'assertionreason', 'integer'],
      required: true 
    },
    subject: { type: String, index: true },
    topic: { type: String, index: true },
    difficulty: { 
      type: String, 
      enum: ['easy', 'medium', 'hard'], 
      default: 'medium' 
    },
    
    // Answer fields
    options: [{
      text: { type: String, required: true },
      isCorrect: { type: Boolean, required: true }
    }],
    correctAnswerText: { type: String },
    integerAnswer: { type: Number },
    
    // Assertion-Reason fields
    assertion: { type: String },
    reason: { type: String },
    assertionIsTrue: { type: Boolean },
    reasonIsTrue: { type: Boolean },
    reasonExplainsAssertion: { type: Boolean },
    
  // Diagram
  diagramUrl: { type: String },
    
    // Import metadata
    importBatch: { type: Schema.Types.ObjectId, ref: 'ImportBatch', required: true, index: true },
    originalText: { type: String, required: true },
    confidence: { type: Number, min: 0, max: 1, default: 0.5 },
    needsReview: { type: Boolean, default: false, index: true },
    
    // Enhanced metadata for paper creation
    class: { type: String, index: true },
    board: { type: String, index: true },
    chapter: { type: String, index: true },
    section: { type: String },
    marks: { type: Number },
    
    // Status tracking
    status: { 
      type: String, 
      enum: ['extracted', 'processed', 'reviewed', 'approved', 'rejected'],
      default: 'extracted',
      index: true
    },
    
    // Source info
    pageNumber: { type: Number },
    questionNumber: { type: String },
    
    // Admin references
    extractedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

const importBatchSchema = new Schema<IImportBatch>(
  {
    fileName: { type: String, required: true },
    originalFileName: { type: String, required: true },
    fileType: { type: String, enum: ['pdf', 'image'], required: true },
    fileSize: { type: Number, required: true },
    
    totalPages: { type: Number, default: 0 },
    totalQuestions: { type: Number, default: 0 },
    processedQuestions: { type: Number, default: 0 },
    approvedQuestions: { type: Number, default: 0 },
    rejectedQuestions: { type: Number, default: 0 },
    
    status: { 
      type: String, 
      enum: ['uploading', 'processing', 'completed', 'failed'],
      default: 'uploading',
      index: true
    },
    processingStarted: { type: Date },
    processingCompleted: { type: Date },
    
    processingErrors: [{
      page: { type: Number },
      error: { type: String, required: true },
      timestamp: { type: Date, default: Date.now }
    }],
    
  ocrProvider: { type: String, enum: ['pdf-parse', 'nvidia-vision', 'tesseract', 'google-vision', 'groq', 'gemini'], default: 'pdf-parse' },
    processingModel: { type: String, default: 'nvidia-llama-3.3-nemotron-super-49b' },
    totalProcessingTime: { type: Number },

    previewData: { type: Buffer, select: false },
    previewExpiresAt: { type: Date },

    kind: { type: String, enum: ['smart-import', 'ai-generate'] },
    stage: { type: String, enum: ['queued', 'reading', 'ocr', 'generating', 'completed', 'failed'] },
    currentPage: { type: Number },
    heartbeatAt: { type: Date },
    errorCode: { type: String },
    errorMessage: { type: String },
    generationOptions: { type: Schema.Types.Mixed },
    generationMetadata: { type: Schema.Types.Mixed },

    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Indexes for efficient queries
importedQuestionSchema.index({ importBatch: 1, status: 1 });
importedQuestionSchema.index({ extractedBy: 1, createdAt: -1 });
importedQuestionSchema.index({ needsReview: 1, status: 1 });
importedQuestionSchema.index({ subject: 1, topic: 1, difficulty: 1 });

importBatchSchema.index({ uploadedBy: 1, createdAt: -1 });
importBatchSchema.index({ status: 1, createdAt: -1 });

// Virtual for question count
importBatchSchema.virtual('questionCount', {
  ref: 'ImportedQuestion',
  localField: '_id',
  foreignField: 'importBatch',
  count: true
});

export const ImportedQuestion = mongoose.model<IImportedQuestion>('ImportedQuestion', importedQuestionSchema);
export const ImportBatch = mongoose.model<IImportBatch>('ImportBatch', importBatchSchema);