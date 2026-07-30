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
import { extractTextFromImage } from './aiService';
import { extractPdfTextWithOcrFallback } from './pdfOcrFallback';

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
 * Map an ai-enhancer question onto the ExtractedQuestion shape used by the
 * import review buffer. Req #1: user-provided metadata wins over AI classification.
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

  // ── Scanned-PDF OCR fallback ────────────────────────────────────────────────
  // A scanned PDF carries no selectable text: the parser extracts almost nothing
  // and 0 questions come out. Detect that (empty / sparse) and OCR the pages with
  // the SAME engine image uploads use (extractTextFromImage → NVIDIA Vision), then
  // run the recovered text through the existing text pipeline — exactly the image
  // path. Digital PDFs (enough text) skip this entirely and are unchanged.
  const OCR_MIN = Number(process.env.PDF_OCR_MIN_CHARS || 100);
  const numPages = Number(parsed.stats?.numPages) || 0;
  const totalTextChars = Number(
    parsed.stats?.totalTextChars ?? blocks.reduce((s: number, b: any) => s + ((b?.text || '').length), 0),
  );
  const avgCharsPerPage = numPages > 0 ? totalTextChars / numPages : totalTextChars;
  const looksScanned = blocks.length === 0 || (numPages > 0 && avgCharsPerPage < OCR_MIN);

  if (looksScanned) {
    try {
      console.log(
        `[PDF OCR] Sparse PDF detected (avg ${Math.round(avgCharsPerPage)} chars/page over ${numPages} page(s), ${blocks.length} block(s)) — attempting OCR fallback`,
      );
      const fallback = await extractPdfTextWithOcrFallback(filePath, {
        // Reuse the exact image-upload OCR engine (NVIDIA Vision / Tesseract).
        ocr: (buf) => extractTextFromImage(buf, provider === 'nvidia'),
      });
      if (fallback.usedOcr && fallback.combinedText.trim()) {
        console.log(
          `[PDF OCR] Recovered text from ${fallback.ocrPages.length}/${fallback.totalPages} page(s) — routing through the existing text pipeline`,
        );
        return await runTextEnhancerPipeline(fallback.combinedText, userMeta, provider, opts);
      }
      console.warn('[PDF OCR] OCR produced no usable text — continuing with parser output');
    } catch (e) {
      // Never fail the import — degrade to the existing (parser) result.
      console.error(`[PDF OCR] Fallback error: ${e instanceof Error ? e.message : e} — continuing with parser output`);
    }
  }

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
