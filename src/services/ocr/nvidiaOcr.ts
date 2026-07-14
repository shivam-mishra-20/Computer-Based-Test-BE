/**
 * Production OCR for scanned pages and images — NVIDIA OCR NIMs with an
 * automatic quality chain, used by the PPT Document Processing stage (and
 * reusable by any future module):
 *
 *   1. PRIMARY  (default nvidia/nemotron-ocr-v2)
 *   2. RETRY    (default nvidia/nemoretriever-ocr-v1) — when the primary's
 *      confidence is below OCR_MIN_CONFIDENCE or its text is implausibly short
 *   3. FALLBACK (default nvidia/nemotron-ocr-v1) — only when both above FAIL
 *
 * The best result wins (longest text at acceptable confidence). All model ids
 * and the endpoint base are env-driven — nothing hardcoded — because NVIDIA
 * NIM catalog names evolve:
 *
 *   NVIDIA_OCR_URL_BASE   (default https://ai.api.nvidia.com/v1/cv)
 *   NVIDIA_OCR_PRIMARY / NVIDIA_OCR_RETRY / NVIDIA_OCR_FALLBACK
 *   OCR_MIN_CONFIDENCE    (default 0.6)
 *   OCR_TIMEOUT_MS        (default 90000)
 *
 * Response normalization (parseOcrResponse) handles every shape we support:
 *   - NVIDIA Nemotron OCR v2 / detection lists:
 *       { data: [ { text_detections: [ { text_prediction: {text,confidence},
 *         bounding_box: { points:[{x,y}...] } } ] } ] }
 *     Detections are confidence-filtered (< OCR_DETECTION_MIN_CONFIDENCE
 *     dropped), sorted into natural reading order (top-to-bottom, then
 *     left-to-right within a row), and reconstructed line by line. bbox +
 *     per-region confidence are preserved on the result.
 *   - Flat text shapes: response.text / .result / .output / .content /
 *     .markdown / data[0].{text,content,markdown} / choices[0].message.content.
 * A RECOGNIZED shape is never treated as a parse failure — so scanned pages use
 * NVIDIA OCR directly and DON'T fall back to the Vision model just because the
 * JSON shape differs from what an older parser expected. OCR never throws:
 * a genuinely unknown body returns null and the pipeline degrades gracefully.
 */

/** One recognized text region with its normalized box and confidence. */
export interface OcrDetection {
  text: string;
  confidence: number; // 0-1
  /** Normalized bounding box [x0, y0, x1, y1] in 0-1 (top-left origin). */
  bbox: [number, number, number, number];
}

export interface OcrResult {
  text: string;
  confidence: number; // 0-1; 0 when the service reports none
  model: string;
  latencyMs: number;
  /** Per-region detections (reading-order sorted), when the NIM provides them. */
  detections?: OcrDetection[];
}

const URL_BASE = () => process.env.NVIDIA_OCR_URL_BASE || 'https://ai.api.nvidia.com/v1/cv';
const MODELS = () => ({
  primary: process.env.NVIDIA_OCR_PRIMARY || 'nvidia/nemotron-ocr-v2',
  retry: process.env.NVIDIA_OCR_RETRY || 'nvidia/nemoretriever-ocr-v1',
  fallback: process.env.NVIDIA_OCR_FALLBACK || 'nvidia/nemotron-ocr-v1',
});
const MIN_CONFIDENCE = () => Number(process.env.OCR_MIN_CONFIDENCE || 0.6);
/** Individual detections below this are dropped as noise before reconstruction. */
const DETECTION_MIN_CONFIDENCE = () => Number(process.env.OCR_DETECTION_MIN_CONFIDENCE || 0.55);
const TIMEOUT_MS = () => Number(process.env.OCR_TIMEOUT_MS || 90000);
const MIN_PLAUSIBLE_CHARS = 20;

/**
 * Models that returned 404/410 (not found / gone / end-of-life) are recorded
 * here and skipped for the rest of the process lifetime — a deprecated NIM is
 * never re-called page after page. Cleared only on restart (a redeploy with a
 * corrected model id starts fresh).
 */
const deadModels = new Set<string>();

/** NVIDIA confidences are 0-1; tolerate a 0-100 percentage form just in case. */
function normConfidence(c: unknown): number {
  const n = Number(c);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

/** Normalized [x0,y0,x1,y1] from a NVIDIA bounding_box.points polygon. */
function bboxFromPoints(points: any): [number, number, number, number] {
  if (!Array.isArray(points) || !points.length) return [0, 0, 1, 1];
  const xs = points.map((p: any) => Number(p?.x)).filter((n) => Number.isFinite(n));
  const ys = points.map((p: any) => Number(p?.y)).filter((n) => Number.isFinite(n));
  if (!xs.length || !ys.length) return [0, 0, 1, 1];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Reconstruct reading order from positioned detections: group into rows by
 * vertical proximity (a row tolerance derived from the median text height),
 * order rows top-to-bottom and each row left-to-right, join within a row by
 * space and rows by newline. Turns a bag of boxes into readable lines.
 */
function detectionsToReadingOrder(dets: OcrDetection[]): string {
  if (!dets.length) return '';
  const heights = dets.map((d) => d.bbox[3] - d.bbox[1]).filter((h) => h > 0).sort((a, b) => a - b);
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 0.02;
  const rowTol = Math.max(medianH * 0.6, 0.008);

  const sorted = [...dets].sort((a, b) => {
    const dy = a.bbox[1] - b.bbox[1];
    if (Math.abs(dy) > rowTol) return dy; // different rows → top-to-bottom
    return a.bbox[0] - b.bbox[0]; // same row → left-to-right
  });

  const lines: string[] = [];
  let rowTop = -Infinity;
  let row: string[] = [];
  for (const d of sorted) {
    if (row.length && d.bbox[1] - rowTop > rowTol) {
      lines.push(row.join(' '));
      row = [];
    }
    if (!row.length) rowTop = d.bbox[1];
    row.push(d.text);
  }
  if (row.length) lines.push(row.join(' '));
  return lines.join('\n');
}

export interface ParsedOcr {
  text: string;
  confidence: number;
  detections: OcrDetection[];
  /** True when the body matched a known shape (even if it held no text — e.g.
   * a blank page). Only an unrecognized body is `false`. */
  recognized: boolean;
}

/** Normalize any supported OCR NIM response into text + detections. */
export function parseOcrResponse(body: any): ParsedOcr | null {
  if (!body || typeof body !== 'object') return null;

  // ── NVIDIA Nemotron OCR v2 / detection-list shape ──────────────────────────
  const rawDetections =
    body?.data?.[0]?.text_detections ?? body?.text_detections ?? body?.predictions?.[0]?.text_detections;
  if (Array.isArray(rawDetections)) {
    const minConf = DETECTION_MIN_CONFIDENCE();
    const dets: OcrDetection[] = [];
    for (const d of rawDetections) {
      const pred = d?.text_prediction ?? d;
      const text = typeof pred?.text === 'string' ? pred.text.trim() : '';
      if (!text) continue;
      const confidence = normConfidence(pred?.confidence);
      if (confidence < minConf) continue; // drop low-confidence noise
      dets.push({ text, confidence, bbox: bboxFromPoints(d?.bounding_box?.points) });
    }
    const text = detectionsToReadingOrder(dets);
    const confidence = dets.length ? dets.reduce((s, d) => s + d.confidence, 0) / dets.length : 0;
    // Recognized shape — even an empty detection list (a blank page) is a
    // valid read, NOT a parse failure. This is what stops the needless
    // vision fallback for a JSON-shape mismatch.
    return { text, confidence, detections: dets, recognized: true };
  }

  // ── Flat text shapes (normalization layer) ─────────────────────────────────
  const candidates = [
    body?.text,
    body?.result,
    body?.output,
    body?.content,
    body?.markdown,
    body?.data?.[0]?.text,
    body?.data?.[0]?.content,
    body?.data?.[0]?.markdown,
    body?.choices?.[0]?.message?.content, // chat-completions-style NIMs
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      const conf = normConfidence(body?.data?.[0]?.confidence ?? body?.confidence);
      return { text: c.trim(), confidence: conf || 0.85, detections: [], recognized: true };
    }
  }
  return null; // genuinely unknown body
}

async function callOcrModel(
  model: string,
  imageBuffer: Buffer,
  mimeType: string,
): Promise<OcrResult | null> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return null;
  // Never re-call a model already proven gone/not-found this run.
  if (deadModels.has(model)) return null;

  const started = Date.now();
  const url = `${URL_BASE()}/${model}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS());
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        input: [{ type: 'image_url', url: `data:${mimeType};base64,${imageBuffer.toString('base64')}` }],
      }),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      // 404 (not found) / 410 (gone / EOL) — the endpoint is deprecated. Mark
      // it dead so subsequent pages skip it straight to the next model.
      if (res.status === 404 || res.status === 410) {
        deadModels.add(model);
        console.warn(`[ocr] ${model} is unavailable (HTTP ${res.status}) — skipping it for the rest of this run.`);
      } else {
        console.warn(`[ocr] ${model} HTTP ${res.status} in ${latencyMs}ms: ${bodyText.slice(0, 160)}`);
      }
      return null;
    }
    const parsed = parseOcrResponse(await res.json().catch(() => null));
    // Only a genuinely unknown body is a parse failure — a recognized shape
    // (even an empty/blank page) is a successful read and is returned as-is,
    // so we never fall back to Vision merely because the JSON shape differs.
    if (!parsed || !parsed.recognized) {
      console.warn(`[ocr] ${model} returned an unrecognized response shape (${latencyMs}ms)`);
      return null;
    }
    console.log(
      `[ocr] ${model} ok in ${latencyMs}ms — ${parsed.text.length} chars, ${parsed.detections.length} regions, confidence ${(parsed.confidence * 100).toFixed(0)}%`,
    );
    return { text: parsed.text, confidence: parsed.confidence, model, latencyMs, detections: parsed.detections };
  } catch (err: any) {
    const cause = err?.cause?.code || err?.cause?.message || '';
    console.warn(`[ocr] ${model} failed in ${Date.now() - started}ms: ${err?.message}${cause ? ` (${cause})` : ''}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Deliberately NOT a type predicate: a non-null result can still be
// unacceptable (low confidence), so narrowing to null on `false` would lie.
function acceptable(r: OcrResult | null): boolean {
  return !!r && r.text.trim().length >= MIN_PLAUSIBLE_CHARS && r.confidence >= MIN_CONFIDENCE();
}

/**
 * OCR one page/image through the quality chain. Returns the best available
 * result, or null when every service failed (caller degrades gracefully).
 */
export async function ocrImage(imageBuffer: Buffer, mimeType: string): Promise<OcrResult | null> {
  const models = MODELS();

  const primary = await callOcrModel(models.primary, imageBuffer, mimeType);
  if (primary && acceptable(primary)) return primary;

  // Low confidence / too little text / hard failure → retry model.
  const retry = await callOcrModel(models.retry, imageBuffer, mimeType);
  if (retry && acceptable(retry)) return retry;

  // Both primary services degraded → last-resort model, only if both FAILED
  // to produce anything usable at all.
  const candidates: OcrResult[] = [primary, retry].filter((r): r is OcrResult => !!r);
  const bestSoFar: OcrResult | null =
    candidates.sort((a, b) => b.text.length - a.text.length)[0] || null;
  if (bestSoFar && bestSoFar.text.trim().length >= MIN_PLAUSIBLE_CHARS) return bestSoFar;

  const fallback = await callOcrModel(models.fallback, imageBuffer, mimeType);
  if (fallback && fallback.text.trim().length >= MIN_PLAUSIBLE_CHARS) return fallback;

  return bestSoFar || fallback || null;
}
