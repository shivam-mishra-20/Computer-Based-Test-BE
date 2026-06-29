/**
 * Renders a PaperJSON to a print-ready PDF (the downloadable artifact) and to
 * preview HTML, reusing utils/paperExport.buildPaperHtml + the same serverless
 * Chromium → puppeteer-core launch path proven in tempExportController.
 */
import { buildPaperHtml } from '../../utils/paperExport';
import { htmlToPdfBuffer } from '../../utils/launchBrowser';
import type { PaperJSON } from './types';

export function buildPaperPreviewHtml(paper: PaperJSON): string {
  // Cast: PaperJSON is a structural subset of IPaper for rendering purposes.
  return buildPaperHtml(paper as any, { includeSolutions: false });
}

/** Convert HTML to a PDF Buffer via the shared Chromium launcher. */
export async function htmlToPdf(html: string): Promise<Buffer> {
  return htmlToPdfBuffer(html);
}

export async function renderPaperPdf(paper: PaperJSON): Promise<Buffer> {
  const html = buildPaperHtml(paper as any, { includeSolutions: true });
  return htmlToPdf(html);
}
