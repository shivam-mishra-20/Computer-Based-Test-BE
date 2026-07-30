/**
 * OCR fallback for scanned PDFs.
 *
 * The digital-PDF path (pdfjs text layer → structure-aware chunking) breaks on
 * SCANNED PDFs: they carry no selectable text, so the parser extracts almost
 * nothing and 0 questions come out. This module fills that gap WITHOUT touching
 * any downstream stage:
 *
 *   For each page:
 *     extract selectable text
 *     IF sufficient  → keep it (digital page — never rendered)
 *     ELSE           → render the page to a PNG (~300 DPI) and run the SAME
 *                      NVIDIA Vision OCR used for image uploads (injected as
 *                      `ocr`, i.e. services/aiService.extractTextFromImage),
 *                      then use the OCR text for that page.
 *
 * Rendering reuses the proven pdfjs-dist LEGACY Node build + its bundled
 * canvasFactory (@napi-rs/canvas) — the exact approach the PPT pipeline uses
 * (services/aiContent/ppt/documentProcessor). No new OCR engine, no native
 * `canvas` dependency, no prompt/enhancement/DB changes.
 *
 * Robust by design: pages are processed one-by-one and their render buffers are
 * released immediately; a per-page OCR failure logs and falls back to whatever
 * the parser produced; a total failure returns what we have. It never throws —
 * a broken OCR path degrades to today's behaviour, never a failed import.
 */
import fs from 'fs';

export interface PdfOcrResult {
  /** Per-page text (OCR-filled where the text layer was insufficient), joined
   *  with the same `=== PAGE n ===` markers the OCR/text pipeline already uses. */
  combinedText: string;
  totalPages: number;
  /** 1-based page numbers whose text came from OCR. */
  ocrPages: number[];
  /** True when at least one page's text was produced by OCR. */
  usedOcr: boolean;
}

export interface PdfOcrOptions {
  /** The image OCR function — pass services/aiService.extractTextFromImage so we
   *  reuse the EXACT engine image uploads use (NVIDIA Vision, Tesseract fallback). */
  ocr: (imageBuffer: Buffer) => Promise<string>;
  /** A page with fewer than this many chars of selectable text is OCR'd. */
  minChars?: number;
  /** Render scale (viewport). Defaults to ~300 DPI (300/72). */
  scale?: number;
  /** Safety cap on how many pages to OCR (bounds cost/memory on huge scans). */
  maxOcrPages?: number;
  /** Optional progress hook: (pageBeingOcrd, totalPages). */
  onOcrPage?: (page: number, total: number) => void;
}

const DEFAULT_MIN_CHARS = () => Number(process.env.PDF_OCR_MIN_CHARS || 100);
const DEFAULT_SCALE = () => Number(process.env.PDF_OCR_RENDER_SCALE || 300 / 72);
const DEFAULT_MAX_PAGES = () => Number(process.env.PDF_OCR_MAX_PAGES || 100);

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Render one pdfjs page to a PNG buffer, always releasing the canvas after. */
async function renderPageToPng(page: any, canvasFactory: any, scale: number): Promise<Buffer> {
  const viewport = page.getViewport({ scale });
  const cc = canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  try {
    await page.render({ canvasContext: cc.context, viewport }).promise;
    return cc.canvas.toBuffer('image/png');
  } finally {
    // Free the (large, ~300 DPI) canvas immediately — one page in flight at a time.
    canvasFactory.destroy(cc);
  }
}

/**
 * Extract every page's text, OCR'ing only the pages the text layer can't cover.
 * Never throws; returns the best combined text it could assemble.
 */
export async function extractPdfTextWithOcrFallback(
  filePath: string,
  opts: PdfOcrOptions,
): Promise<PdfOcrResult> {
  const minChars = opts.minChars ?? DEFAULT_MIN_CHARS();
  const scale = opts.scale ?? DEFAULT_SCALE();
  const maxOcrPages = opts.maxOcrPages ?? DEFAULT_MAX_PAGES();

  const pageTexts: string[] = [];
  const ocrPages: number[] = [];
  let totalPages = 0;

  try {
    const buffer = await fs.promises.readFile(filePath);
    // pdfjs-dist's LEGACY Node build is ESM-only; dynamic import from this module
    // (the same pattern the PPT pipeline uses). It bundles a working canvasFactory.
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
    totalPages = doc.numPages;
    const canvasFactory = doc.canvasFactory;

    try {
      for (let n = 1; n <= totalPages; n++) {
        const page = await doc.getPage(n);
        try {
          // 1. Selectable text.
          let text = '';
          try {
            const tc = await page.getTextContent();
            text = tc.items
              .map((it: any) => (typeof it.str === 'string' ? it.str : ''))
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim();
          } catch (e) {
            console.warn(`[PDF OCR] Page ${n} text extraction failed: ${errMsg(e)}`);
          }
          console.log(`[PDF OCR] Page ${n} -> ${text.length} chars`);

          // 2. Enough text (or OCR cap reached) → keep the digital text, no render.
          const capReached = ocrPages.length >= maxOcrPages;
          if (text.length >= minChars || capReached) {
            if (text.length < minChars && capReached) {
              console.warn(`[PDF OCR] Page ${n} sparse but OCR cap (${maxOcrPages}) reached — keeping parser text`);
            } else {
              console.log(`[PDF OCR] Page ${n} sufficient — skipping OCR`);
            }
            pageTexts.push(text);
            continue;
          }

          // 3. Sparse/image-only page → render + OCR (reuse image OCR engine).
          let ocrText = '';
          try {
            console.log(`[PDF OCR] Rendering page ${n}`);
            const png = await renderPageToPng(page, canvasFactory, scale);
            console.log(`[PDF OCR] Running NVIDIA OCR on page ${n}`);
            opts.onOcrPage?.(n, totalPages);
            ocrText = (await opts.ocr(png)).trim();
            console.log(`[PDF OCR] OCR returned ${ocrText.length} chars for page ${n}`);
          } catch (e) {
            // Never fail the import — log, keep parser text, continue.
            console.error(`[PDF OCR] Page ${n} OCR failed: ${errMsg(e)} — using parser text (${text.length} chars)`);
          }

          // Prefer OCR only when it actually beat the (sparse) text layer.
          if (ocrText.length > text.length) {
            pageTexts.push(ocrText);
            ocrPages.push(n);
          } else {
            pageTexts.push(text);
          }
        } finally {
          page.cleanup();
        }
      }
    } finally {
      await doc.destroy();
    }
  } catch (e) {
    // pdfjs load / whole-document failure — degrade gracefully.
    console.error(`[PDF OCR] Fallback aborted: ${errMsg(e)}`);
  }

  const combinedText = pageTexts.map((t, i) => `\n\n=== PAGE ${i + 1} ===\n${t}`).join('\n');
  if (ocrPages.length) {
    console.log(`[PDF OCR] OCR applied to ${ocrPages.length}/${totalPages} page(s): [${ocrPages.join(', ')}]`);
  }
  return { combinedText, totalPages, ocrPages, usedOcr: ocrPages.length > 0 };
}
