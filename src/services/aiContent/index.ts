/**
 * Unified AI Content service — the single seam the controller calls. It owns the
 * pipeline (extract → generate JSON → render artifact) and picks the right NVIDIA
 * model per task via the `ai` facade. Future tools (notes, worksheet, lesson
 * planner) add a method here and reuse the same extract/render building blocks.
 */
import { generateSlideDeck } from './pptGenerator';
import { renderPptx, buildDeckPreviewHtml } from './pptxRenderer';
import { generatePaperJSON } from './paperGenerator';
import { renderPaperPdf, buildPaperPreviewHtml } from './paperExport';
import { extractFromUpload } from './documentExtractor';
import type {
  PaperOptions,
  PptOptions,
  RenderedArtifact,
  UploadFile,
} from './types';

export interface GenerationResult {
  feature: 'ppt' | 'question_paper';
  title: string;
  contentJSON: Record<string, any>;
  previewHtml: string;
  artifact: RenderedArtifact;
  usedVision: boolean;
}

function sanitize(s: string): string {
  return String(s || '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function datePart(): string {
  const d = new Date();
  const mon = d.toLocaleString('en', { month: 'short' });
  return `${String(d.getDate()).padStart(2, '0')}${mon}${d.getFullYear()}`;
}

function buildFileName(parts: (string | undefined)[], label: string): string {
  const cleaned = [...parts, label, datePart()]
    .filter(Boolean)
    .map((p) => sanitize(String(p)))
    .filter(Boolean);
  return cleaned.join('_') || `${label}_${datePart()}`;
}

export const aiContentService = {
  /** Read an uploaded document → plain text (Vision model for images/scans). */
  analyzeDocument(file: UploadFile) {
    return extractFromUpload(file);
  },

  /** Prompt/source → structured SlideDeck (no rendering). */
  extractSlides(opts: PptOptions, sourceText?: string) {
    return generateSlideDeck(opts, sourceText);
  },

  async generatePresentation(
    opts: PptOptions,
    file?: UploadFile,
  ): Promise<GenerationResult> {
    let sourceText: string | undefined;
    let usedVision = false;
    if (file) {
      const ex = await extractFromUpload(file);
      sourceText = ex.text;
      usedVision = ex.usedVision;
    }
    const deck = await generateSlideDeck(opts, sourceText);
    const buffer = await renderPptx(deck);
    const fileName = buildFileName(
      [opts.subject, opts.className, opts.chapter],
      'Slides',
    );
    return {
      feature: 'ppt',
      title: deck.title,
      contentJSON: deck as any,
      previewHtml: buildDeckPreviewHtml(deck),
      usedVision,
      artifact: {
        buffer,
        fileName: `${fileName}.pptx`,
        mimeType:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        ext: 'pptx',
      },
    };
  },

  async generateQuestionPaper(
    opts: PaperOptions,
    file?: UploadFile,
  ): Promise<GenerationResult> {
    let sourceText: string | undefined;
    let usedVision = false;
    if (file) {
      const ex = await extractFromUpload(file);
      sourceText = ex.text;
      usedVision = ex.usedVision;
    }
    const paper = await generatePaperJSON(opts, sourceText);
    const buffer = await renderPaperPdf(paper);
    const fileName = buildFileName(
      [opts.subject, opts.className, opts.chapter],
      'QuestionPaper',
    );
    return {
      feature: 'question_paper',
      title: paper.examTitle,
      contentJSON: paper as any,
      previewHtml: buildPaperPreviewHtml(paper),
      usedVision,
      artifact: {
        buffer,
        fileName: `${fileName}.pdf`,
        mimeType: 'application/pdf',
        ext: 'pdf',
      },
    };
  },

  /** Future hook. */
  async generateNotes(): Promise<never> {
    throw new Error('Notes generation is not implemented yet.');
  },
};

// Re-export rendering helpers used by the controller's regenerate path.
export { renderPptx, buildDeckPreviewHtml } from './pptxRenderer';
export { renderPaperPdf, buildPaperPreviewHtml } from './paperExport';
export * from './types';
