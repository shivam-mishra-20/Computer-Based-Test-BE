/**
 * Renders a PaperJSON to a print-ready PDF (the downloadable artifact) and to
 * preview HTML, reusing utils/paperExport.buildPaperHtml + the same serverless
 * Chromium → puppeteer-core launch path proven in tempExportController.
 */
import { buildPaperHtml } from '../../utils/paperExport';
import type { PaperJSON } from './types';

export function buildPaperPreviewHtml(paper: PaperJSON): string {
  // Cast: PaperJSON is a structural subset of IPaper for rendering purposes.
  return buildPaperHtml(paper as any, { includeSolutions: false });
}

/** Convert HTML to a PDF Buffer via Chromium (serverless-friendly first). */
export async function htmlToPdf(html: string): Promise<Buffer> {
  let browser: any;
  try {
    try {
      const chromium = await import('@sparticuz/chromium');
      const puppeteerCore = await import('puppeteer-core');
      const executablePath = await chromium.default.executablePath();
      if (executablePath) {
        browser = await puppeteerCore.default.launch({
          args: [
            ...(chromium.default.args || []),
            '--no-sandbox',
            '--disable-setuid-sandbox',
          ],
          executablePath,
          headless: true,
        });
      }
    } catch {
      /* fall through to full puppeteer */
    }

    if (!browser) {
      const puppeteer = await import('puppeteer');
      browser = await puppeteer.default.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    }

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
    });
    await browser.close();
    return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  } catch (err) {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
    throw err;
  }
}

export async function renderPaperPdf(paper: PaperJSON): Promise<Buffer> {
  const html = buildPaperHtml(paper as any, { includeSolutions: true });
  return htmlToPdf(html);
}
