/**
 * Composes slideGenerator + reviewer into the "Slide Generation" pipeline
 * stage. Briefs arrive pre-compiled from the approved Lecture Blueprint
 * (blueprintCompiler.ts) — this stage only writes/reviews each one, never
 * re-plans. Per-slide fan-out via the existing ai/batch.ts runBatch
 * (concurrency-limited); each slide's own generate→review→retry cycle is
 * independent of the others.
 *
 * The title slide is built deterministically (no grounding nodes, nothing to
 * generate or review) — only content slides go through the LLM.
 *
 * Retry-with-feedback mirrors paperGenerator.ts's existing top-up loop
 * exactly: bounded attempts, feed the Reviewer's issues back as "fix only
 * these", and on exhaustion KEEP the last version + flag `needsReview`
 * rather than fail the job — one bad slide must never sink the whole deck.
 *
 * Graceful degradation: when generation fails ENTIRELY for a brief (all
 * per-item retries exhausted, e.g. persistent unparseable JSON), the slide is
 * NOT dropped — a deterministic fallback slide is built straight from the
 * grounding nodes' own text, so the deck keeps its full slide count and the
 * teacher gets the material (unpolished) plus a warning, instead of a hole.
 *
 * Per-slide progress ("Writing slide 7 of 15") is reported through
 * ctx.progress — best-effort, wired by the worker to Socket.IO + Mongo.
 */
import { runBatch } from '../../../ai';
import { emptyMetrics } from '../../aiOrchestrator/interfaces';
import type {
  GeneratedSlide,
  KnowledgeNode,
  PipelineContext,
  SlideBrief,
  SlideGenerationFeedback,
  StageResult,
  TeachingKnowledgeGraph,
} from '../../aiOrchestrator/interfaces';
import { slideGenerator } from './slideGenerator';
import { reviewer } from './slideReviewer';
import { latexToUnicode } from './pptxBuilder';

const MAX_ATTEMPTS = 3; // 1 initial generation + up to 2 feedback-driven retries

type Metrics = StageResult<unknown>['metrics'];

function accumulate(target: Metrics, add: Metrics): void {
  target.llmCalls += add.llmCalls;
  target.tokensIn += add.tokensIn;
  target.tokensOut += add.tokensOut;
  target.costUsd += add.costUsd;
  target.retries += add.retries;
}

function buildTitleSlide(brief: SlideBrief, graph: TeachingKnowledgeGraph): GeneratedSlide {
  return {
    slideIndex: brief.slideIndex,
    layoutType: 'title',
    title: brief.title,
    subtitle: [graph.subject, graph.className, graph.chapter].filter(Boolean).join(' • ') || undefined,
  };
}

/** Zero-LLM fallback when generation failed entirely for a brief: surface the
 * grounding nodes' own text as plain bullets so the deck keeps its full slide
 * count with real (if unpolished) material rather than a missing slide. */
function buildFallbackSlide(brief: SlideBrief, groundingNodes: KnowledgeNode[]): GeneratedSlide {
  const bullets: string[] = [];
  for (const node of groundingNodes) {
    if (node.learningObjectives) bullets.push(...node.learningObjectives);
    if (node.definitions) bullets.push(...node.definitions.map((d) => `${d.term}: ${d.definition}`));
    if (node.explanations) bullets.push(...node.explanations);
    if (node.formulae) bullets.push(...node.formulae.map((f) => `${f.expression}${f.description ? ` — ${f.description}` : ''}`));
    if (node.examples) bullets.push(...node.examples);
    if (node.solvedExamples) bullets.push(...node.solvedExamples.map((s) => `${s.problem} → ${s.solution}`));
    if (node.mcqs) bullets.push(...node.mcqs.map((m) => m.question));
    if (node.homework) bullets.push(...node.homework);
    if (node.summary) bullets.push(...node.summary);
    if (node.notes) bullets.push(node.notes);
  }
  return {
    slideIndex: brief.slideIndex,
    layoutType: 'content_bullets',
    title: brief.title,
    bullets: bullets.map((b) => latexToUnicode(String(b))).filter(Boolean).slice(0, 8),
  };
}

async function generateAndReviewSlide(
  brief: SlideBrief,
  nodesById: Map<string, KnowledgeNode>,
  ctx: PipelineContext,
): Promise<{ slide: GeneratedSlide; metrics: Metrics; warnings: string[] }> {
  const groundingNodes = brief.knowledgeNodeIds
    .map((id) => nodesById.get(id))
    .filter((n): n is KnowledgeNode => !!n);

  const totalMetrics = emptyMetrics();
  let feedback: SlideGenerationFeedback | undefined;
  let slide: GeneratedSlide | null = null;
  let issues: string[] = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const genResult = await slideGenerator.generateSlide(brief, groundingNodes, ctx, feedback);
    accumulate(totalMetrics, genResult.metrics);
    slide = genResult.output;

    const reviewResult = await reviewer.review(slide, groundingNodes, ctx);
    accumulate(totalMetrics, reviewResult.metrics);

    if (reviewResult.output.pass) {
      return { slide, metrics: totalMetrics, warnings: [] };
    }
    issues = reviewResult.output.issues;
    if (attempt < MAX_ATTEMPTS - 1) {
      feedback = { previousSlide: slide, issues };
    }
  }

  return {
    slide: slide!,
    metrics: totalMetrics,
    warnings: [`Slide "${brief.title}" needs review after ${MAX_ATTEMPTS} attempts: ${issues.join('; ') || 'unknown issue'}`],
  };
}

export async function generateAllSlides(
  briefs: SlideBrief[],
  graph: TeachingKnowledgeGraph,
  ctx: PipelineContext,
): Promise<StageResult<GeneratedSlide[]>> {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const titleBrief = briefs.find((b) => b.layoutType === 'title');
  const contentBriefs = briefs.filter((b) => b.layoutType !== 'title');

  const slides: GeneratedSlide[] = [];
  if (titleBrief) slides.push(buildTitleSlide(titleBrief, graph));

  const totalMetrics = emptyMetrics();
  const warnings: string[] = [];

  if (contentBriefs.length) {
    const total = contentBriefs.length;
    let completed = 0;
    ctx.progress?.(`Writing slide 1 of ${total}…`, 0, total);

    const { results, failures } = await runBatch(contentBriefs, async (brief) => {
      const result = await generateAndReviewSlide(brief, nodesById, ctx);
      completed++;
      ctx.progress?.(`Writing slide ${Math.min(completed + 1, total)} of ${total}… (${completed} done)`, completed, total);
      return result;
    });

    for (const r of results) {
      if (!r) continue;
      slides.push(r.slide);
      accumulate(totalMetrics, r.metrics);
      warnings.push(...r.warnings);
    }

    // Graceful degradation: a brief whose generation failed entirely still
    // becomes a slide — deterministic, built from its own grounding text.
    for (const f of failures) {
      const brief = contentBriefs[f.index];
      const groundingNodes = brief.knowledgeNodeIds
        .map((id) => nodesById.get(id))
        .filter((n): n is KnowledgeNode => !!n);
      slides.push(buildFallbackSlide(brief, groundingNodes));
      warnings.push(
        `Slide "${brief.title}" was generated in simplified form (AI generation failed: ${f.error.message}) — review and polish it manually.`,
      );
    }
  }

  if (!slides.length) {
    throw new Error('No slides could be generated. Try regenerating.');
  }

  slides.sort((a, b) => a.slideIndex - b.slideIndex);

  return { output: slides, metrics: totalMetrics, warnings };
}
