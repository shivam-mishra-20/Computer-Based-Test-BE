/**
 * Single Chromium launch path shared by every HTML→PDF exporter (AI content
 * papers, manual paper export, temp export). Resolution order:
 *   1. @sparticuz/chromium + puppeteer-core  — serverless/Railway (Linux).
 *   2. puppeteer-core against a locally-installed Chrome/Edge — dev machines
 *      (Windows/macOS/Linux). Edge ships with Windows, so this "just works"
 *      locally without the heavy full `puppeteer` package.
 *   3. full `puppeteer` (only if it happens to be installed).
 * Override the binary explicitly with PUPPETEER_EXECUTABLE_PATH / CHROME_PATH.
 */
import fs from 'fs';

function exists(p?: string | null): p is string {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Locate an installed Chrome/Edge/Chromium binary for the current platform. */
function findLocalChrome(): string | undefined {
  const override =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_PATH ||
    process.env.CHROME_EXECUTABLE_PATH;
  if (exists(override)) return override;

  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';
    candidates.push(
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    );
  }
  return candidates.find(exists);
}

/**
 * Launch a headless Chromium and return the browser. Caller is responsible for
 * `browser.close()`. Throws a clear, actionable error if no Chromium is found.
 */
export async function launchBrowser(): Promise<any> {
  // 1) Serverless Chromium (Railway / Lambda).
  try {
    const chromium = await import('@sparticuz/chromium');
    const puppeteerCore = await import('puppeteer-core');
    const executablePath = await chromium.default.executablePath();
    if (executablePath) {
      return await puppeteerCore.default.launch({
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
    /* fall through to a local browser */
  }

  // 2) Locally-installed Chrome/Edge via puppeteer-core (dev machines).
  const localPath = findLocalChrome();
  if (localPath) {
    const puppeteerCore = await import('puppeteer-core');
    return await puppeteerCore.default.launch({
      executablePath: localPath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }

  // 3) Full puppeteer, if installed (bundles its own Chromium).
  try {
    const puppeteer = await import('puppeteer');
    return await puppeteer.default.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  } catch {
    throw new Error(
      'No Chromium available for PDF export. Install Google Chrome or Microsoft Edge, ' +
        'or set PUPPETEER_EXECUTABLE_PATH to a Chromium binary.',
    );
  }
}

/** Render an HTML string to an A4 PDF Buffer using the shared launcher. */
export async function htmlToPdfBuffer(html: string): Promise<Buffer> {
  let browser: any;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
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

export interface PdfRenderOptions {
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  /** Native Chromium running header (rendered in the top margin on every page). */
  headerTemplate?: string;
  /** Native Chromium running footer (rendered in the bottom margin on every page). */
  footerTemplate?: string;
}

/**
 * Like htmlToPdfBuffer but with control over page margins and Chromium's native
 * running header/footer (which render in the margins and never overlap content,
 * repeating on every page). Used by the branded question-paper exporter.
 */
export async function htmlToPdfBufferAdvanced(
  html: string,
  opts: PdfRenderOptions = {},
): Promise<Buffer> {
  let browser: any;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const displayHeaderFooter = !!(opts.headerTemplate || opts.footerTemplate);
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter,
      headerTemplate: opts.headerTemplate ?? '<div></div>',
      footerTemplate: opts.footerTemplate ?? '<div></div>',
      margin: {
        top: opts.margin?.top ?? '12mm',
        right: opts.margin?.right ?? '12mm',
        bottom: opts.margin?.bottom ?? '12mm',
        left: opts.margin?.left ?? '12mm',
      },
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
