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
import { nodeToGroundingText } from './slideGenerator';
import { indexChunks, retrieveNodeIds } from '../../rag';
import AiGeneration from '../../../models/AiGeneration';
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
export const EMBEDDING_INDEXING_STAGE = 'embedding_indexing';
export const FLOW_PLANNING_STAGE = 'flow_planning';
export const RETRIEVAL_RERANK_STAGE = 'retrieval_rerank';
export const BLUEPRINT_PLANNING_STAGE = 'blueprint_planning';
export const BLUEPRINT_COMPILATION_STAGE = 'blueprint_compilation';
export const SLIDE_GENERATION_STAGE = 'slide_generation';
export const RENDERING_STAGE = 'rendering';

export function buildPptPlanningPipeline(file: UploadFile | undefined): PipelineDefinition {
  return {
    id: 'ppt.v6.planning',
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
        // Vision = noise CLASSIFICATION (photos/handwriting/logos/watermarks),
        // which only matters when redesigning a teacher's own material. Text
        // reading is OCR's job (document_processing) in both modes — so
        // generate mode skips vision entirely: faster, cheaper, one less
        // failure surface.
        runsForModes: ['redesign'],
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
          // Vision stage is skipped entirely in generate mode.
          const visionResult = (priorOutputs[VISION_ANALYSIS_STAGE] as VisionPageClassification[]) || [];
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
        name: EMBEDDING_INDEXING_STAGE,
        // Retrieval only augments GENERATED content — redesign mode mirrors
        // the source document page-for-page and grounds each slide on its own
        // page, so indexing would be pure cost (and its provider errors were
        // leaking into the teacher-facing warnings banner).
        runsForModes: ['generate'],
        execute: async (ctx, priorOutputs) => {
          // RAG indexing: embed the semantic chunks into the vector store,
          // scoped by knowledge-graph id (stable across regenerations of the
          // same content). Retrieval+rerank ground each slide at generation
          // time. Never fatal - on failure generation simply relies on the
          // blueprint's own grounding assignments.
          const graph = priorOutputs[KNOWLEDGE_EXTRACTION_STAGE] as TeachingKnowledgeGraph;
          const chunks = priorOutputs[SEMANTIC_CHUNKING_STAGE] as KnowledgeChunk[];
          const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
          try {
            const doc = await AiGeneration.findById(ctx.generationId).select('knowledgeGraphId').lean();
            const scopeId = String(doc?.knowledgeGraphId || ctx.generationId);
            const indexable = chunks
              .map((c) => ({
                chunkId: c.chunkId,
                text: c.nodeIds
                  .map((id) => nodesById.get(id))
                  .filter(Boolean)
                  .map((n) => nodeToGroundingText(n!))
                  .join('\n\n')
                  .slice(0, 8000),
                nodeIds: c.nodeIds,
                meta: { topic: c.topic },
              }))
              .filter((c) => c.text.trim().length > 0);
            const count = await indexChunks(scopeId, indexable);
            return { output: { scopeId, indexed: count }, metrics: emptyMetrics(), warnings: [] };
          } catch (err: any) {
            // Internal degradation, NOT a teacher problem: slides fall back to
            // the plan's own grounding. Log for ops; never surface provider/
            // model errors (HTTP 410s etc.) in the user-facing warnings.
            console.warn(`[pptPipeline][${ctx.generationId}] RAG indexing skipped: ${err?.message || err}`);
            return {
              output: { scopeId: String(ctx.generationId), indexed: 0 },
              metrics: emptyMetrics(),
              warnings: [],
            };
          }
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
          // Redesign with no explicit slide count mirrors the uploaded
          // document 1:1 — the planner needs its page count for that.
          const doc = priorOutputs[DOCUMENT_PROCESSING_STAGE] as RawDocument | undefined;
          return planBlueprint(graph, chunks, intent, ctx, doc?.pages?.length || undefined);
        },
      },
    ],
  };
}

export function buildPptGenerationPipeline(
  blueprint: LectureBlueprint,
  graph: TeachingKnowledgeGraph,
  ragScopeId?: string,
): PipelineDefinition {
  return {
    id: 'ppt.v6.generation',
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
        name: RETRIEVAL_RERANK_STAGE,
        runsForModes: 'all',
        execute: async (ctx, priorOutputs) => {
          // RAG retrieval: per content slide, pull the most relevant chunks
          // from the vector store (cosine top-K -> NVIDIA reranker) and MERGE
          // their node ids into the brief's grounding. Additive only - the
          // blueprint's explicit assignments always stay; retrieval failure
          // degrades to them untouched.
          const briefs = priorOutputs[BLUEPRINT_COMPILATION_STAGE] as SlideBrief[];
          // Redesign mirrors the source page-for-page — every slide is
          // grounded on its OWN page. Cross-page retrieval would smear
          // content across slides, the opposite of faithful recreation.
          if (!ragScopeId || ctx.mode === 'redesign') {
            return { output: briefs, metrics: emptyMetrics(), warnings: [] };
          }
          let augmented = 0;
          for (const brief of briefs) {
            if (brief.layoutType === 'title' || !brief.sectionSpec) continue;
            try {
              const query = [
                brief.sectionSpec.sectionTitle,
                brief.sectionSpec.kind,
                brief.sectionSpec.notes || '',
              ]
                .filter(Boolean)
                .join(' - ');
              const ids = await retrieveNodeIds(ragScopeId, query, 5);
              if (ids.length) {
                const merged = [...brief.knowledgeNodeIds];
                for (const id of ids) if (!merged.includes(id)) merged.push(id);
                if (merged.length !== brief.knowledgeNodeIds.length) augmented++;
                brief.knowledgeNodeIds = merged.slice(0, 12);
              }
            } catch (err: any) {
              // Internal degradation (store/embeddings down) — slides keep the
              // plan's own grounding. Ops log only; never a teacher-facing
              // warning full of provider error codes.
              console.warn(`[pptPipeline][${ctx.generationId}] retrieval unavailable — using plan grounding: ${err?.message || err}`);
              break; // a hard failure means the store/embeddings are down - stop trying per-slide
            }
          }
          if (augmented) console.log(`[pptPipeline] RAG retrieval augmented grounding on ${augmented} slide(s)`);
          return { output: briefs, metrics: emptyMetrics(), warnings: [] };
        },
      },
      {
        name: SLIDE_GENERATION_STAGE,
        runsForModes: 'all',
        execute: (ctx, priorOutputs) => {
          const briefs = priorOutputs[RETRIEVAL_RERANK_STAGE] as SlideBrief[];
          return generateAllSlides(briefs, graph, ctx);
        },
      },
      {
        name: RENDERING_STAGE,
        runsForModes: 'all',
        execute: (ctx, priorOutputs) => {
          const slides = priorOutputs[SLIDE_GENERATION_STAGE] as GeneratedSlide[];
          const theme = resolveTheme(ctx.options.theme, (ctx.options as any).themeOverrides);
          return pptxBuilder.render(slides, theme, ctx);
        },
      },
    ],
  };
}
