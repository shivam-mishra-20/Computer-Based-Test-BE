/**
 * The console's two-factor sign-in, in a real browser.
 *
 * Chrome → platform-console (Next.js) → central-be platform runtime → a
 * LOOPBACK MongoDB. Nothing is injected: the test types the password, reads the
 * setup key off the screen, computes the code an authenticator app would show,
 * and signs in with it — then with a recovery code.
 *
 * Prerequisites (the isolated environment):
 *   1. central-be on API_URL with PLATFORM_MFA_REQUIRED=privileged and a
 *      CONFIG_ENCRYPTION_KEY (a throwaway one)
 *   2. platform-console on CONSOLE_URL, built with NEXT_PUBLIC_API_BASE_URL=$API_URL
 *   3. PLATFORM_MONGODB_URI pointing at the same loopback database (the owner
 *      account is created here; any other host is refused)
 *
 *   API_URL=http://localhost:5060 CONSOLE_URL=http://localhost:3100 \
 *     npx ts-node --transpile-only scripts/safety/console-mfa.e2e.test.ts
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import mongoose from 'mongoose';
import { base32Decode, hotp, totpStep } from '../../src/core/auth/totp';

const CONSOLE_URL = process.env.CONSOLE_URL || 'http://localhost:3100';
const SHOTS =
  process.env.SHOTS_DIR ||
  join(process.cwd(), 'docs', 'console-screens', 'mfa');

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function chromePath(): string {
  for (const candidate of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    process.env.CHROME_PATH || '',
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error('No Chrome or Edge found — set CHROME_PATH');
}

function loopbackOnly(uri: string): void {
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/);
  const hosts = (m?.[1] ?? '').toLowerCase().split(',');
  if (
    !hosts.every((h) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h))
  ) {
    throw new Error(
      `Refusing to run: PLATFORM_MONGODB_URI must be a loopback MongoDB (got ${hosts.join(',')}).`,
    );
  }
}

const codeFor = (secret: string, offset = 0) =>
  hotp(base32Decode(secret.replace(/\s/g, '')), totpStep() + offset);

async function main() {
  const uri = process.env.PLATFORM_MONGODB_URI || '';
  loopbackOnly(uri);
  mkdirSync(SHOTS, { recursive: true });

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const PlatformUser = require('../../src/models/PlatformUser').default;
  const stamp = Date.now();
  const email = `console-mfa-${stamp}@iso.test`;
  const password = `Console-${stamp}-pw`;
  await PlatformUser.create({
    name: 'Console MFA Owner',
    email,
    password,
    role: 'owner',
  });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.setDefaultTimeout(30000);
  const consoleErrors: string[] = [];
  page.on('pageerror', (e: Error) => consoleErrors.push(e.message));

  const sel = (id: string) => `[data-testid="${id}"]`;
  const bodyText = (): Promise<string> =>
    page.evaluate(() => document.body.innerText || '');
  const shot = (name: string) =>
    page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const signedIn = () =>
    page
      .waitForSelector('nav.nav', { timeout: 30000 })
      .then(() => true)
      .catch(() => false);

  async function typeInto(testId: string, text: string) {
    await page.waitForSelector(sel(testId));
    await page.click(sel(testId), { clickCount: 3 });
    await page.type(sel(testId), text);
  }

  async function passwordStep() {
    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => window.sessionStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await typeInto('login-email', email);
    await typeInto('login-password', password);
    await page.click(sel('login-submit'));
  }

  try {
    console.log(`\nConsole two-factor sign-in (${CONSOLE_URL})`);

    // ── Required setup at first sign-in ─────────────────────────────────────
    await passwordStep();
    const enrollShown = await page
      .waitForSelector(sel('mfa-enroll-required'))
      .then(() => true)
      .catch(() => false);
    check(
      'an owner (required by policy) is sent to setup, not into the console',
      enrollShown,
    );
    check(
      '…with no session stored',
      (await page.evaluate(() =>
        window.sessionStorage.getItem('platform.token'),
      )) === null,
    );
    await page.waitForSelector(sel('mfa-secret'));
    const secret = (
      await page.$eval(sel('mfa-secret'), (el: Element) => el.textContent || '')
    ).replace(/\s/g, '');
    check(
      'the setup key is shown (base32, 32 characters)',
      /^[A-Z2-7]{32}$/.test(secret),
      secret,
    );
    await shot('01-setup');
    await typeInto('mfa-enroll-code', '000000');
    await page.click(sel('mfa-enroll-submit'));
    const wrongShown = await page
      .waitForSelector(sel('mfa-error'))
      .then(() => true)
      .catch(() => false);
    check(
      'a wrong code is refused on screen',
      wrongShown || codeFor(secret) === '000000',
    );
    await typeInto('mfa-enroll-code', codeFor(secret));
    await page.click(sel('mfa-enroll-submit'));
    await page.waitForSelector(sel('mfa-recovery-codes'));
    const codes = await page.$$eval(
      `${sel('mfa-recovery-codes')} li`,
      (els: Element[]) => els.map((e) => e.textContent || ''),
    );
    check(
      'ten recovery codes are shown once',
      codes.length === 10 &&
        codes.every((c: string) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c)),
      codes.join(' '),
    );
    check(
      '"Continue" stays disabled until they are marked saved',
      await page.$eval(
        sel('mfa-codes-done'),
        (b: Element) => (b as HTMLButtonElement).disabled,
      ),
    );
    await shot('02-recovery-codes');
    await page.click(sel('mfa-codes-saved'));
    await page.click(sel('mfa-codes-done'));
    check('after setup the console opens', await signedIn());
    await shot('03-signed-in');

    // ── Settings shows it ───────────────────────────────────────────────────
    await page.goto(`${CONSOLE_URL}/settings`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector(sel('mfa-codes-remaining'));
    const settingsText = await bodyText();
    check(
      'Settings: on, required for the role, 10 codes left',
      /Two-factor sign-in/.test(settingsText) &&
        /Required for your role/.test(settingsText) &&
        /10 unused recovery codes left/.test(settingsText),
    );
    check(
      '…and no "Turn off" while the role requires it',
      !/Turn off/.test(settingsText),
    );
    await shot('04-settings');

    // ── Staff list shows it ─────────────────────────────────────────────────
    await page.goto(`${CONSOLE_URL}/staff`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      (e: string) => document.body.innerText.includes(e),
      {},
      email,
    );
    const staffText = await bodyText();
    // innerText applies the table's text-transform: the header reads TWO-FACTOR.
    check('Staff: a Two-factor column', /two-factor/i.test(staffText));
    const myRow = await page.evaluate((e: string) => {
      // From the element that holds the email up to its own row.
      const holder = [...document.querySelectorAll('td *, th *')].find(
        (el) => el.children.length === 0 && el.textContent?.trim() === e,
      );
      const row = holder?.closest('tr');
      return row ? (row as HTMLElement).innerText : '';
    }, email);
    check(
      '…this owner shows On, and a last-seen time (setup counted as signing in)',
      /\bOn\b/.test(myRow) && !/Never/.test(myRow),
      myRow,
    );
    await shot('05-staff');

    // ── Signing in with a code ──────────────────────────────────────────────
    await passwordStep();
    check(
      'next sign-in asks for a code',
      await page
        .waitForSelector(sel('mfa-code-step'))
        .then(() => true)
        .catch(() => false),
    );
    check(
      '…with no session stored yet',
      (await page.evaluate(() =>
        window.sessionStorage.getItem('platform.token'),
      )) === null,
    );
    await shot('06-code-step');
    await typeInto('mfa-code-input', codeFor(secret, 1));
    await page.click(sel('mfa-code-submit'));
    check('a fresh code signs in', await signedIn());

    // ── Signing in with a recovery code ─────────────────────────────────────
    await passwordStep();
    await page.waitForSelector(sel('mfa-code-step'));
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) =>
        x.textContent?.includes('Use a recovery code'),
      );
      (b as HTMLButtonElement | undefined)?.click();
    });
    await typeInto('mfa-recovery-input', codes[0]);
    await page.click(sel('mfa-code-submit'));
    check('a recovery code signs in', await signedIn());

    await passwordStep();
    await page.waitForSelector(sel('mfa-code-step'));
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) =>
        x.textContent?.includes('Use a recovery code'),
      );
      (b as HTMLButtonElement | undefined)?.click();
    });
    await typeInto('mfa-recovery-input', codes[0]);
    await page.click(sel('mfa-code-submit'));
    const reused = await page
      .waitForSelector(sel('login-error'))
      .then(() => true)
      .catch(() => false);
    check(
      'the same recovery code a second time is refused',
      reused && !(await page.$('nav.nav')),
    );
    await shot('07-recovery-reused');

    check(
      'no uncaught page errors',
      consoleErrors.length === 0,
      consoleErrors.join(' | '),
    );
  } finally {
    await browser.close();
    await mongoose.disconnect();
  }

  console.log(`\n  ${checks - failures}/${checks} checks passed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
