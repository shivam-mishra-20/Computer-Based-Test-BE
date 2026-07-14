/**
 * Stage 3 — Content Cleaning (internal, deterministic — not one of the seven
 * swappable interfaces). Merges Document Processing's text-layer pages with
 * Vision Analysis's per-region classifications into a flat list of clean
 * text blocks: vision-classified pages keep only KEEP regions (REMOVE is
 * always dropped, OPTIONAL was already auto-resolved upstream); pages that
 * were never vision-classified (PPTX/DOCX structured text, or a text-heavy
 * PDF page's own digital text layer as a fallback) pass their text through
 * as-is — there was no visual noise to strip from clean digital text.
 *
 * Repeated short headers/footers (the same short string appearing on many
 * pages) are deduped — this is noise reduction, not content-value judgement,
 * so it applies uniformly across modes; a genuine KEEP block is never
 * dropped for budget/relevance reasons here (that's Retrieval's job later).
 */
import type {
  RawDocument,
  SourceProvenance,
  VisionPageClassification,
} from '../../aiOrchestrator/interfaces';

export interface ContentBlock {
  pageIndex: number;
  text: string;
  source: 'vision' | 'text_layer';
  regionType?: string;
  confidence: number;
  provenance: SourceProvenance;
}

export interface CleanedContent {
  blocks: ContentBlock[];
}

const HEADER_FOOTER_MAX_LEN = 80;
const HEADER_FOOTER_MIN_REPEATS = 3;

export function cleanContent(
  doc: RawDocument,
  visionResult: VisionPageClassification[],
): CleanedContent {
  const visionByPage = new Map(visionResult.map((v) => [v.pageIndex, v]));
  const blocks: ContentBlock[] = [];

  for (const page of doc.pages) {
    const vision = visionByPage.get(page.pageIndex);
    if (vision) {
      let pageBlockCount = 0;
      for (const region of vision.regions) {
        if (region.label !== 'KEEP') continue;
        if (!region.verbatimText || !region.verbatimText.trim()) continue;
        blocks.push({
          pageIndex: page.pageIndex,
          text: region.verbatimText.trim(),
          source: 'vision',
          regionType: region.regionType,
          confidence: region.confidence,
          provenance: {
            sourceType: doc.sourceType === 'pdf' ? 'pdf_page' : 'image',
            pageIndex: page.pageIndex,
            bbox: region.bbox,
            visionRegionId: region.regionId,
          },
        });
        pageBlockCount++;
      }
      // Vision classified the page but yielded no usable text (flaky VLM or a
      // page that's all diagrams) — fall back to the page's OCR/text layer so
      // real content is never lost to a classification hiccup.
      if (pageBlockCount === 0 && page.text && page.text.trim()) {
        blocks.push({
          pageIndex: page.pageIndex,
          text: page.text.trim(),
          source: 'text_layer',
          confidence: 0.8,
          provenance: {
            sourceType: doc.sourceType === 'pdf' ? 'pdf_page' : 'image',
            pageIndex: page.pageIndex,
          },
        });
      }
    } else if (page.text && page.text.trim()) {
      blocks.push({
        pageIndex: page.pageIndex,
        text: page.text.trim(),
        source: 'text_layer',
        confidence: 1,
        provenance: {
          sourceType:
            doc.sourceType === 'pptx' ? 'pptx_shape' : doc.sourceType === 'docx' ? 'docx_paragraph' : 'pdf_page',
          pageIndex: page.pageIndex,
        },
      });
    }
  }

  return { blocks: dedupeRepeatedHeadersFooters(blocks) };
}

/**
 * Operates per LINE, not per block: a text-layer block is often a whole
 * page/slide/paragraph dump (one block can contain a header line PLUS the
 * real body text), so whole-block-only dedup would never catch a header
 * embedded inside a longer block. Vision-classified pages are less likely to
 * need this at all — a repeated header there is normally its own KEEP/REMOVE
 * region and REMOVE's `source_page_furniture` reason already strips it; this
 * is the backup for text-layer content and any header vision mislabels KEEP.
 */
function dedupeRepeatedHeadersFooters(blocks: ContentBlock[]): ContentBlock[] {
  const lineCounts = new Map<string, number>();
  for (const b of blocks) {
    for (const line of b.text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length > HEADER_FOOTER_MAX_LEN) continue;
      const key = trimmed.toLowerCase();
      lineCounts.set(key, (lineCounts.get(key) || 0) + 1);
    }
  }

  const seen = new Set<string>();
  return blocks
    .map((b) => {
      const lines = b.text.split('\n').filter((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.length > HEADER_FOOTER_MAX_LEN) return true;
        const key = trimmed.toLowerCase();
        const count = lineCounts.get(key) || 0;
        if (count < HEADER_FOOTER_MIN_REPEATS) return true;
        // Repeated header/footer-like line — keep only its first occurrence.
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { ...b, text: lines.join('\n').trim() };
    })
    .filter((b) => b.text.length > 0);
}
