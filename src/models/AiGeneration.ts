import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * PPT mode is a fast-moving field: the app sends it, legacy values live in old
 * rows, and new modes get added over time. A hard schema `enum` here turns any
 * code/process skew (a running server behind the deployed code) into a
 * user-facing "validation failed" hard error — this bit production three times.
 *
 * Instead the field is SELF-HEALING: a normalizing setter maps every possible
 * value — new, legacy, or unknown — to one of the two canonical modes on
 * assignment, so a save can NEVER be rejected for a bad mode. Kept inline (not
 * imported from services/) to avoid a model→service layering dependency; it
 * mirrors services/aiContent/ppt/modes.ts normalizePptMode (single behavior,
 * two trivial call sites).
 */
const MODE_MAP: Record<string, string> = {
  generate: 'generate',
  redesign: 'redesign',
  smart_generator: 'generate',
  hybrid: 'generate',
  modernizer: 'redesign',
  teacher_enhancement: 'redesign',
};
function normalizeModeValue(raw: unknown): string {
  return MODE_MAP[String(raw ?? '').trim()] || 'generate';
}

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
/** Only meaningful for feature:'ppt'. v6 has exactly two modes; the legacy
 * v4/v5 strings remain in the enum so historical rows stay valid — every code
 * path normalizes via ppt/modes.ts normalizePptMode(). */
export type AiPptMode =
  | 'generate'
  | 'redesign'
  | 'modernizer'
  | 'smart_generator'
  | 'hybrid'
  | 'teacher_enhancement';

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
  /** Slides finished so far in an in-flight generation phase — lets a BullMQ
   * retry (or a worker restart) resume where it stopped instead of
   * regenerating every slide. Cleared when the deck completes. */
  partialSlides?: Record<string, any>[];
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
    /** Overall completion 0-100 (stages done / total) — for lightweight polls. */
    progressPercentage?: number;
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
    // Valid values: queued | processing | awaiting_approval | completed | failed.
    // No enum — status is set only by our own worker/controller (never user
    // input), and a hard enum would reject a future status under version skew.
    status: {
      type: String,
      default: 'processing',
      index: true,
    },
    title: { type: String },
    inputPrompt: { type: String },
    options: { type: Schema.Types.Mixed, default: {} },
    contentJSON: { type: Schema.Types.Mixed },
    partialSlides: { type: Schema.Types.Mixed },
    artifactUrl: { type: String },
    storagePath: { type: String },
    pdfArtifactUrl: { type: String },
    pdfStoragePath: { type: String },
    fileName: { type: String },
    mimeType: { type: String },
    usedVision: { type: Boolean, default: false },
    error: { type: String },
    // No enum on purpose — a normalizing setter guarantees a canonical value,
    // so a save is never rejected for a mode string (see normalizeModeValue).
    mode: {
      type: String,
      set: normalizeModeValue,
    },
    knowledgeGraphId: { type: Schema.Types.ObjectId, ref: 'TeachingKnowledgeGraph' },
    knowledgeGraphReused: { type: Boolean, default: false },
    blueprint: { type: Schema.Types.Mixed },
    blueprintApprovedAt: { type: Date },
    pipeline: {
      currentStage: { type: String },
      stageDetail: { type: String },
      progressPercentage: { type: Number },
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
