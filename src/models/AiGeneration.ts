import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * History record for the Teacher AI Content Generator. One row per generation
 * (PPT, question paper, …). This is a brand-new collection — it does not touch
 * any existing schema. The rendered artifact is persisted to Firebase Storage
 * and its public URL stored here so History "Download" just re-opens the URL,
 * while `contentJSON` keeps the structured output for preview/regenerate.
 */
export type AiFeature = 'ppt' | 'question_paper' | 'notes' | 'worksheet';
export type AiSource = 'prompt' | 'pdf' | 'pptx' | 'docx' | 'image';
export type AiStatus = 'processing' | 'completed' | 'failed';

export interface IAiGeneration extends Document {
  feature: AiFeature;
  source: AiSource;
  status: AiStatus;
  title?: string;
  inputPrompt?: string;
  options: Record<string, any>;
  /** Structured AI output (slide deck / paper JSON) for preview + regenerate. */
  contentJSON?: Record<string, any>;
  /** Public URL of the rendered artifact in Firebase Storage. */
  artifactUrl?: string;
  /** Storage path inside the bucket (kept so Delete can remove the object). */
  storagePath?: string;
  fileName?: string;
  mimeType?: string;
  /** Whether the vision model was used to read an uploaded document. */
  usedVision?: boolean;
  error?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const aiGenerationSchema = new Schema<IAiGeneration>(
  {
    feature: {
      type: String,
      enum: ['ppt', 'question_paper', 'notes', 'worksheet'],
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: ['prompt', 'pdf', 'pptx', 'docx', 'image'],
      required: true,
    },
    status: {
      type: String,
      enum: ['processing', 'completed', 'failed'],
      default: 'processing',
      index: true,
    },
    title: { type: String },
    inputPrompt: { type: String },
    options: { type: Schema.Types.Mixed, default: {} },
    contentJSON: { type: Schema.Types.Mixed },
    artifactUrl: { type: String },
    storagePath: { type: String },
    fileName: { type: String },
    mimeType: { type: String },
    usedVision: { type: Boolean, default: false },
    error: { type: String },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

aiGenerationSchema.index({ createdBy: 1, createdAt: -1 });

export default mongoose.model<IAiGeneration>('AiGeneration', aiGenerationSchema);
