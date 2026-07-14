/**
 * Unified AI Content service — the single seam the controller calls for
 * SYNCHRONOUS features. Question paper generation lives here (extract →
 * generate JSON → render PDF, one HTTP request). PPT generation is async —
 * see services/aiOrchestrator + services/aiContent/ppt/pipelineDefinition.ts,
 * run by src/workers/pptPipelineWorker.ts, not this facade.
 */
import { generatePaperJSON } from './paperGenerator';
import { renderPaperPdf, buildPaperPreviewHtml } from './paperExport';
import { extractFromUpload } from './documentExtractor';
import type { PaperOptions, RenderedArtifact, UploadFile } from './types';

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

/** The expensive half of question-paper generation (document extraction +
 * LLM question generation) with NO PDF rendering — callers checkpoint the
 * returned paper JSON to Mongo BEFORE rendering, so a Chromium/render failure
 * at the last step never throws away minutes of successful AI output. */
export interface PaperContentResult {
  paper: Record<string, any>;
  title: string;
  usedVision: boolean;
  fileName: string; // without extension
}

export async function generatePaperContent(
  opts: PaperOptions,
  file?: UploadFile,
  onProgress?: (detail: string) => void,
): Promise<PaperContentResult> {
  let sourceText: string | undefined;
  let usedVision = false;
  if (file) {
    onProgress?.('Reading your document…');
    const ex = await extractFromUpload(file);
    sourceText = ex.text;
    usedVision = ex.usedVision;
  }
  onProgress?.('Generating questions… this is the longest step');
  const paper = await generatePaperJSON(opts, sourceText);
  return {
    paper: paper as any,
    title: paper.examTitle,
    usedVision,
    fileName: buildFileName([opts.subject, opts.className, opts.chapter], 'QuestionPaper'),
  };
}

export const aiContentService = {
  /** Read an uploaded document → plain text (Vision model for images/scans). */
  analyzeDocument(file: UploadFile) {
    return extractFromUpload(file);
  },

  generatePaperContent,

  async generateQuestionPaper(
    opts: PaperOptions,
    file?: UploadFile,
  ): Promise<GenerationResult> {
    const content = await generatePaperContent(opts, file);
    const paper = content.paper as any;
    const buffer = await renderPaperPdf(paper);
    return {
      feature: 'question_paper',
      title: content.title,
      contentJSON: paper,
      previewHtml: buildPaperPreviewHtml(paper),
      usedVision: content.usedVision,
      artifact: {
        buffer,
        fileName: `${content.fileName}.pdf`,
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
