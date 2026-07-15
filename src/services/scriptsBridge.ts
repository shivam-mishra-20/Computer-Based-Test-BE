/**
 * Bridge to the deterministic question-extraction pipeline in /scripts.
 *
 *   1. PDFParser.parse()        — DETERMINISTIC split: one semantic block per
 *                                 question/example (pdfjs + structure analyzer).
 *   2. createEnhancer(provider) — per-question LLM ENHANCEMENT only (fix
 *                                 formatting, normalize LaTeX, classify type,
 *                                 detect topic, estimate difficulty, strip noise).
 *                                 Runs PARALLEL + BATCHED with caching, fail-soft,
 *                                 and progress callbacks (see scripts/ai-enhancer.js).
 *
 * The scripts are CommonJS and live outside src/, so we load them via a runtime
 * require (resolved against the backend cwd) to keep esbuild from bundling them.
 */
import path from 'path';
import type { ExtractedQuestion } from './enhancedPdfQuestionExtractor';
import { makeBlockCache } from './importCache';

// `eval('require')` forces a true runtime require so esbuild leaves it alone.
// eslint-disable-next-line no-eval
const nodeRequire: NodeRequire = eval('require');

function loadScript(name: string): any {
  return nodeRequire(path.join(process.cwd(), 'scripts', name));
}

export interface EnhancerMetadata {
  title?: string;
  subject?: string;
  board?: string;
  class?: string;
  chapter?: string;
  topic?: string;
}

export interface PipelineOptions {
  /** Reports enhancement progress: (done, total) blocks. */
  onProgress?: (done: number, total: number) => void;
}

export interface PipelineResult {
  questions: ExtractedQuestion[];
  structure: { totalPages: number; subject?: string; className?: string; board?: string; chapters: { name: string }[] };
  stats: { total: number; duplicatesRemoved: number; withDiagrams: number; byType: Record<string, number>; byChapter: Record<string, number> };
}

/**
 * Map an ai-enhancer question onto the ExtractedQuestion shape used by
 * saveQuestions(). Req #1: user-provided metadata wins over AI classification.
 */
function mapEnhanced(q: any, index: number, userMeta: EnhancerMetadata): ExtractedQuestion {
  return {
    text: String(q.text || '').trim(),
    type: q.type || 'short',
    options: Array.isArray(q.options) && q.options.length > 0 ? q.options : undefined,
    correctAnswerText: q.correctAnswerText || undefined,
    questionNumber: String(index + 1),
    subject: userMeta.subject || q.subject || undefined,
    topic: userMeta.topic || q.topic || q._subTopic || undefined,
    chapter: userMeta.chapter || q.chapter || undefined,
    difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
    confidence: q.needsReview ? 0.5 : 0.9,
    needsReview: !!q.needsReview,
    pageNumber: 1,
  };
}

function buildResult(
  rawBlockCount: number,
  enhanced: any[],
  userMeta: EnhancerMetadata,
  mergedMeta: EnhancerMetadata,
  totalPages: number
): PipelineResult {
  const questions = enhanced.map((q, i) => mapEnhanced(q, i, userMeta)).filter(q => q.text);
  const byType: Record<string, number> = {};
  const byChapter: Record<string, number> = {};
  for (const q of questions) {
    byType[q.type] = (byType[q.type] || 0) + 1;
    const ch = q.chapter || mergedMeta.chapter || 'General';
    byChapter[ch] = (byChapter[ch] || 0) + 1;
  }
  return {
    questions,
    structure: {
      totalPages,
      subject: mergedMeta.subject,
      className: mergedMeta.class,
      board: mergedMeta.board,
      chapters: Object.keys(byChapter).map(name => ({ name })),
    },
    stats: {
      total: questions.length,
      duplicatesRemoved: Math.max(0, rawBlockCount - questions.length),
      withDiagrams: 0,
      byType,
      byChapter,
    },
  };
}

function mergeMeta(userMeta: EnhancerMetadata, parsedMeta: any): EnhancerMetadata {
  return {
    title: parsedMeta?.title,
    subject: userMeta.subject || parsedMeta?.subject,
    board: userMeta.board || parsedMeta?.board,
    class: userMeta.class || parsedMeta?.class,
    chapter: userMeta.chapter || parsedMeta?.chapter,
    topic: userMeta.topic || parsedMeta?.chapter,
  };
}

/** PDF → deterministic blocks → parallel/batched per-question enhancement. */
export async function runPdfEnhancerPipeline(
  filePath: string,
  userMeta: EnhancerMetadata,
  provider?: 'nvidia' | 'ollama',
  opts: PipelineOptions = {}
): Promise<PipelineResult> {
  const PDFParser = loadScript('pdf-parser');
  const { createEnhancer } = loadScript('ai-enhancer');

  const parsed = await new PDFParser().parse(filePath);
  const mergedMeta = mergeMeta(userMeta, parsed.metadata);

  const blocks = parsed.questions || [];
  if (blocks.length === 0) return buildResult(0, [], userMeta, mergedMeta, parsed.stats?.total || 1);

  const enhancer = createEnhancer(provider === 'nvidia' ? 'nvidia' : 'ollama');
  const enhanced = await enhancer.enhanceQuestions(blocks, mergedMeta, {
    onProgress: opts.onProgress,
    cache: makeBlockCache(provider || 'ollama'),
    // Smart Import is teacher-reviewed: a low quality score flags the question
    // for review instead of silently dropping it from the teacher's own paper.
    gateMode: 'flag',
  });
  return buildResult(blocks.length, enhanced, userMeta, mergedMeta, parsed.stats?.total || 1);
}

/**
 * Split OCR'd text into ONE block per numbered question so the enhancer can
 * process them in PARALLEL (each block → its own bounded-concurrency call).
 * A "(Given: ...)" line, an options line "(a) ...", or any line NOT starting
 * with a new "N." marker stays attached to the question above it — so no data
 * is separated from its question. Falls back to a single block when it can't
 * find ≥2 numbered questions (short answer / free-form paste).
 */
function splitIntoQuestionBlocks(text: string): string[] {
  const t = String(text || '').replace(/\r\n/g, '\n').replace(/=== PAGE \d+ ===/g, '\n');
  // Split at line starts that begin a NEW numbered question: "1.", "10)", "3 .".
  const parts = t.split(/\n(?=\s*\d{1,2}\s*[.)]\s)/);
  const blocks = parts.map((s) => s.trim()).filter((s) => s.length > 3);
  return blocks.length >= 2 ? blocks : [t.trim()].filter(Boolean);
}

/** Plain text (e.g. OCR'd image) → per-question enhancement. */
export async function runTextEnhancerPipeline(
  text: string,
  userMeta: EnhancerMetadata,
  provider?: 'nvidia' | 'ollama',
  opts: PipelineOptions = {}
): Promise<PipelineResult> {
  const { createEnhancer } = loadScript('ai-enhancer');
  const mergedMeta = mergeMeta(userMeta, {});
  const blocks = splitIntoQuestionBlocks(text).map((bt) => ({
    text: bt,
    topic: mergedMeta.topic || mergedMeta.chapter,
    chapter: mergedMeta.chapter,
    // Fidelity: the OCR text is verbatim, so the enhancer takes the STEM from
    // this source block (not the LLM's re-emission) — see stemFromSource.
    _verbatim: true,
  }));
  const enhancer = createEnhancer(provider === 'nvidia' ? 'nvidia' : 'ollama');
  const enhanced = await enhancer.enhanceQuestions(blocks, mergedMeta, {
    onProgress: opts.onProgress,
    cache: makeBlockCache(provider || 'ollama'),
    // Teacher-reviewed import — flag low scorers, never silently drop them.
    gateMode: 'flag',
  });
  return buildResult(blocks.length, enhanced, userMeta, mergedMeta, 1);
}
