/**
 * Stage 1 — Document Processing. Converts an uploaded file into a RawDocument
 * the Vision Analysis / Knowledge Extraction stages can consume:
 *
 *   PDF   → every page rasterized to a PNG (pdfjs-dist's Node build, which
 *           bundles its own @napi-rs/canvas — no separate `canvas` native
 *           dependency needed) PLUS its digital text layer, when present.
 *           Every page gets vision-classified downstream (Mode 1's whole
 *           point is catching handwriting/marker/watermark noise, which can
 *           sit on top of an otherwise-digital page).
 *   PPTX  → structured per-slide paragraph text via xml2js (upgrades the old
 *           flat regex-over-XML extraction) + embedded images from
 *           ppt/media/* (adm-zip) as separate raster pages for vision —
 *           v1 scope is text + embedded media only, no full-slide
 *           rasterization (would need an external LibreOffice binary).
 *   DOCX  → structured paragraph text via xml2js + embedded word/media/*.
 *   Image → single passthrough raster page.
 *
 * No file (prompt-only) → empty RawDocument.
 *
 * OCR ROUTING (automatic — the user never picks an OCR engine):
 *   native PDF page (real text layer)  → direct text extraction (free, exact)
 *   scanned PDF page / uploaded image  → NVIDIA OCR chain (services/ocr)
 *   OCR chain fully unavailable        → vision-model verbatim transcription
 *                                        as the absolute last resort
 * A page that still can't be read yields a warning, never a hard failure.
 */
import AdmZip from 'adm-zip';
import { parseStringPromise } from 'xml2js';
import { ai, pickModel, runBatch } from '../../../ai';
import { ocrImage } from '../../ocr/nvidiaOcr';
import { emptyMetrics } from '../../aiOrchestrator/interfaces';
import type {
  DocumentProcessor,
  PipelineContext,
  RawDocument,
  RawPage,
  StageResult,
} from '../../aiOrchestrator/interfaces';
import type { UploadFile } from '../types';

const RASTER_SCALE = 2; // ~144dpi-equivalent — good OCR/vision balance vs memory
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|bmp|webp)$/i;
/** A pdf page with at least this much extracted text is treated as NATIVE
 * (digital text layer) — we use its text directly and never rasterize it.
 * A page below this is treated as scanned → rasterized for OCR/vision. */
const NATIVE_TEXT_MIN_CHARS = 40;
/** Hard ceiling on how many scanned pages we rasterize per document — bounds
 * the CPU/memory cost of a huge scanned upload. Native pages don't count. */
// Must cover BLUEPRINT_LIMITS.maxTotalSlides (160): redesign mirrors an
// N-page deck 1:1, and a page past this cap would have no raster → no OCR
// text → a silently missing slide.
const RASTER_MAX_PAGES = () => Number(process.env.RASTER_MAX_PAGES || 160);
const OCR_MAX_PAGES = () => Number(process.env.OCR_MAX_PAGES || 60);

const VISION_TRANSCRIBE_PROMPT = `Transcribe ALL printed/typed text in this page image EXACTLY as written — verbatim, no paraphrasing, no summarizing, no commentary. Preserve numbers, symbols, and mathematical notation precisely. Reply with the transcribed text only.`;

/** Fill page.text for scanned pages/images via the OCR chain, degrading to a
 * vision-model verbatim transcription only when the whole chain is down. */
async function ocrScannedPages(
  pages: RawPage[],
  progress?: (detail: string, current?: number, total?: number) => void,
): Promise<{ ocrApplied: number; warnings: string[] }> {
  const warnings: string[] = [];
  const targets = pages.filter(
    (p) => p.imageBuffer && (!p.text || p.text.trim().length < NATIVE_TEXT_MIN_CHARS),
  );
  if (!targets.length) return { ocrApplied: 0, warnings };

  const capped = targets.slice(0, OCR_MAX_PAGES());
  if (capped.length < targets.length) {
    warnings.push(
      `Document has ${targets.length} scanned pages; OCR processed the first ${capped.length} (OCR_MAX_PAGES).`,
    );
  }

  // Pages OCR concurrently (bounded) instead of one-at-a-time — a 60-page
  // scan is the difference between minutes and seconds. Order is irrelevant
  // here (each page's text is written back onto its own object); runBatch
  // isolates per-page failures and retries only the failed page.
  let ocrApplied = 0;
  let ocrDone = 0;
  progress?.(`Reading scanned page 1 of ${capped.length}…`, 0, capped.length);
  const ocrConcurrency = Math.max(1, Number(process.env.OCR_CONCURRENCY || 4));
  const { results } = await runBatch(
    capped,
    async (page) => {
      const result = await ocrImage(page.imageBuffer!, page.imageMimeType || 'image/png');
      ocrDone++;
      progress?.(`Reading scanned page ${Math.min(ocrDone + 1, capped.length)} of ${capped.length}… (${ocrDone} done)`, ocrDone, capped.length);
      return { page, text: result?.text };
    },
    { concurrency: ocrConcurrency, retries: 1 },
  );
  for (const r of results) {
    if (r?.text && (!r.page.text || r.page.text.trim().length < NATIVE_TEXT_MIN_CHARS)) {
      r.page.text = r.text;
      ocrApplied++;
    }
  }

  // Absolute last resort: OCR chain unusable → vision-model transcription
  // (classification stays the vision model's real job; this is emergency OCR).
  // "Chain dead" = OCR produced text for none of the pages that needed it.
  const stillBlank = capped.filter((p) => !p.text || p.text.trim().length < NATIVE_TEXT_MIN_CHARS);
  const chainDead = ocrApplied === 0 && stillBlank.length > 0;
  if (chainDead && stillBlank.length) {
    warnings.push(
      `NVIDIA OCR services were unavailable — fell back to vision-model transcription for ${stillBlank.length} page(s).`,
    );
    const { results: visionResults } = await runBatch(stillBlank, async (page) => {
      const res = await ai.vision(
        VISION_TRANSCRIBE_PROMPT,
        [{ data: page.imageBuffer!, mimeType: page.imageMimeType || 'image/png' }],
        { label: 'ppt.ocrFallbackTranscribe', model: pickModel('vision'), maxTokens: 4096 },
      );
      return { page, text: res.text };
    });
    for (const r of visionResults) {
      if (r && r.text.trim()) {
        r.page.text = r.text.trim();
        ocrApplied++;
      }
    }
  }

  const unreadable = capped.filter((p) => !p.text || !p.text.trim()).length;
  if (unreadable) {
    warnings.push(`${unreadable} page(s) could not be read by OCR and were skipped.`);
  }
  return { ocrApplied, warnings };
}

function extOf(name: string): string {
  return (name.toLowerCase().split('.').pop() || '').trim();
}

// ── PDF ──────────────────────────────────────────────────────────────────────

async function processPdf(
  buffer: Buffer,
  progress?: (detail: string, current?: number, total?: number) => void,
): Promise<RawPage[]> {
  // pdfjs-dist's legacy Node build is ESM-only; dynamic import from this CJS
  // module (same pattern already used elsewhere in this codebase for
  // ESM-only deps like @sparticuz/chromium).
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;

  const pages: RawPage[] = [];
  const rasterMax = RASTER_MAX_PAGES();
  let rasterized = 0;
  try {
    // ── Pass 1 (fast): text layer for every page; decide what needs a raster.
    // THE big performance lever: a native page (real text layer) is used by
    // text only — we NEVER rasterize it. Only genuinely scanned pages
    // (sparse/empty text) get a raster for OCR/vision, capped by
    // RASTER_MAX_PAGES.
    const toRaster: number[] = []; // 1-based page numbers
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      try {
        const textContent = await page.getTextContent();
        const text = textContent.items
          .map((item: any) => (typeof item.str === 'string' ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text.length < NATIVE_TEXT_MIN_CHARS && toRaster.length < rasterMax) toRaster.push(i);
        pages.push({ pageIndex: i - 1, text: text || undefined });
      } finally {
        page.cleanup();
      }
    }

    // ── Pass 2 (bounded parallel): rasterize only the scanned pages. Page
    // rendering is async I/O + native canvas work — a small pool beats the
    // old strictly-serial loop on big scanned decks without blowing memory.
    if (toRaster.length) {
      progress?.(`Preparing page 1 of ${toRaster.length}…`, 0, toRaster.length);
      let done = 0;
      const { results } = await runBatch(
        toRaster,
        async (pageNo) => {
          const page = await doc.getPage(pageNo);
          try {
            const viewport = page.getViewport({ scale: RASTER_SCALE });
            const canvasFactory = (doc as any).canvasFactory;
            const canvasAndContext = canvasFactory.create(
              Math.ceil(viewport.width),
              Math.ceil(viewport.height),
            );
            await page.render({ canvasContext: canvasAndContext.context, viewport }).promise;
            const imageBuffer: Buffer = canvasAndContext.canvas.toBuffer('image/png');
            canvasFactory.destroy(canvasAndContext);
            done++;
            progress?.(`Preparing page ${Math.min(done + 1, toRaster.length)} of ${toRaster.length}…`, done, toRaster.length);
            return { pageNo, imageBuffer };
          } finally {
            page.cleanup();
          }
        },
        { concurrency: Math.max(1, Number(process.env.RASTER_CONCURRENCY || 3)), retries: 1 },
      );
      for (const r of results) {
        if (!r) continue;
        const target = pages[r.pageNo - 1];
        target.imageBuffer = r.imageBuffer;
        target.imageMimeType = 'image/png';
        rasterized++;
      }
    }
  } finally {
    await doc.destroy();
  }
  const nativeCount = pages.length - rasterized;
  console.log(
    `[pptPipeline] PDF: ${pages.length} pages — ${nativeCount} native (text-only, no raster), ${rasterized} scanned (rasterized for OCR/vision)`,
  );
  return pages;
}

// ── PPTX / DOCX structured text (xml2js) ────────────────────────────────────

/** xml2js text nodes are either a plain string or `{_: "text", $: {...attrs}}`
 * when the element also has attributes — normalize to a plain string. */
function textNodeValue(node: any): string {
  if (typeof node === 'string') return node;
  if (node && typeof node === 'object' && typeof node._ === 'string') return node._;
  return '';
}

/** Recursively collect text within each `paraTag` element (paragraph), each
 * paragraph's own text runs (`textTag` leaves) joined with spaces — one
 * string per paragraph, in document order. Namespace-prefixed tag names
 * (`a:p`/`a:t`, `w:p`/`w:t`) are matched literally since OOXML always uses
 * them. */
function collectParagraphs(node: any, paraTag: string, textTag: string): string[] {
  const paragraphs: string[] = [];

  function collectText(n: any): string {
    let text = '';
    const walk = (x: any) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) {
        x.forEach(walk);
        return;
      }
      for (const key of Object.keys(x)) {
        if (key === textTag) {
          const vals = Array.isArray(x[key]) ? x[key] : [x[key]];
          for (const v of vals) text += textNodeValue(v) + ' ';
        } else {
          walk(x[key]);
        }
      }
    };
    walk(n);
    return text.trim();
  }

  const walkForParagraphs = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach(walkForParagraphs);
      return;
    }
    for (const key of Object.keys(n)) {
      if (key === paraTag) {
        const paraArr = Array.isArray(n[key]) ? n[key] : [n[key]];
        for (const p of paraArr) {
          const t = collectText(p);
          if (t) paragraphs.push(t);
        }
      } else {
        walkForParagraphs(n[key]);
      }
    }
  };
  walkForParagraphs(node);
  return paragraphs;
}

async function processPptx(buffer: Buffer): Promise<RawPage[]> {
  const zip = new AdmZip(buffer);
  const slideEntries = zip
    .getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));

  const pages: RawPage[] = [];
  for (let i = 0; i < slideEntries.length; i++) {
    const xml = slideEntries[i].getData().toString('utf8');
    const parsed = await parseStringPromise(xml);
    const paragraphs = collectParagraphs(parsed, 'a:p', 'a:t');
    pages.push({ pageIndex: i, text: paragraphs.join('\n') || undefined });
  }

  // Embedded media (photos, logos, watermarks) — each gets its own raster
  // page so Vision Analysis can classify it independently of slide text.
  const mediaEntries = zip
    .getEntries()
    .filter((e) => e.entryName.startsWith('ppt/media/') && IMAGE_EXT_RE.test(e.entryName));
  let mediaIndex = pages.length;
  for (const entry of mediaEntries) {
    const ext = extOf(entry.entryName);
    const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'bmp' ? 'image/bmp' : 'image/jpeg';
    pages.push({
      pageIndex: mediaIndex++,
      imageBuffer: entry.getData(),
      imageMimeType: mime,
    });
  }

  return pages;
}

async function processDocx(buffer: Buffer): Promise<RawPage[]> {
  const zip = new AdmZip(buffer);
  const docEntry = zip.getEntry('word/document.xml');
  const pages: RawPage[] = [];

  if (docEntry) {
    const xml = docEntry.getData().toString('utf8');
    const parsed = await parseStringPromise(xml);
    const paragraphs = collectParagraphs(parsed, 'w:p', 'w:t');
    // DOCX has no natural "page" boundary in the XML — treat the whole
    // document as one logical page for downstream chunking to split later.
    pages.push({ pageIndex: 0, text: paragraphs.join('\n') || undefined });
  }

  const mediaEntries = zip
    .getEntries()
    .filter((e) => e.entryName.startsWith('word/media/') && IMAGE_EXT_RE.test(e.entryName));
  let mediaIndex = pages.length;
  for (const entry of mediaEntries) {
    const ext = extOf(entry.entryName);
    const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'bmp' ? 'image/bmp' : 'image/jpeg';
    pages.push({
      pageIndex: mediaIndex++,
      imageBuffer: entry.getData(),
      imageMimeType: mime,
    });
  }

  return pages;
}

// ── Interface implementation ────────────────────────────────────────────────

export const documentProcessor: DocumentProcessor = {
  async process(
    file: UploadFile | undefined,
    ctx: PipelineContext,
  ): Promise<StageResult<RawDocument>> {
    if (!file) {
      return { output: { pages: [], sourceType: 'prompt' }, metrics: emptyMetrics(), warnings: [] };
    }

    const ext = extOf(file.originalname);
    const mime = (file.mimetype || '').toLowerCase();
    const warnings: string[] = [];

    let pages: RawPage[];
    let sourceType: RawDocument['sourceType'];

    if (mime === 'application/pdf' || ext === 'pdf') {
      sourceType = 'pdf';
      pages = await processPdf(file.buffer, ctx.progress);
    } else if (mime.includes('presentationml') || ext === 'pptx') {
      sourceType = 'pptx';
      pages = await processPptx(file.buffer);
    } else if (mime.includes('wordprocessingml') || ext === 'docx') {
      sourceType = 'docx';
      pages = await processDocx(file.buffer);
    } else {
      sourceType = 'image';
      pages = [{ pageIndex: 0, imageBuffer: file.buffer, imageMimeType: file.mimetype }];
    }

    if (!pages.length) {
      warnings.push(`No pages/content could be extracted from "${file.originalname}".`);
    }

    // Automatic OCR routing: scanned pdf pages & images get real text here —
    // downstream stages never depend on the vision model for reading text.
    const { ocrApplied, warnings: ocrWarnings } = await ocrScannedPages(pages, ctx.progress);
    warnings.push(...ocrWarnings);
    if (ocrApplied > 0) {
      console.log(`[pptPipeline] OCR filled text for ${ocrApplied} scanned page(s)/image(s)`);
    }

    return {
      output: { pages, sourceType },
      metrics: emptyMetrics(),
      warnings,
    };
  },
};
