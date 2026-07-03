/**
 * Stage 0 — Intent Parsing. Resolves the user's request into structured
 * metadata (ResolvedIntent) before anything else runs:
 *
 *   - Form fields ALWAYS win (subject/class/chapter/language/style/numSlides
 *     explicitly chosen in the app are never overridden).
 *   - The fast model fills GAPS from the free-text prompt only when there is a
 *     prompt AND at least one field is missing — a fully-specified form makes
 *     this stage 100% deterministic with zero LLM calls.
 *   - `targetSlideCount` is mandatory downstream (the Slide Budget Allocator
 *     plans exactly this many): options.numSlides clamped to [3, 30],
 *     defaulting to 10 for legacy callers that omit it.
 *   - Parse/LLM failure NEVER fails the stage — deterministic fallback + a
 *     warning, per the "never fail the whole generation" requirement.
 */
import { ai, estimateCostUSD, pickModel, promptRegistry, safeParse } from '../../../ai';
import { emptyMetrics } from '../../aiOrchestrator/interfaces';
import type { PipelineContext, ResolvedIntent, StageResult } from '../../aiOrchestrator/interfaces';

const VALID_INTENTS: ResolvedIntent['intent'][] = ['teach', 'revise', 'assess', 'summarize', 'general'];

export function clampSlideCount(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(Math.max(Math.round(n), 3), 30);
}

promptRegistry.register({
  id: 'ppt.intentParse',
  version: 'v1',
  task: 'fast',
  description: 'Extracts structured metadata (subject/class/chapter/intent/teaching style) from a teacher\'s free-text prompt — fills only the fields the form left blank.',
  render: (params: { prompt: string; missingFields: string[] }) => [
    {
      role: 'system',
      content: 'You extract metadata from a teacher\'s request for a lecture presentation. You respond with a single valid JSON object and nothing else. You only state what the text actually implies — use null for anything not clearly indicated.',
    },
    {
      role: 'user',
      content: [
        `Teacher's request: "${params.prompt}"`,
        '',
        `Extract ONLY these fields (the rest are already known): ${params.missingFields.join(', ')}`,
        '',
        `Respond with EXACTLY this JSON shape (null for anything the text doesn't clearly indicate):`,
        `{`,
        `  "subject": string | null,          // e.g. "Physics"`,
        `  "className": string | null,        // e.g. "Class 10"`,
        `  "chapter": string | null,          // e.g. "Light – Reflection and Refraction"`,
        `  "language": string | null,         // e.g. "English", "Hindi"`,
        `  "teachingStyle": string | null,    // e.g. "Concise", "Detailed", "Exam-focused"`,
        `  "intent": "teach" | "revise" | "assess" | "summarize" | "general"`,
        `}`,
      ].join('\n'),
    },
  ],
});

export async function parseIntent(ctx: PipelineContext): Promise<StageResult<ResolvedIntent>> {
  const o = ctx.options;
  const resolved: ResolvedIntent = {
    subject: o.subject || undefined,
    className: o.className || undefined,
    chapter: o.chapter || undefined,
    language: o.language || undefined,
    teachingStyle: o.style || undefined,
    intent: 'teach',
    targetSlideCount: clampSlideCount(o.numSlides),
    outputMode: ctx.mode,
  };

  const missingFields = (
    [
      ['subject', resolved.subject],
      ['className', resolved.className],
      ['chapter', resolved.chapter],
      ['language', resolved.language],
      ['teachingStyle', resolved.teachingStyle],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k as string);
  missingFields.push('intent'); // always worth classifying when we call at all

  const prompt = (o.prompt || '').trim();
  if (!prompt || missingFields.length <= 1) {
    // Nothing to parse from, or the form already filled everything — fully
    // deterministic, zero LLM cost.
    return { output: resolved, metrics: emptyMetrics(), warnings: [] };
  }

  try {
    const template = promptRegistry.get<{ prompt: string; missingFields: string[] }>('ppt.intentParse');
    const res = await ai.chat(template.render({ prompt, missingFields }), {
      label: `${template.id}@${template.version}`,
      model: pickModel(template.task),
      json: true,
      maxTokens: 512,
    });
    const parsed = safeParse<any>(res.text) || {};

    // Fill gaps only — form fields untouched.
    if (!resolved.subject && typeof parsed.subject === 'string' && parsed.subject) resolved.subject = parsed.subject;
    if (!resolved.className && typeof parsed.className === 'string' && parsed.className) resolved.className = parsed.className;
    if (!resolved.chapter && typeof parsed.chapter === 'string' && parsed.chapter) resolved.chapter = parsed.chapter;
    if (!resolved.language && typeof parsed.language === 'string' && parsed.language) resolved.language = parsed.language;
    if (!resolved.teachingStyle && typeof parsed.teachingStyle === 'string' && parsed.teachingStyle) resolved.teachingStyle = parsed.teachingStyle;
    if (VALID_INTENTS.includes(parsed.intent)) resolved.intent = parsed.intent;

    return {
      output: resolved,
      metrics: {
        llmCalls: 1,
        tokensIn: res.usage.promptTokens,
        tokensOut: res.usage.completionTokens,
        costUsd: estimateCostUSD(res.provider, res.usage),
        retries: 0,
      },
      warnings: [],
    };
  } catch (err: any) {
    // Never fail the pipeline over metadata enrichment — proceed with what
    // the form gave us.
    return {
      output: resolved,
      metrics: emptyMetrics(),
      warnings: [`Intent parsing fell back to form fields only: ${err?.message || 'unknown error'}`],
    };
  }
}
