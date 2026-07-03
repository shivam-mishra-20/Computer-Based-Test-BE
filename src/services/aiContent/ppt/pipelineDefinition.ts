/**
 * Two pipeline definitions — the ppt feature is a TWO-PHASE system (v5):
 *
 * PHASE 1 — PLANNING (`buildPptPlanningPipeline`), ends at 'awaiting_approval':
 *   Intent Parsing → Document Processing → Vision Analysis → Content Cleaning
 *   → Layout Understanding → Knowledge Extraction → Semantic Chunking →
 *   Pedagogical Flow Planning → Blueprint Planning (AI Lecture Planner)
 *
 *   Output: an editable LectureBlueprint proposal, persisted on the
 *   AiGeneration doc. The teacher reviews/edits/approves it in the app.
 *
 * PHASE 2 — GENERATION (`buildPptGenerationPipeline`), runs ONLY after
 * approval, with the approved blueprint as the single source of truth:
 *   Blueprint Compilation (deterministic 1:1 expansion into slide briefs) →
 *   Slide Generation (per-slide, reviewed, graceful degradation) → Rendering
 *
 *   Nothing in phase 2 re-decides lecture flow — no budget allocation, no
 *   retrieval/merging, no reordering. What the teacher approved is what gets
 *   generated, slide for slide. (This is why v4's Slide Budget Allocator /
 *   Content Expansion / slot-assignment Retrieval / Slide Planner stages are
 *   gone: the approved blueprint IS the plan.)
 */
import { emptyMetrics } from '../../aiOrchestrator/interfaces';
import type {
  GeneratedSlide,
  KnowledgeChunk,
  PipelineDefinition,
  ResolvedIntent,
  SlideBrief,
  TeachingKnowledgeGraph,
} from '../../aiOrchestrator/interfaces';
import type { UploadFile } from '../types';
import { parseIntent } from './intentParser';
import { documentProcessor } from './documentProcessor';
import { visionClassifier } from './visionClassifier';
import { cleanContent } from './contentCleaner';
import { analyzeLayout } from './layoutAnalyzer';
import { knowledgeExtractor } from './knowledgeExtractor';
import { chunkKnowledgeGraph } from './chunker';
import { planPedagogicalFlow } from './flowPlanner';
import { planBlueprint } from './blueprintPlanner';
import { compileBlueprint } from './blueprintCompiler';
import { generateAllSlides } from './slideGenerationOrchestrator';
import { pptxBuilder } from './pptxBuilder';
import { resolveTheme } from './theme/themeRegistry';
import type { LectureBlueprint } from './blueprint';
import type { RawDocument, VisionPageClassification } from '../../aiOrchestrator/interfaces';
import type { ContentBlock } from './contentCleaner';
import type { LayoutBlock } from './layoutAnalyzer';

export const INTENT_PARSING_STAGE = 'intent_parsing';
export const DOCUMENT_PROCESSING_STAGE = 'document_processing';
export const VISION_ANALYSIS_STAGE = 'vision_analysis';
export const CONTENT_CLEANING_STAGE = 'content_cleaning';
export const LAYOUT_UNDERSTANDING_STAGE = 'layout_understanding';
export const KNOWLEDGE_EXTRACTION_STAGE = 'knowledge_extraction';
export const SEMANTIC_CHUNKING_STAGE = 'semantic_chunking';
export const FLOW_PLANNING_STAGE = 'flow_planning';
export const BLUEPRINT_PLANNING_STAGE = 'blueprint_planning';
export const BLUEPRINT_COMPILATION_STAGE = 'blueprint_compilation';
export const SLIDE_GENERATION_STAGE = 'slide_generation';
export const RENDERING_STAGE = 'rendering';

export function buildPptPlanningPipeline(file: UploadFile | undefined): PipelineDefinition {
  return {
    id: 'ppt.v5.planning',
    stages: [
      {
        name: INTENT_PARSING_STAGE,
        runsForModes: 'all',
        execute: (ctx) => parseIntent(ctx),
      },
      {
        name: DOCUMENT_PROCESSING_STAGE,
        runsForModes: 'all',
        execute: (ctx) => documentProcessor.process(file, ctx),
      },
      {
        name: VISION_ANALYSIS_STAGE,
        runsForModes: 'all', // self-skips internally when there are no raster pages
        execute: (ctx, priorOutputs) => {
          const doc = priorOutputs[DOCUMENT_PROCESSING_STAGE] as RawDocument;
          return visionClassifier.classify(doc.pages, ctx);
        },
      },
      {
        name: CONTENT_CLEANING_STAGE,
        runsForModes: 'all',
        execute: async (_ctx, priorOutputs) => {
          const doc = priorOutputs[DOCUMENT_PROCESSING_STAGE] as RawDocument;
          const visionResult = priorOutputs[VISION_ANALYSIS_STAGE] as VisionPageClassification[];
          return { output: cleanContent(doc, visionResult), metrics: emptyMetrics(), warnings: [] };
        },
      },
      {
        name: LAYOUT_UNDERSTANDING_STAGE,
        runsForModes: 'all',
        execute: async (_ctx, priorOutputs) => {
          const cleaned = priorOutputs[CONTENT_CLEANING_STAGE] as { blocks: ContentBlock[] };
          return analyzeLayout(cleaned.blocks);
        },
      },
      {
        name: KNOWLEDGE_EXTRACTION_STAGE,
        runsForModes: 'all',
        execute: (ctx, priorOutputs) => {
          const layoutBlocks = priorOutputs[LAYOUT_UNDERSTANDING_STAGE] as LayoutBlock[];
          const intent = priorOutputs[INTENT_PARSING_STAGE] as ResolvedIntent;
          // Intent-resolved metadata enriches extraction/synthesis prompts —
          // fields the form left blank but the prompt text implied.
          const options = {
            ...ctx.options,
            subject: intent.subject,
            className: intent.className,
            chapter: intent.chapter,
            language: intent.language,
          };
          return knowledgeExtractor.extract({ layoutBlocks, options }, ctx);
        },
      },
      {
        name: SEMANTIC_CHUNKING_STAGE,
        runsForModes: 'all',
        execute: async (_ctx, priorOutputs) => {
          const graph = priorOutputs[KNOWLEDGE_EXTRACTION_STAGE] as TeachingKnowledgeGraph;
          return { output: chunkKnowledgeGraph(graph), metrics: emptyMetrics(), warnings: [] };
        },
      },
      {
        name: FLOW_PLANNING_STAGE,
        runsForModes: 'all',
        execute: async (ctx, priorOutputs) => {
          const graph = priorOutputs[KNOWLEDGE_EXTRACTION_STAGE] as TeachingKnowledgeGraph;
          const chunks = priorOutputs[SEMANTIC_CHUNKING_STAGE] as KnowledgeChunk[];
          const { chunks: ordered, warnings } = planPedagogicalFlow(chunks, graph, ctx);
          return { output: ordered, metrics: emptyMetrics(), warnings };
        },
      },
      {
        name: BLUEPRINT_PLANNING_STAGE,
        runsForModes: 'all',
        execute: (ctx, priorOutputs) => {
          const graph = priorOutputs[KNOWLEDGE_EXTRACTION_STAGE] as TeachingKnowledgeGraph;
          const chunks = priorOutputs[FLOW_PLANNING_STAGE] as KnowledgeChunk[];
          const intent = priorOutputs[INTENT_PARSING_STAGE] as ResolvedIntent;
          return planBlueprint(graph, chunks, intent, ctx);
        },
      },
    ],
  };
}

export function buildPptGenerationPipeline(
  blueprint: LectureBlueprint,
  graph: TeachingKnowledgeGraph,
): PipelineDefinition {
  return {
    id: 'ppt.v5.generation',
    stages: [
      {
        name: BLUEPRINT_COMPILATION_STAGE,
        runsForModes: 'all',
        execute: async (ctx) => ({
          output: compileBlueprint(blueprint, graph, ctx),
          metrics: emptyMetrics(),
          warnings: [],
        }),
      },
      {
        name: SLIDE_GENERATION_STAGE,
        runsForModes: 'all',
        execute: (ctx, priorOutputs) => {
          const briefs = priorOutputs[BLUEPRINT_COMPILATION_STAGE] as SlideBrief[];
          return generateAllSlides(briefs, graph, ctx);
        },
      },
      {
        name: RENDERING_STAGE,
        runsForModes: 'all',
        execute: (ctx, priorOutputs) => {
          const slides = priorOutputs[SLIDE_GENERATION_STAGE] as GeneratedSlide[];
          const theme = resolveTheme(ctx.options.theme);
          return pptxBuilder.render(slides, theme, ctx);
        },
      },
    ],
  };
}
