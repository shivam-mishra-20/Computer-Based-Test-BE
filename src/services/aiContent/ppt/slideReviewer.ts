/**
 * Stage 11 — Slide Reviewer. Fast, cheap check of a generated slide against
 * the exact grounding nodes it came from — hallucination/compliance only,
 * never a rewrite itself (that's what a retry round back through the
 * SlideGenerator does). Two things get checked: (1) every claim on the slide
 * is traceable to the grounding content, (2) the slide's fields fit its
 * stated layout type (e.g. mcq_card needs 2+ options and a valid
 * answerIndex). Best-effort — a reviewer failure never fails the job (see
 * the retry loop in pipelineDefinition.ts, which keeps the last slide
 * version and flags `needsReview` on exhaustion rather than giving up).
 */
import { ai, estimateCostUSD, pickModel, promptRegistry, safeParse } from '../../../ai';
import type {
  GeneratedSlide,
  KnowledgeNode,
  PipelineContext,
  Reviewer,
  SlideReviewResult,
  StageResult,
} from '../../aiOrchestrator/interfaces';

const SLIDE_TEXT_FIELDS: (keyof GeneratedSlide)[] = [
  'title', 'subtitle', 'bullets', 'definitionCard', 'formulaBox',
  'exampleBox', 'solvedExample', 'mcq', 'table', 'speakerNotes',
];

function groundingSummary(nodes: KnowledgeNode[]): string {
  return nodes
    .map((n) => {
      const bits = [
        n.title,
        ...(n.explanations || []),
        ...(n.definitions?.map((d) => `${d.term}: ${d.definition}`) || []),
        ...(n.examples || []),
        ...(n.mcqs?.map((m) => m.question) || []),
      ];
      return bits.filter(Boolean).join(' | ');
    })
    .join('\n');
}

promptRegistry.register({
  id: 'ppt.slideReview',
  version: 'v2', // v2: layout-only review branch for teacher-authored no-grounding slides
  task: 'fast',
  description: 'Checks a generated slide for hallucinated content (when grounding exists) and layout-budget compliance against its grounding nodes.',
  render: (params: { slide: GeneratedSlide; groundingText: string }) => [
    {
      role: 'user',
      content: [
        `Review this generated slide.`,
        params.groundingText.trim()
          ? `Check TWO things:\n1. Every fact/claim on the slide is supported by the grounding content — flag anything that looks invented or not present in the grounding.\n2. The slide fits its layout type "${params.slide.layoutType}" (e.g. mcq_card needs at least 2 options with a valid 0-based answerIndex; formula_highlight should have a formulaBox; a title should not be empty).`
          : `This slide was intentionally written WITHOUT source grounding (the teacher's approved plan asked for new material), so do NOT flag content as unsupported. Check TWO things instead:\n1. The content is plausible, factually sound, and appropriate for a school lecture.\n2. The slide fits its layout type "${params.slide.layoutType}" (e.g. mcq_card needs at least 2 options with a valid 0-based answerIndex; a title should not be empty).`,
        '',
        `Return ONLY this JSON: { "pass": boolean, "issues": string[] } — "issues" should be empty if pass is true.`,
        '',
        ...(params.groundingText.trim() ? ['Grounding content:', '"""', params.groundingText, '"""', ''] : []),
        'Generated slide:',
        JSON.stringify(
          Object.fromEntries(SLIDE_TEXT_FIELDS.filter((k) => params.slide[k] != null).map((k) => [k, params.slide[k]])),
        ),
      ].join('\n'),
    },
  ],
});

export const reviewer: Reviewer = {
  async review(
    slide: GeneratedSlide,
    groundingNodes: KnowledgeNode[],
    _ctx: PipelineContext,
  ): Promise<StageResult<SlideReviewResult>> {
    const prompt = promptRegistry.get<{ slide: GeneratedSlide; groundingText: string }>('ppt.slideReview');
    const res = await ai.chat(prompt.render({ slide, groundingText: groundingSummary(groundingNodes) }), {
      label: `${prompt.id}@${prompt.version}`,
      model: pickModel(prompt.task),
      json: true,
      maxTokens: 512,
    });
    const parsed = safeParse<{ pass?: boolean; issues?: string[] }>(res.text);
    const result: SlideReviewResult = {
      pass: parsed?.pass !== false, // parse failure or missing field -> don't block on a reviewer hiccup
      issues: Array.isArray(parsed?.issues) ? parsed!.issues!.map(String).filter(Boolean) : [],
    };

    return {
      output: result,
      metrics: {
        llmCalls: 1,
        tokensIn: res.usage.promptTokens,
        tokensOut: res.usage.completionTokens,
        costUsd: estimateCostUSD(res.provider, res.usage),
        retries: 0,
      },
      warnings: [],
    };
  },
};
