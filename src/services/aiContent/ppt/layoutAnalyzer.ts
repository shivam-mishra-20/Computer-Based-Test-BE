/**
 * Stage 4 — Layout Understanding (internal, deterministic-first). Tags each
 * ContentBlock with a structural role via text-pattern heuristics (heading /
 * question / answer / formula-heavy / body). Short fragments that don't match
 * any pattern confidently are genuinely ambiguous — those are batched into a
 * single fast-model call (not one call per block) rather than guessed at,
 * keeping cost bounded while still using AI only where deterministic rules
 * can't resolve it, per the same philosophy used in Retrieval/Flow Planner.
 */
import { ai, estimateCostUSD, pickModel, promptRegistry, safeParse } from '../../../ai';
import { emptyMetrics } from '../../aiOrchestrator/interfaces';
import type { StageResult } from '../../aiOrchestrator/interfaces';
import type { ContentBlock } from './contentCleaner';

export type LayoutRole = 'heading' | 'question' | 'answer' | 'formula' | 'body';

export interface LayoutBlock extends ContentBlock {
  role: LayoutRole;
  order: number;
}

const QUESTION_RE = /^(Q\.?\s?\d+[.):]?|Question\s*\d*\s*[:.]).{0,3}/i;
const ANSWER_RE = /^(Ans(?:wer)?\s*[:.]|Solution\s*[:.]|Sol\s*[:.])/i;
const HEADING_MAX_LEN = 70;
const HEADING_RE = /^[A-Z0-9][A-Za-z0-9 ,'&/-]{2,69}$/; // short, no terminal sentence punctuation
const FORMULA_CHAR_RE = /[=+\-*/^√∫∑π≤≥≠±÷×]|\\frac|\\sqrt|\$[^$]+\$/g;
const AMBIGUOUS_MAX_LEN = 60;

function classifyDeterministic(text: string): { role: LayoutRole; confidence: number } | null {
  if (QUESTION_RE.test(text)) return { role: 'question', confidence: 0.9 };
  if (ANSWER_RE.test(text)) return { role: 'answer', confidence: 0.9 };

  const formulaMatches = text.match(FORMULA_CHAR_RE);
  if (formulaMatches && formulaMatches.length >= 2 && text.length < 200) {
    return { role: 'formula', confidence: 0.7 };
  }

  if (
    text.length <= HEADING_MAX_LEN &&
    !/[.?!]$/.test(text.trim()) &&
    HEADING_RE.test(text.trim())
  ) {
    return { role: 'heading', confidence: 0.65 };
  }

  if (text.length > AMBIGUOUS_MAX_LEN) {
    // A normal paragraph — 'body' is the correct default, not a guess.
    return { role: 'body', confidence: 0.6 };
  }

  return null; // short + no pattern match = genuinely ambiguous
}

promptRegistry.register({
  id: 'ppt.layoutClassifyAmbiguous',
  version: 'v1',
  task: 'fast',
  description: 'Batched structural-role classification for short text fragments deterministic heuristics could not resolve.',
  render: (params: { fragments: string[] }) => [
    {
      role: 'user',
      content: `Classify each numbered text fragment below into exactly one role: "heading", "question", "answer", "formula", or "body". Respond with ONLY a JSON object {"roles": ["role1", "role2", ...]} — one role per fragment, same order, same count.

Fragments:
${params.fragments.map((f, i) => `${i + 1}. ${f}`).join('\n')}`,
    },
  ],
});

async function classifyAmbiguousBatch(
  fragments: string[],
): Promise<{ roles: LayoutRole[]; tokensIn: number; tokensOut: number; costUsd: number }> {
  if (!fragments.length) return { roles: [], tokensIn: 0, tokensOut: 0, costUsd: 0 };

  const prompt = promptRegistry.get<{ fragments: string[] }>('ppt.layoutClassifyAmbiguous');
  const res = await ai.chat(prompt.render({ fragments }), {
    label: `${prompt.id}@${prompt.version}`,
    model: pickModel(prompt.task),
    json: true,
    maxTokens: 1024,
  });
  const parsed = safeParse<{ roles?: string[] }>(res.text);
  const validRoles: LayoutRole[] = ['heading', 'question', 'answer', 'formula', 'body'];
  const roles = fragments.map((_, i) => {
    const r = parsed?.roles?.[i];
    return validRoles.includes(r as LayoutRole) ? (r as LayoutRole) : 'body';
  });
  return {
    roles,
    tokensIn: res.usage.promptTokens,
    tokensOut: res.usage.completionTokens,
    costUsd: estimateCostUSD(res.provider, res.usage),
  };
}

export async function analyzeLayout(blocks: ContentBlock[]): Promise<StageResult<LayoutBlock[]>> {
  const layoutBlocks: (LayoutBlock | null)[] = new Array(blocks.length).fill(null);
  const ambiguousIndices: number[] = [];

  blocks.forEach((block, i) => {
    const result = classifyDeterministic(block.text);
    if (result) {
      layoutBlocks[i] = { ...block, role: result.role, order: i, confidence: Math.min(block.confidence, result.confidence) };
    } else {
      ambiguousIndices.push(i);
    }
  });

  const metrics = emptyMetrics();
  if (ambiguousIndices.length) {
    try {
      const { roles, tokensIn, tokensOut, costUsd } = await classifyAmbiguousBatch(
        ambiguousIndices.map((i) => blocks[i].text),
      );
      ambiguousIndices.forEach((blockIdx, j) => {
        layoutBlocks[blockIdx] = { ...blocks[blockIdx], role: roles[j] || 'body', order: blockIdx, confidence: 0.5 };
      });
      metrics.llmCalls = 1;
      metrics.tokensIn = tokensIn;
      metrics.tokensOut = tokensOut;
      metrics.costUsd = costUsd;
    } catch {
      // Fast-model classification is best-effort — default ambiguous blocks
      // to 'body' rather than fail the whole stage over a labeling nicety.
      ambiguousIndices.forEach((blockIdx) => {
        layoutBlocks[blockIdx] = { ...blocks[blockIdx], role: 'body', order: blockIdx, confidence: 0.3 };
      });
    }
  }

  return {
    output: layoutBlocks.filter((b): b is LayoutBlock => !!b),
    metrics,
    warnings: [],
  };
}
