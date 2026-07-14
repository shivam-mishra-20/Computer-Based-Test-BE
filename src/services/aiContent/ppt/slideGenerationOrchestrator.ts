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
import { aiConfig, runBatch } from '../../../ai';
import AiGeneration from '../../../models/AiGeneration';
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

  // The per-slide hallucination reviewer adds a SECOND LLM call per slide
  // (doubling the generation-stage call count). It's off by default for speed:
  // slides are grounded in approved blueprint content, so hallucination is
  // rare, and the teacher reviewed the plan already. PPT_REVIEW_SLIDES=on
  // restores the generate→review→retry loop for maximum quality.
  if (!aiConfig.ppt.reviewSlides) {
    const genResult = await slideGenerator.generateSlide(brief, groundingNodes, ctx);
    accumulate(totalMetrics, genResult.metrics);
    return { slide: genResult.output, metrics: totalMetrics, warnings: [] };
  }

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
  let contentBriefs = briefs.filter((b) => b.layoutType !== 'title');

  const slides: GeneratedSlide[] = [];
  if (titleBrief) slides.push(buildTitleSlide(titleBrief, graph));

  const totalMetrics = emptyMetrics();
  const warnings: string[] = [];

  // ── Resume: slides checkpointed by a previous attempt of THIS generation
  // (BullMQ retry, worker restart) are reused instead of regenerated — on a
  // 92-slide deck a crash at slide 80 must not cost 80 slides of rework.
  const doneByIndex = new Map<number, GeneratedSlide>();
  try {
    const prev = await AiGeneration.findById(ctx.generationId).select('partialSlides').lean();
    for (const s of ((prev as any)?.partialSlides as GeneratedSlide[] | undefined) || []) {
      if (s && Number.isFinite(s.slideIndex)) doneByIndex.set(s.slideIndex, s);
    }
  } catch {
    /* no checkpoint — fresh run */
  }
  const resumedSlides = contentBriefs
    .filter((b) => doneByIndex.has(b.slideIndex))
    .map((b) => doneByIndex.get(b.slideIndex)!);
  if (resumedSlides.length) {
    console.log(
      `[pptPipeline][${ctx.generationId}] resuming — ${resumedSlides.length} slide(s) already generated by a previous attempt`,
    );
    slides.push(...resumedSlides);
    contentBriefs = contentBriefs.filter((b) => !doneByIndex.has(b.slideIndex));
  }

  if (contentBriefs.length) {
    const total = contentBriefs.length + resumedSlides.length;
    let completed = resumedSlides.length;
    ctx.progress?.(`Writing slide ${completed + 1} of ${total}…`, completed, total);

    // Throttled checkpoint: persist finished slides so retries/restarts
    // resume, without hammering Mongo once per slide on a big deck.
    const checkpointed: GeneratedSlide[] = [...resumedSlides];
    let lastCheckpointAt = 0;
    const checkpoint = (slide: GeneratedSlide) => {
      checkpointed.push(slide);
      const now = Date.now();
      if (now - lastCheckpointAt < 8000) return;
      lastCheckpointAt = now;
      AiGeneration.updateOne(
        { _id: ctx.generationId },
        { $set: { partialSlides: checkpointed } },
      ).catch(() => {});
    };

    const { results, failures } = await runBatch(
      contentBriefs,
      async (brief) => {
        const result = await generateAndReviewSlide(brief, nodesById, ctx);
        completed++;
        ctx.progress?.(`Writing slide ${Math.min(completed + 1, total)} of ${total}… (${completed} done)`, completed, total);
        checkpoint(result.slide);
        return result;
      },
      // Slides are independent — fan out wider than the general default.
      { concurrency: Math.max(1, aiConfig.ppt.slideConcurrency) },
    );

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

  // Deck complete — the resume checkpoint has served its purpose.
  AiGeneration.updateOne({ _id: ctx.generationId }, { $unset: { partialSlides: 1 } }).catch(() => {});

  return { output: slides, metrics: totalMetrics, warnings };
}
