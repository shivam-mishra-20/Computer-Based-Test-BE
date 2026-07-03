/**
 * Contract layer for the AI PPT multi-stage pipeline. No logic lives here —
 * only the shapes stages exchange and the seven boundaries the architecture
 * calls out as independently swappable later (real RAG, a different vision
 * provider, a different rendering engine) without touching the orchestrator
 * or any other stage. Internal deterministic helpers (content cleaning,
 * layout heuristics, slide planning, theme lookup) are NOT interfaced here —
 * they stay concrete calls the orchestrator still wraps for checkpointing/
 * metrics, per the explicit seven-interface scope in the architecture doc.
 */
import type { PptOptions, RenderedArtifact, UploadFile } from '../aiContent/types';

// ── Cross-cutting envelope ──────────────────────────────────────────────────

/** Every interface method returns this — bakes observability into the contract. */
export interface StageResult<T> {
  output: T;
  metrics: {
    llmCalls: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    retries: number;
    confidence?: number;
  };
  warnings: string[];
}

export function emptyMetrics(): StageResult<never>['metrics'] {
  return { llmCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, retries: 0 };
}

export type PptMode = 'modernizer' | 'smart_generator' | 'hybrid' | 'teacher_enhancement';

export interface PipelineContext {
  generationId: string;
  ownerId: string;
  mode: PptMode;
  options: PptOptions;
  /** Stage id -> pinned prompt version, for reproducibility/audit. */
  promptVersions?: Record<string, string>;
  /** Fine-grained mid-stage progress (e.g. "Writing slide 7 of 15") — wired by
   * the worker to Socket.IO + AiGeneration.pipeline.stageDetail. Optional and
   * best-effort: stages must never fail because progress reporting failed. */
  progress?: (detail: string, current?: number, total?: number) => void;
}

// ── Intent Parsing ───────────────────────────────────────────────────────────

/** The user's request, resolved into structured metadata. Form fields ALWAYS
 * win over anything parsed from the prompt text — the parser only fills gaps.
 * `targetSlideCount` is mandatory downstream: the Budget Allocator plans for
 * exactly this many slides. */
export interface ResolvedIntent {
  subject?: string;
  className?: string;
  chapter?: string;
  language?: string;
  teachingStyle?: string;
  intent: 'teach' | 'revise' | 'assess' | 'summarize' | 'general';
  targetSlideCount: number;
  outputMode: PptMode;
}

// NOTE: v4's SlideBudget/BudgetCategory/PlannedChunk/RetrievalService types
// were removed with the v5 two-phase redesign — the teacher-approved Lecture
// Blueprint (services/aiContent/ppt/blueprint.ts) replaced automatic budget
// allocation and slot assignment as the single source of truth for structure.

// ── Document Processing ─────────────────────────────────────────────────────

export interface RawPage {
  pageIndex: number;
  /** Raw text layer, if any (digital PDF / PPTX / DOCX text run extraction). */
  text?: string;
  /** Rasterized page image, when available (scanned PDF pages, embedded media). */
  imageBuffer?: Buffer;
  imageMimeType?: string;
}

export interface RawDocument {
  pages: RawPage[];
  sourceType: 'pdf' | 'pptx' | 'docx' | 'image' | 'prompt';
}

export interface DocumentProcessor {
  process(file: UploadFile | undefined, ctx: PipelineContext): Promise<StageResult<RawDocument>>;
}

// ── Vision Analysis ──────────────────────────────────────────────────────────

export type RegionLabel = 'KEEP' | 'REMOVE' | 'OPTIONAL';
export type NoiseReason =
  | 'handwriting'
  | 'marker_annotation'
  | 'watermark'
  | 'scanner_border'
  | 'camera_shadow'
  | 'staple_fold_mark'
  | 'source_logo'
  | 'source_page_furniture'
  | 'blank_margin'
  | 'none';

export interface VisionRegion {
  regionId: string;
  bbox: [number, number, number, number]; // normalized 0-1
  label: RegionLabel;
  noiseReason: NoiseReason;
  regionType: 'text_block' | 'diagram' | 'table' | 'photo' | 'handwriting' | 'logo' | 'unclear';
  verbatimText?: string;
  diagramPlaceholder?: string;
  confidence: number;
}

export interface VisionPageClassification {
  pageIndex: number;
  regions: VisionRegion[];
  pageLevelNote?: string;
}

export interface VisionClassifier {
  classify(pages: RawPage[], ctx: PipelineContext): Promise<StageResult<VisionPageClassification[]>>;
}

// ── Knowledge Extraction → Teaching Knowledge Graph ─────────────────────────

export type ContentType =
  | 'objectives'
  | 'definition'
  | 'explanation'
  | 'formula'
  | 'example'
  | 'solved_example'
  | 'mcq'
  | 'homework'
  | 'summary'
  | 'table'
  | 'note';

export type EdgeType = 'prerequisiteOf' | 'partOfTopic' | 'relatedTo' | 'exampleOf' | 'assessedBy';
export interface KnowledgeEdge {
  from: string;
  to: string;
  type: EdgeType;
}

export interface SourceProvenance {
  sourceType: 'pdf_page' | 'pptx_shape' | 'docx_paragraph' | 'image' | 'prompt';
  pageIndex?: number;
  shapeId?: string;
  bbox?: [number, number, number, number];
  visionRegionId?: string;
}

export interface KnowledgeNode {
  id: string;
  suggestedSlideNumber?: number;
  chapter?: string;
  topic: string;
  subtopic?: string;
  contentType: ContentType;
  title?: string;
  subtitle?: string;
  learningObjectives?: string[];
  definitions?: { term: string; definition: string }[];
  explanations?: string[];
  formulae?: { expression: string; description?: string }[];
  examples?: string[];
  solvedExamples?: { problem: string; solution: string }[];
  mcqs?: { question: string; options: string[]; answerIndex: number; explanation?: string }[];
  homework?: string[];
  summary?: string[];
  tables?: { headers: string[]; rows: string[][] }[];
  notes?: string;
  provenance: SourceProvenance[];
  confidence: number;
  keep: boolean;
}

export type TeachingKnowledgeGraphFeature = 'ppt' | 'question_paper' | 'notes' | 'worksheet';

export interface TeachingKnowledgeGraph {
  version: 2;
  deckTitle?: string;
  subject?: string;
  className?: string;
  board?: string;
  chapter?: string;
  language?: string;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  metadata: {
    sourceMode: 'file' | 'prompt' | 'file+prompt';
    usedVision: boolean;
    generatedAt: string;
    contentHash: string;
    extractionPromptId: string;
    extractionPromptVersion: string;
    consumedBy: TeachingKnowledgeGraphFeature[];
  };
}

export interface KnowledgeExtractor {
  extract(
    input: { layoutBlocks?: unknown[]; options: PptOptions },
    ctx: PipelineContext,
  ): Promise<StageResult<TeachingKnowledgeGraph>>;
}

// ── Semantic Chunking → Pedagogical Flow Planner ────────────────────────────

/** One topic-grouped slice of the graph (Semantic Chunking's output). The
 * Pedagogical Flow Planner re-orders these (and the node order within each)
 * in place — same shape in, same shape out, only `order`/`nodeIds` change. */
export interface KnowledgeChunk {
  chunkId: string;
  topic: string;
  nodeIds: string[];
  order: number;
}

// ── Slide Generation ─────────────────────────────────────────────────────────

export type SlideLayoutType =
  | 'title'
  | 'objectives'
  | 'definition_card'
  | 'formula_highlight'
  | 'example_box'
  | 'solved_example'
  | 'mcq_card'
  | 'content_bullets'
  | 'table'
  | 'summary_card'
  | 'homework';

/** What the approved Lecture Blueprint dictates for ONE slide within its
 * section — compiled by blueprintCompiler.ts, consumed verbatim by the slide
 * generator prompt. `kind` is a blueprint SectionKind (string here to keep
 * the orchestrator layer decoupled from ppt/blueprint.ts). */
export interface SlideSectionSpec {
  sectionId: string;
  sectionTitle: string;
  kind: string;
  positionInSection: number; // 1-based
  sectionSlideCount: number;
  explanationDepth?: 'brief' | 'standard' | 'in_depth';
  exampleTarget?: number;
  questionTypes?: string[];
  difficulty?: string;
  /** How many questions THIS slide must carry (section total ÷ slides). */
  questionTarget?: number;
  activityDescription?: string;
  notes?: string;
}

export interface SlideBrief {
  slideIndex: number;
  layoutType: SlideLayoutType;
  title: string;
  knowledgeNodeIds: string[];
  priorSlideTitle?: string;
  nextSlideTitle?: string;
  /** Present when the deck was compiled from an approved Lecture Blueprint —
   * the single source of truth for what this slide must contain. */
  sectionSpec?: SlideSectionSpec;
  modeInstructions: {
    preserveWordingCloseToSource: boolean;
    allowRewriteAndCondense: boolean;
    extraTeacherInstruction?: string;
  };
}

export interface GeneratedSlide {
  slideIndex: number;
  layoutType: SlideLayoutType;
  title: string;
  subtitle?: string;
  bullets?: string[];
  definitionCard?: { term: string; definition: string }[];
  formulaBox?: { expression: string; description?: string }[];
  exampleBox?: { text: string }[];
  solvedExample?: { problem: string; solution: string };
  mcq?: { question: string; options: string[]; answerIndex: number }[];
  table?: { headers: string[]; rows: string[][] };
  speakerNotes?: string;
}

/** Prior attempt + Reviewer's issues, fed back in on a retry round. */
export interface SlideGenerationFeedback {
  previousSlide: GeneratedSlide;
  issues: string[];
}

export interface SlideGenerator {
  generateSlide(
    brief: SlideBrief,
    groundingNodes: KnowledgeNode[],
    ctx: PipelineContext,
    feedback?: SlideGenerationFeedback,
  ): Promise<StageResult<GeneratedSlide>>;
}

// ── Review ────────────────────────────────────────────────────────────────────

export interface SlideReviewResult {
  pass: boolean;
  issues: string[];
}

export interface Reviewer {
  review(
    slide: GeneratedSlide,
    groundingNodes: KnowledgeNode[],
    ctx: PipelineContext,
  ): Promise<StageResult<SlideReviewResult>>;
}

// ── Theme + Rendering ────────────────────────────────────────────────────────

export interface ThemeJSON {
  id: string;
  name: string;
  colors: {
    bg: string;
    surface: string;
    title: string;
    body: string;
    accentPrimary: string;
    accentSecondary: string;
    muted: string;
  };
  typography: { headingFont: string; bodyFont: string; headingSizePt: number; bodySizePt: number };
  cardStyles: Record<
    'definition' | 'formula' | 'example' | 'mcq' | 'summary' | 'question',
    { fill: string; border: string; iconId?: string }
  >;
  iconMap: Record<ContentType, string>;
}

export interface PptRenderer {
  render(
    slides: GeneratedSlide[],
    theme: ThemeJSON,
    ctx: PipelineContext,
  ): Promise<StageResult<RenderedArtifact & { previewHtml: string }>>;
}

// ── Orchestration ─────────────────────────────────────────────────────────────

export interface PipelineStageDefinition {
  name: string;
  runsForModes: PptMode[] | 'all';
  execute: (ctx: PipelineContext, priorOutputs: Record<string, unknown>) => Promise<StageResult<unknown>>;
}

export interface PipelineDefinition {
  id: string;
  stages: PipelineStageDefinition[];
}
