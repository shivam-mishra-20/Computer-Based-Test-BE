/**
 * Single Chromium launch path shared by every HTML→PDF exporter (AI content
 * papers, manual paper export, temp export). Resolution order:
 *   1. puppeteer-core against an installed Chrome/Edge/Chromium — dev machines
 *      (Edge ships with Windows) AND servers whose image installs chromium
 *      (see nixpacks.toml). System binaries have all their shared libs
 *      resolved by the OS package manager, so they're the most reliable tier.
 *   2. @sparticuz/chromium + puppeteer-core — serverless-style fallback when
 *      no system browser exists in the container.
 *   3. full `puppeteer` (only if it happens to be installed).
 * Override the binary explicitly with PUPPETEER_EXECUTABLE_PATH / CHROME_PATH.
 * Every failed tier is logged with its real cause — a missing-Chromium error
 * in production must never be a mystery again.
 */
import fs from 'fs';
import path from 'path';

function exists(p?: string | null): p is string {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

const LINUX_BROWSER_NAMES = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'microsoft-edge',
];

/** Scan PATH for a browser binary — finds Nix-profile/Homebrew/apt installs
 * regardless of where the distro puts them. */
function findOnPath(): string | undefined {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const names =
    process.platform === 'win32'
      ? ['chrome.exe', 'msedge.exe']
      : LINUX_BROWSER_NAMES;
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (exists(p)) return p;
    }
  }
  return undefined;
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
      ...LINUX_BROWSER_NAMES.map((n) => `/usr/bin/${n}`),
      // Nixpacks (Railway) installs nix packages under a profile, not /usr/bin.
      ...LINUX_BROWSER_NAMES.map((n) => `/root/.nix-profile/bin/${n}`),
      ...LINUX_BROWSER_NAMES.map((n) => `/nix/var/nix/profiles/default/bin/${n}`),
    );
  }
  return candidates.find(exists) || findOnPath();
}

/**
 * Launch a headless Chromium and return the browser. Caller is responsible for
 * `browser.close()`. Throws a clear, actionable error if no Chromium is found.
 */
export async function launchBrowser(): Promise<any> {
  const failures: string[] = [];

  // 1) Installed Chrome/Edge/Chromium via puppeteer-core (dev machines AND
  //    servers whose image ships a browser — see nixpacks.toml).
  const localPath = findLocalChrome();
  if (localPath) {
    try {
      const puppeteerCore = await import('puppeteer-core');
      return await puppeteerCore.default.launch({
        executablePath: localPath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
    } catch (err: any) {
      failures.push(`system browser (${localPath}): ${err?.message || err}`);
      console.error(`[launchBrowser] system browser at ${localPath} failed to launch:`, err?.message || err);
    }
  } else {
    failures.push('system browser: none found (checked env overrides, standard install paths, PATH)');
  }

  // 2) Serverless Chromium (@sparticuz/chromium extracts a bundled binary).
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
    failures.push('@sparticuz/chromium: executablePath() returned empty');
    console.error('[launchBrowser] @sparticuz/chromium executablePath() returned empty');
  } catch (err: any) {
    failures.push(`@sparticuz/chromium: ${err?.message || err}`);
    console.error('[launchBrowser] @sparticuz/chromium tier failed:', err?.message || err);
  }

  // 3) Full puppeteer, if installed (bundles its own Chromium).
  try {
    const puppeteer = await import('puppeteer');
    return await puppeteer.default.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  } catch (err: any) {
    failures.push(`puppeteer: ${err?.message || err}`);
    console.error(
      '[launchBrowser] No Chromium available. Tier failures:\n  - ' + failures.join('\n  - '),
    );
    throw new Error(
      'No Chromium available for PDF export. Install Google Chrome or Microsoft Edge, ' +
        'or set PUPPETEER_EXECUTABLE_PATH to a Chromium binary. ' +
        `(${failures.join(' | ')})`,
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
