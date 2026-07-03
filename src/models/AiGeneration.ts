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
/** 'queued' = enqueued for the async PPT pipeline, not yet picked up by a worker.
 * 'awaiting_approval' = phase 1 (AI Lecture Planner) produced a Lecture
 * Blueprint; generation starts only after the teacher approves it. */
export type AiStatus = 'queued' | 'processing' | 'awaiting_approval' | 'completed' | 'failed';
/** Only meaningful for feature:'ppt'. Drives which pipeline behavior runs. */
export type AiPptMode = 'modernizer' | 'smart_generator' | 'hybrid' | 'teacher_enhancement';

export interface AiPipelineStageMetrics {
  llmCalls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  retries: number;
  confidence?: number;
}

export interface AiPipelineStage {
  name: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  startedAt?: Date;
  finishedAt?: Date;
  error?: string;
  metrics?: AiPipelineStageMetrics;
}

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
  /** Lazily-created PDF rendition of a completed ppt (see exportPdf). */
  pdfArtifactUrl?: string;
  pdfStoragePath?: string;
  fileName?: string;
  mimeType?: string;
  /** Whether the vision model was used to read an uploaded document. */
  usedVision?: boolean;
  error?: string;
  /** feature:'ppt' only — which pipeline mode this generation runs. */
  mode?: AiPptMode;
  /** ref TeachingKnowledgeGraph — set once Knowledge Extraction has run. */
  knowledgeGraphId?: Types.ObjectId;
  /** The Lecture Blueprint (LectureBlueprint JSON). Phase 1 stores the AI
   * proposal here; approval overwrites it with the teacher's edited version,
   * which is then the single source of truth for generation. */
  blueprint?: Record<string, any>;
  blueprintApprovedAt?: Date;
  /** True when Knowledge Extraction reused a cached graph (same content+mode
   * hash) instead of re-running extraction — skips the two most expensive
   * LLM stages. Surfaced in history as a "reused" indicator. */
  knowledgeGraphReused?: boolean;
  /** Async pipeline state (feature:'ppt'). Checkpointed by AiOrchestratorService. */
  pipeline?: {
    currentStage: string;
    /** Fine-grained progress within the current stage, e.g. "Writing slide 7 of 15". */
    stageDetail?: string;
    stages: AiPipelineStage[];
    warnings: string[];
  };
  visionSummary?: { totalRegions: number; kept: number; removed: number; optional: number };
  /** BullMQ job id backing this generation, for cancellation lookup. */
  jobId?: string;
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
      enum: ['queued', 'processing', 'awaiting_approval', 'completed', 'failed'],
      default: 'processing',
      index: true,
    },
    title: { type: String },
    inputPrompt: { type: String },
    options: { type: Schema.Types.Mixed, default: {} },
    contentJSON: { type: Schema.Types.Mixed },
    artifactUrl: { type: String },
    storagePath: { type: String },
    pdfArtifactUrl: { type: String },
    pdfStoragePath: { type: String },
    fileName: { type: String },
    mimeType: { type: String },
    usedVision: { type: Boolean, default: false },
    error: { type: String },
    mode: {
      type: String,
      enum: ['modernizer', 'smart_generator', 'hybrid', 'teacher_enhancement'],
    },
    knowledgeGraphId: { type: Schema.Types.ObjectId, ref: 'TeachingKnowledgeGraph' },
    knowledgeGraphReused: { type: Boolean, default: false },
    blueprint: { type: Schema.Types.Mixed },
    blueprintApprovedAt: { type: Date },
    pipeline: {
      currentStage: { type: String },
      stageDetail: { type: String },
      stages: [
        {
          _id: false,
          name: { type: String, required: true },
          status: {
            type: String,
            enum: ['pending', 'running', 'done', 'failed', 'skipped'],
            required: true,
          },
          startedAt: { type: Date },
          finishedAt: { type: Date },
          error: { type: String },
          metrics: {
            _id: false,
            llmCalls: { type: Number },
            tokensIn: { type: Number },
            tokensOut: { type: Number },
            costUsd: { type: Number },
            retries: { type: Number },
            confidence: { type: Number },
          },
        },
      ],
      warnings: [{ type: String }],
    },
    visionSummary: {
      _id: false,
      totalRegions: { type: Number },
      kept: { type: Number },
      removed: { type: Number },
      optional: { type: Number },
    },
    jobId: { type: String, index: true },
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
