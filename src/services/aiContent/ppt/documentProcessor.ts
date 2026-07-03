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
 * No file (prompt-only, Mode 2/Smart Generator) → empty RawDocument; this
 * stage and Vision Analysis are both skipped by the pipeline definition.
 */
import AdmZip from 'adm-zip';
import { parseStringPromise } from 'xml2js';
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

function extOf(name: string): string {
  return (name.toLowerCase().split('.').pop() || '').trim();
}

// ── PDF ──────────────────────────────────────────────────────────────────────

async function processPdf(buffer: Buffer): Promise<RawPage[]> {
  // pdfjs-dist's legacy Node build is ESM-only; dynamic import from this CJS
  // module (same pattern already used elsewhere in this codebase for
  // ESM-only deps like @sparticuz/chromium).
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;

  const pages: RawPage[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      try {
        const textContent = await page.getTextContent();
        const text = textContent.items
          .map((item: any) => (typeof item.str === 'string' ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

        const viewport = page.getViewport({ scale: RASTER_SCALE });
        const canvasFactory = (doc as any).canvasFactory;
        const canvasAndContext = canvasFactory.create(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
        // No canvasFactory here — the page already inherits one from the
        // document transport (NodeCanvasFactory, auto-wired by getDocument()
        // in Node). We only use canvasFactory ourselves to create the target
        // canvas up front.
        await page.render({
          canvasContext: canvasAndContext.context,
          viewport,
        }).promise;
        const imageBuffer: Buffer = canvasAndContext.canvas.toBuffer('image/png');
        canvasFactory.destroy(canvasAndContext);

        pages.push({
          pageIndex: i - 1,
          text: text || undefined,
          imageBuffer,
          imageMimeType: 'image/png',
        });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await doc.destroy();
  }
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
    _ctx: PipelineContext,
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
      pages = await processPdf(file.buffer);
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

    return {
      output: { pages, sourceType },
      metrics: emptyMetrics(),
      warnings,
    };
  },
};
