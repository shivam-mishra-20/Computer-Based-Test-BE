/**
 * Stage 5 — Knowledge Extraction. Two variants, same output shape:
 *   - Extraction (a file was processed): sequential batches over LayoutBlock[]
 *     text, extraction-ONLY prompt ("extract, never invent"), with a running
 *     topic list carried forward so later batches don't re-extract the same
 *     concept twice.
 *   - Synthesis (Mode 2 / prompt-only, no source content): one call, generates
 *     knowledge units from the teacher's prompt/subject/class/chapter instead
 *     of extracting them — this is what replaces the old whole-deck
 *     pptGenerator.ts call for prompt-only generation.
 *
 * Edges: `assessedBy`/`exampleOf` are inferred deterministically (nearest
 * preceding definition/explanation node sharing the same topic) — cheap and
 * reliable. `prerequisiteOf` is left empty; establishing real prerequisite
 * relationships needs whole-graph reasoning, which belongs to the
 * Pedagogical Flow Planner stage (Phase 3), not extraction.
 */
import crypto from 'crypto';
import { ai, aiConfig, estimateCostUSD, pickModel, promptRegistry, safeParse } from '../../../ai';
import AiGeneration from '../../../models/AiGeneration';
import TeachingKnowledgeGraphModel from '../../../models/TeachingKnowledgeGraph';
import type { LayoutBlock } from './layoutAnalyzer';
import {
  emptyMetrics,
  type ContentType,
  type KnowledgeEdge,
  type KnowledgeExtractor,
  type KnowledgeNode,
  type PipelineContext,
  type SourceProvenance,
  type StageResult,
  type TeachingKnowledgeGraph,
} from '../../aiOrchestrator/interfaces';
import type { PptOptions } from '../types';

const VALID_CONTENT_TYPES: ContentType[] = [
  'objectives', 'definition', 'explanation', 'formula', 'example',
  'solved_example', 'mcq', 'homework', 'summary', 'table', 'note',
];
const BATCH_CHAR_SIZE = 5000;
// Batch cap is config-driven (default 6): a lecture needs the relevant
// chapter, not the whole 125-page book pushed through the model.
const MAX_BATCHES = () => aiConfig.ppt.extractMaxBatches;
// Extraction/synthesis/augmentation run on the planning model (fast by
// default) — the output is teacher-reviewed in the blueprint, so speed wins.
const planningModel = () => pickModel(aiConfig.ppt.planningModel);
// Bumped whenever extraction/synthesis/augmentation prompt behavior changes
// meaningfully enough that a previously-cached TeachingKnowledgeGraph should
// no longer be served — part of the cache key (see contentHashOf), per the
// architecture doc's §19 flagged risk ("cache key must include
// extractionPromptVersion, not just contentHash").
// v2: redesign mode became deterministic page-mirroring (below) — bumping
// invalidates cached graphs built by the old LLM-summarizing redesign path.
const EXTRACTION_VERSION = 'v2';

/**
 * Page-mirror extraction — REDESIGN mode only, zero LLM calls. The uploaded
 * document is the source of truth: every page becomes exactly one node
 * carrying that page's full (noise-cleaned) text verbatim, in page order.
 * Nothing is summarized, merged, dropped or invented — the redesign pipeline
 * exists to rebuild the SAME presentation with better visuals, and any LLM
 * "understanding" pass here was rewriting teachers' content.
 */
function buildPageMirrorNodes(layoutBlocks: LayoutBlock[]): {
  nodes: KnowledgeNode[];
  llmCalls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
} {
  const byPage = new Map<number, LayoutBlock[]>();
  for (const b of layoutBlocks) {
    if (!b.text?.trim()) continue;
    const list = byPage.get(b.pageIndex) || [];
    list.push(b);
    byPage.set(b.pageIndex, list);
  }
  const nodes: KnowledgeNode[] = [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageIndex, blocks]) => {
      const ordered = [...blocks].sort((a, b) => ((a as any).order ?? 0) - ((b as any).order ?? 0));
      const heading = ordered.find((b) => b.role === 'heading')?.text?.trim();
      const firstLine = (ordered[0]?.text || '').split('\n')[0].trim();
      const title = (heading || firstLine || `Slide ${pageIndex + 1}`).slice(0, 100);
      return {
        id: `page-${pageIndex}`,
        topic: title,
        contentType: 'explanation' as const,
        title,
        // Full page text, block order preserved — nodeToGroundingText renders
        // explanations verbatim, so the slide generator sees everything.
        explanations: [ordered.map((b) => b.text.trim()).join('\n\n')],
        provenance: [{ sourceType: 'pdf_page' as const, pageIndex }],
        confidence: 1,
        keep: true,
      };
    });
  return { nodes, llmCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
}

const EXTRACTION_SYSTEM = `You are a precise educational content EXTRACTOR.
You extract structured knowledge units from the exact source content given to you.
You NEVER invent, add, embellish, or infer facts, examples, or questions that are not present in the source.
If the source doesn't contain something (e.g. no MCQs), simply omit that field — do not fabricate it.
You ALWAYS respond with a single valid JSON object and nothing else.`;

const SYNTHESIS_SYSTEM = `You are an experienced teacher creating structured knowledge units for a full classroom lecture, strictly within the given syllabus scope.
You EXPAND, never summarize: rich step-by-step explanations, multiple worked examples, varied practice questions, real-life applications, interesting facts, and memory tips — the kind of depth a great teacher brings to class.
You never repeat the same point twice in different words.
You ALWAYS respond with a single valid JSON object and nothing else.`;

const AUGMENT_SYSTEM = `You are an expert teacher adding a small amount of NEW supplementary content to an already-extracted lecture, per a specific instruction from the teacher.
You add ONLY what the instruction asks for — you NEVER duplicate, restate, or re-derive content that is already covered.
If the instruction requires no new factual content (e.g. it's purely stylistic), you return an empty units array.
You ALWAYS respond with a single valid JSON object and nothing else.`;

export const UNIT_SCHEMA = `{
  "units": [
    {
      "topic": string,                 // groups related units — reuse the SAME topic string for units on the same concept
      "subtopic": string,              // optional
      "contentType": "objectives"|"definition"|"explanation"|"formula"|"example"|"solved_example"|"mcq"|"homework"|"summary"|"table"|"note",
      "title": string,
      "learningObjectives": string[],  // only for contentType "objectives"
      "definitions": [{ "term": string, "definition": string }],
      "explanations": string[],
      "formulae": [{ "expression": string, "description": string }],
      "examples": string[],
      "solvedExamples": [{ "problem": string, "solution": string }],
      "mcqs": [{ "question": string, "options": string[], "answerIndex": number, "explanation": string }],
      "homework": string[],
      "summary": string[],
      "tables": [{ "headers": string[], "rows": [string[]] }],
      "notes": string
    }
  ]
}`;

promptRegistry.register({
  id: 'ppt.knowledgeExtract',
  version: 'v1',
  task: 'generation',
  description: 'Extracts structured KnowledgeNode units from a batch of source content — extraction only, never generates new facts.',
  render: (params: { batchText: string; batchIndex: number; totalBatches: number; runningTopics: string[]; opts: PptOptions }) => [
    { role: 'system', content: EXTRACTION_SYSTEM },
    {
      role: 'user',
      content: [
        `Extract structured knowledge units from this source content. Return EXACTLY this JSON schema:`,
        UNIT_SCHEMA,
        '',
        `This is batch ${params.batchIndex + 1} of ${params.totalBatches}.`,
        params.runningTopics.length
          ? `Topics already extracted in earlier batches (do NOT re-extract these — only extract NEW content from this batch, unless this batch adds genuinely new units for an existing topic): ${params.runningTopics.join(', ')}`
          : '',
        params.opts.subject ? `Subject: ${params.opts.subject}` : '',
        params.opts.className ? `Class/Grade: ${params.opts.className}` : '',
        params.opts.chapter ? `Chapter/Topic scope: ${params.opts.chapter}` : '',
        '',
        `Source content (batch ${params.batchIndex + 1}):`,
        '"""',
        params.batchText,
        '"""',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ],
});

promptRegistry.register({
  id: 'ppt.knowledgeSynthesize',
  version: 'v1',
  task: 'generation',
  description: 'Generates structured KnowledgeNode units from a teacher prompt/topic when no source document is attached (Mode 2 / Smart Generator).',
  render: (params: { opts: PptOptions }) => [
    { role: 'system', content: SYNTHESIS_SYSTEM },
    {
      role: 'user',
      content: [
        `Generate structured educational knowledge units for a lecture. Return EXACTLY this JSON schema:`,
        UNIT_SCHEMA,
        '',
        `Generate a coherent, COMPREHENSIVE set of units: objectives, definitions, step-by-step explanations, formulae (if relevant), multiple examples, solved examples, varied practice questions, real-life applications, interesting facts/memory tips (as "note" units), a summary, and homework.`,
        `Target volume: at least ${Math.min(Math.max(Math.round((Number(params.opts.numSlides) || 10) * 1.5), 8), 45)} distinct units — enough rich material to fill ${Math.min(Math.max(Number(params.opts.numSlides) || 10, 3), 40)} slides WITHOUT stretching thin content. Split large topics into multiple focused sub-topic units rather than one shallow unit.`,
        `STRICT SYLLABUS COMPLIANCE: stay within the syllabus of the given class/subject/chapter; do not include out-of-syllabus, higher-class, or advanced-exam-level content; calibrate difficulty to the class level.`,
        params.opts.subject ? `Subject: ${params.opts.subject}` : '',
        params.opts.className ? `Class/Grade: ${params.opts.className}` : '',
        params.opts.board ? `Board/Curriculum: ${params.opts.board}` : '',
        params.opts.chapter ? `Chapter/Topic: ${params.opts.chapter}` : '',
        params.opts.audience ? `Audience: ${params.opts.audience}` : '',
        `Language: ${params.opts.language || 'English'}.`,
        `Use LaTeX delimited by $...$ for mathematical/scientific notation.`,
        '',
        params.opts.prompt ? `Topic / instructions from the teacher:\n${params.opts.prompt}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ],
});

promptRegistry.register({
  id: 'ppt.knowledgeAugment',
  version: 'v1',
  task: 'generation',
  description: 'Mode 3 (Hybrid) only: adds NEW knowledge units the teacher\'s free-text instruction calls for that are not already covered by the extracted source content (e.g. "add 5 HOTS questions").',
  render: (params: { existingTopics: string[]; opts: PptOptions }) => [
    { role: 'system', content: AUGMENT_SYSTEM },
    {
      role: 'user',
      content: [
        `The following topics have ALREADY been extracted from the teacher's uploaded document: ${params.existingTopics.join(', ') || '(none)'}.`,
        '',
        `The teacher additionally gave this instruction for the deck:\n"${params.opts.prompt}"`,
        '',
        `Generate ONLY genuinely NEW knowledge units this instruction calls for that are NOT already covered above (e.g. extra practice questions, an additional example, a definition the source is missing). Do NOT re-create or restate anything already covered. If the instruction is purely stylistic/tonal and calls for no new factual content, return an empty units array.`,
        `Return EXACTLY this JSON schema:`,
        UNIT_SCHEMA,
        params.opts.subject ? `Subject: ${params.opts.subject}` : '',
        params.opts.className ? `Class/Grade: ${params.opts.className}` : '',
        `STRICT SYLLABUS COMPLIANCE: stay within the syllabus of the given class/subject/chapter; do not include out-of-syllabus or advanced-exam-level content.`,
        `Use LaTeX delimited by $...$ for mathematical/scientific notation.`,
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ],
});

function slug(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'unit';
}

/** Mode is part of the cache key: Mode 3 (hybrid) can append instruction-
 * driven nodes a plain extraction of the identical file wouldn't have, so the
 * same file+prompt run under a different mode must not silently reuse it.
 * Presentation-only fields (numSlides/theme/style/audience/include toggles)
 * are deliberately EXCLUDED — the extracted knowledge is the same regardless
 * of how many slides it's later fitted into; the Content Expansion stage
 * (which runs after the cache) is what adapts a cached graph to a different
 * requested slide count. */
function contentHashOf(mode: string, opts: PptOptions, sourceText?: string): string {
  const basis = JSON.stringify({
    mode,
    prompt: opts.prompt || '',
    subject: opts.subject || '',
    className: opts.className || '',
    board: opts.board || '',
    chapter: opts.chapter || '',
    language: opts.language || '',
    sourceText: sourceText?.slice(0, 5000),
  });
  return crypto.createHash('sha256').update(basis).digest('hex');
}

export function coerceUnit(raw: any, index: number, provenance: SourceProvenance[]): KnowledgeNode | null {
  const contentType: ContentType = VALID_CONTENT_TYPES.includes(raw?.contentType) ? raw.contentType : 'note';
  const topic = String(raw?.topic || raw?.title || '').trim();
  if (!topic) return null;

  return {
    id: `${slug(topic)}-${contentType}-${index}`,
    topic,
    subtopic: raw?.subtopic ? String(raw.subtopic) : undefined,
    contentType,
    title: raw?.title ? String(raw.title) : undefined,
    learningObjectives: Array.isArray(raw?.learningObjectives)
      ? raw.learningObjectives.map(String).filter(Boolean)
      : undefined,
    definitions: Array.isArray(raw?.definitions)
      ? raw.definitions
          .map((d: any) => ({ term: String(d?.term ?? ''), definition: String(d?.definition ?? '') }))
          .filter((d: any) => d.term && d.definition)
      : undefined,
    explanations: Array.isArray(raw?.explanations) ? raw.explanations.map(String).filter(Boolean) : undefined,
    formulae: Array.isArray(raw?.formulae)
      ? raw.formulae
          .map((f: any) => ({ expression: String(f?.expression ?? ''), description: f?.description ? String(f.description) : undefined }))
          .filter((f: any) => f.expression)
      : undefined,
    examples: Array.isArray(raw?.examples) ? raw.examples.map(String).filter(Boolean) : undefined,
    solvedExamples: Array.isArray(raw?.solvedExamples)
      ? raw.solvedExamples
          .map((s: any) => ({ problem: String(s?.problem ?? ''), solution: String(s?.solution ?? '') }))
          .filter((s: any) => s.problem && s.solution)
      : undefined,
    mcqs: Array.isArray(raw?.mcqs)
      ? raw.mcqs
          .map((m: any) => ({
            question: String(m?.question ?? ''),
            options: Array.isArray(m?.options) ? m.options.map(String) : [],
            answerIndex: Number.isFinite(Number(m?.answerIndex)) ? Number(m.answerIndex) : 0,
            explanation: m?.explanation ? String(m.explanation) : undefined,
          }))
          .filter((m: any) => m.question)
      : undefined,
    homework: Array.isArray(raw?.homework) ? raw.homework.map(String).filter(Boolean) : undefined,
    summary: Array.isArray(raw?.summary) ? raw.summary.map(String).filter(Boolean) : undefined,
    tables: Array.isArray(raw?.tables)
      ? raw.tables
          .map((t: any) => ({
            headers: Array.isArray(t?.headers) ? t.headers.map(String) : [],
            rows: Array.isArray(t?.rows) ? t.rows.map((r: any) => (Array.isArray(r) ? r.map(String) : [])) : [],
          }))
          .filter((t: any) => t.headers.length)
      : undefined,
    notes: raw?.notes ? String(raw.notes) : undefined,
    provenance,
    confidence: 1,
    keep: true,
  };
}

/** Deterministic edge inference: assessedBy (mcq -> nearest same-topic concept)
 * and exampleOf (example/solved_example -> nearest same-topic concept). */
function inferEdges(nodes: KnowledgeNode[]): KnowledgeEdge[] {
  const edges: KnowledgeEdge[] = [];
  let lastConceptByTopic = new Map<string, string>();

  for (const node of nodes) {
    if (node.contentType === 'definition' || node.contentType === 'explanation') {
      lastConceptByTopic.set(node.topic, node.id);
    } else if (node.contentType === 'mcq') {
      const conceptId = lastConceptByTopic.get(node.topic);
      if (conceptId) edges.push({ from: node.id, to: conceptId, type: 'assessedBy' });
    } else if (node.contentType === 'example' || node.contentType === 'solved_example') {
      const conceptId = lastConceptByTopic.get(node.topic);
      if (conceptId) edges.push({ from: node.id, to: conceptId, type: 'exampleOf' });
    }
  }
  return edges;
}

function chunkText(text: string, size: number, maxChunks: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length && chunks.length < maxChunks) {
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks;
}

async function extractFromLayoutBlocks(
  layoutBlocks: LayoutBlock[],
  opts: PptOptions,
): Promise<{ nodes: KnowledgeNode[]; tokensIn: number; tokensOut: number; costUsd: number; llmCalls: number }> {
  const fullText = layoutBlocks.map((b) => b.text).join('\n\n');
  const batches = chunkText(fullText, BATCH_CHAR_SIZE, MAX_BATCHES());
  const prompt = promptRegistry.get<any>('ppt.knowledgeExtract');

  const nodes: KnowledgeNode[] = [];
  const runningTopics: string[] = [];
  let tokensIn = 0, tokensOut = 0, costUsd = 0, llmCalls = 0, unitIndex = 0;

  // Sequential, not parallel — each batch's "already covered" list depends on
  // the previous batch's results, to avoid re-extracting the same concept.
  for (let i = 0; i < batches.length; i++) {
    const res = await ai.chat(
      prompt.render({ batchText: batches[i], batchIndex: i, totalBatches: batches.length, runningTopics, opts }),
      { label: `${prompt.id}@${prompt.version}`, model: planningModel(), json: true, maxTokens: 8192 },
    );
    llmCalls++;
    tokensIn += res.usage.promptTokens;
    tokensOut += res.usage.completionTokens;
    costUsd += estimateCostUSD(res.provider, res.usage);

    const parsed = safeParse<{ units?: any[] }>(res.text);
    const units = Array.isArray(parsed?.units) ? parsed!.units! : [];
    const provenance: SourceProvenance[] = [{ sourceType: 'pdf_page' }];
    for (const raw of units) {
      const node = coerceUnit(raw, unitIndex++, provenance);
      if (node) {
        nodes.push(node);
        if (!runningTopics.includes(node.topic)) runningTopics.push(node.topic);
      }
    }
  }

  return { nodes, tokensIn, tokensOut, costUsd, llmCalls };
}

async function synthesizeFromPrompt(
  opts: PptOptions,
): Promise<{ nodes: KnowledgeNode[]; tokensIn: number; tokensOut: number; costUsd: number; llmCalls: number }> {
  const prompt = promptRegistry.get<{ opts: PptOptions }>('ppt.knowledgeSynthesize');
  const res = await ai.chat(prompt.render({ opts }), {
    label: `${prompt.id}@${prompt.version}`,
    model: planningModel(),
    json: true,
    maxTokens: 8192,
  });
  const parsed = safeParse<{ units?: any[] }>(res.text);
  const units = Array.isArray(parsed?.units) ? parsed!.units! : [];
  const nodes = units
    .map((raw, i) => coerceUnit(raw, i, [{ sourceType: 'prompt' }]))
    .filter((n): n is KnowledgeNode => !!n);

  return {
    nodes,
    tokensIn: res.usage.promptTokens,
    tokensOut: res.usage.completionTokens,
    costUsd: estimateCostUSD(res.provider, res.usage),
    llmCalls: 1,
  };
}

/** Mode 3 (Hybrid) only — a second, explicitly-generative pass that adds ONLY
 * new nodes the teacher's free-text instruction calls for beyond what was
 * extracted from the file, grounded against the already-extracted topic list
 * so it doesn't duplicate them. Returns zero nodes when the model finds
 * nothing new to add (e.g. a purely stylistic instruction). */
async function augmentFromInstruction(
  existingNodes: KnowledgeNode[],
  opts: PptOptions,
): Promise<{ nodes: KnowledgeNode[]; tokensIn: number; tokensOut: number; costUsd: number; llmCalls: number }> {
  const existingTopics = Array.from(new Set(existingNodes.map((n) => n.topic)));
  const prompt = promptRegistry.get<{ existingTopics: string[]; opts: PptOptions }>('ppt.knowledgeAugment');
  const res = await ai.chat(prompt.render({ existingTopics, opts }), {
    label: `${prompt.id}@${prompt.version}`,
    model: planningModel(),
    json: true,
    maxTokens: 4096,
  });
  const parsed = safeParse<{ units?: any[] }>(res.text);
  const units = Array.isArray(parsed?.units) ? parsed!.units! : [];
  const nodes = units
    .map((raw, i) => coerceUnit(raw, existingNodes.length + i, [{ sourceType: 'prompt' }]))
    .filter((n): n is KnowledgeNode => !!n);

  return {
    nodes,
    tokensIn: res.usage.promptTokens,
    tokensOut: res.usage.completionTokens,
    costUsd: estimateCostUSD(res.provider, res.usage),
    llmCalls: 1,
  };
}

export const knowledgeExtractor: KnowledgeExtractor = {
  async extract(
    input: { layoutBlocks?: unknown[]; options: PptOptions },
    ctx: PipelineContext,
  ): Promise<StageResult<TeachingKnowledgeGraph>> {
    const layoutBlocks = (input.layoutBlocks as LayoutBlock[] | undefined) || [];
    const hasSource = layoutBlocks.length > 0;
    const sourceText = hasSource ? layoutBlocks.map((b) => b.text).join('\n\n') : undefined;
    const usedVision = layoutBlocks.some((b) => b.source === 'vision');
    const contentHash = contentHashOf(ctx.mode, input.options, sourceText);

    // Cache: an identical source+options+mode was extracted before (within
    // the 90d TTL) — reuse it verbatim, skipping extraction/synthesis (and
    // Mode 3 augmentation, already baked into a cached graph) entirely.
    const cached = await TeachingKnowledgeGraphModel.findOne({ contentHash, ownerId: ctx.ownerId }).lean();
    if (cached && (cached.graph as any)?.metadata?.extractionPromptVersion === EXTRACTION_VERSION) {
      await AiGeneration.updateOne(
        { _id: ctx.generationId },
        { $set: { knowledgeGraphId: cached._id, knowledgeGraphReused: true } },
      );
      return { output: cached.graph as TeachingKnowledgeGraph, metrics: emptyMetrics(), warnings: [] };
    }

    // Redesign = faithful page-mirror (deterministic, no LLM): the uploaded
    // file's pages ARE the content plan. Generate mode keeps real extraction.
    const result = hasSource
      ? ctx.mode === 'redesign'
        ? buildPageMirrorNodes(layoutBlocks)
        : await extractFromLayoutBlocks(layoutBlocks, input.options)
      : await synthesizeFromPrompt(input.options);

    if (!result.nodes.length) {
      throw new Error(
        ctx.mode === 'redesign' && hasSource
          ? 'No readable content was found in the uploaded file. If it is a scanned document, make sure the pages are clear.'
          : 'The model did not return any knowledge units. Try regenerating.',
      );
    }

    // Mode 3 (Hybrid): a file was extracted AND the teacher gave free-text
    // instructions — those instructions can ask for content the file doesn't
    // contain (e.g. "add 5 HOTS questions"). Extraction itself intentionally
    // never invents anything (see EXTRACTION_SYSTEM), so this explicitly
    // generative second pass adds ONLY new nodes the instruction calls for.
    // Skipped for other modes and when there's no instruction text to act on
    // (Mode 2/prompt-only already generates everything via synthesis above).
    let augmented: Awaited<ReturnType<typeof augmentFromInstruction>> | null = null;
    if (hasSource && ctx.mode === 'generate' && input.options.prompt?.trim()) {
      augmented = await augmentFromInstruction(result.nodes, input.options);
    }
    const allNodes = augmented?.nodes.length ? [...result.nodes, ...augmented.nodes] : result.nodes;

    const edges = inferEdges(allNodes);
    const graph: TeachingKnowledgeGraph = {
      version: 2,
      deckTitle: input.options.chapter || input.options.subject || 'Lecture',
      subject: input.options.subject,
      className: input.options.className,
      board: input.options.board,
      chapter: input.options.chapter,
      language: input.options.language,
      nodes: allNodes,
      edges,
      metadata: {
        sourceMode: hasSource ? (input.options.prompt ? 'file+prompt' : 'file') : 'prompt',
        usedVision,
        generatedAt: new Date().toISOString(),
        contentHash,
        extractionPromptId: hasSource ? 'ppt.knowledgeExtract' : 'ppt.knowledgeSynthesize',
        extractionPromptVersion: EXTRACTION_VERSION,
        consumedBy: ['ppt'],
      },
    };

    // Upsert, not create: a hash collision for the SAME owner (e.g. two
    // near-simultaneous identical requests racing the cache lookup above)
    // must not crash the job on the unique index — last writer wins, both
    // jobs still succeed. Filter matches the compound (contentHash, ownerId)
    // unique index exactly — a different owner hashing to the same value
    // gets their own row instead of overwriting this one (see model comment).
    const graphDoc = await TeachingKnowledgeGraphModel.findOneAndUpdate(
      { contentHash, ownerId: ctx.ownerId },
      { $set: { contentHash, ownerId: ctx.ownerId, sourceMeta: { usedVision }, graph } },
      { upsert: true, new: true },
    );
    await AiGeneration.updateOne(
      { _id: ctx.generationId },
      { $set: { knowledgeGraphId: graphDoc._id, knowledgeGraphReused: false } },
    );

    return {
      output: graph,
      metrics: {
        llmCalls: result.llmCalls + (augmented?.llmCalls || 0),
        tokensIn: result.tokensIn + (augmented?.tokensIn || 0),
        tokensOut: result.tokensOut + (augmented?.tokensOut || 0),
        costUsd: result.costUsd + (augmented?.costUsd || 0),
        retries: 0,
      },
      warnings: [],
    };
  },
};
