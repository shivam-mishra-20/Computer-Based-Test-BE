/**
 * PDF rendition of a generated deck — one 16:9 landscape page per slide,
 * rendered from the same preview HTML the app already shows (so PDF and
 * preview are guaranteed to match), via the shared launchBrowser() Chromium
 * path used by the question-paper exporter. Created lazily on first request
 * (see aiContentController.exportPdf) and cached on the AiGeneration doc.
 */
import { launchBrowser } from '../../../utils/launchBrowser';

/** Wraps preview HTML with print CSS: each .slide becomes exactly one
 * fixed-size page (matching pptxgenjs's LAYOUT_WIDE 13.33in × 7.5in), no
 * browser margins, backgrounds on. */
function toPrintableHtml(previewHtml: string): string {
  const printCss = `<style>
    @page { size: 13.33in 7.5in; margin: 0; }
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
    .slide {
      width: 13.33in !important; height: 7.5in !important;
      margin: 0 !important; border-radius: 0 !important; box-shadow: none !important;
      page-break-after: always; break-after: page;
      aspect-ratio: auto !important;
      box-sizing: border-box;
    }
    .slide:last-child { page-break-after: avoid; break-after: avoid; }
  </style>`;
  // Inject after the existing <style> block so the print rules win the cascade.
  return previewHtml.includes('</style>')
    ? previewHtml.replace('</style>', `</style>${printCss}`)
    : printCss + previewHtml;
}

export async function renderSlidesPdf(previewHtml: string): Promise<Buffer> {
  let browser: any;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setContent(toPrintableHtml(previewHtml), { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      width: '13.33in',
      height: '7.5in',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}
