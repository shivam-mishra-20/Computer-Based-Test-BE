/**
 * The console's real sign-in, in a real browser.
 *
 * ── Why this is separate from console-ui.e2e ────────────────────────────────
 * That suite INJECTS a token before the first byte of app JS, because it is
 * testing the twelve screens behind the door rather than the door itself. This
 * one never injects a valid token: it types an email and a password into the
 * form and checks what comes back, which is the only way to catch the failure
 * that matters most here — a login route mounted below its own auth guard, so
 * that signing in requires already being signed in.
 *
 * No mocks and no fixtures: Chrome talks to Next.js, which talks to
 * platform-core, which talks to a SCRATCH database.
 *
 * Prerequisites:
 *   1. platform-core on API_URL — `npm run p6:serve` gives exactly that
 *   2. an owner and a support account (bootstrap + POST /api/platform/staff)
 *   3. platform-console on CONSOLE_URL, NEXT_PUBLIC_API_BASE_URL=$API_URL
 *
 *   API_URL=http://127.0.0.1:5055 CONSOLE_URL=http://127.0.0.1:3100 \
 *     npx ts-node --transpile-only scripts/safety/console-login.e2e.test.ts
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const CONSOLE_URL = process.env.CONSOLE_URL || 'http://127.0.0.1:3100';
const API_URL = process.env.API_URL || 'http://127.0.0.1:5055';
const SHOTS = join(process.cwd(), 'docs', 'console-screens');
const TOKEN_KEY = 'platform.token';

const OWNER = {
  email: (process.env.P10A_OWNER_EMAIL || 'p10a-owner@platform.test').toLowerCase(),
  password: process.env.P10A_OWNER_PASSWORD || 'bootstrap-owner-password',
};
const SUPPORT = {
  email: (process.env.P10A_SUPPORT_EMAIL || 'p10a-support@platform.test').toLowerCase(),
  password: process.env.P10A_SUPPORT_PASSWORD || 'support-account-password',
};

let failures = 0;
let checks = 0;
const failedLabels: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    failedLabels.push(label);
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function eq<T>(label: string, actual: T, expected: T) {
  check(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
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

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);

  const sel = (id: string) => `[data-testid="${id}"]`;
  const bodyText = (): Promise<string> => page.evaluate(() => document.body.innerText || '');
  const storedToken = (): Promise<string | null> =>
    page.evaluate((k: string) => window.sessionStorage.getItem(k), TOKEN_KEY);

  /**
   * Storage is manipulated by navigating first and then reloading, NOT by
   * `evaluateOnNewDocument`. Those hooks are permanent and cumulative: one
   * registered to clear storage keeps firing on every later navigation, and a
   * signed-in session silently evaporates on the next page load.
   */
  async function clearSession() {
    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      try {
        window.sessionStorage.clear();
        window.localStorage.clear();
      } catch {
        /* storage can be unavailable; nothing to clear if so */
      }
    });
  }

  async function seedTokenAndReload(token: string) {
    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(
      (k: string, t: string) => window.sessionStorage.setItem(k, t),
      TOKEN_KEY,
      token,
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
  }

  async function signIn(email: string, password: string) {
    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(sel('login-submit'));
    await page.click(sel('login-email'), { clickCount: 3 });
    await page.type(sel('login-email'), email);
    await page.click(sel('login-password'), { clickCount: 3 });
    await page.type(sel('login-password'), password);
    await page.click(sel('login-submit'));
  }

  /**
   * Wait for the SIGNED-IN shell, not merely for the login form to disappear.
   *
   * Shell renders three states, and the middle one — `Loading…` while
   * `/platform/me` is in flight — has no login form AND no navigation. Waiting
   * on the form's absence returns during that gap, and the next line then
   * queries a DOM that has not been built yet. Waiting for a nav link is the
   * state we actually mean.
   */
  const waitForConsole = () =>
    page.waitForFunction(() => document.querySelectorAll('nav a').length > 0, { timeout: 30000 });

  const navLabels = (): Promise<string[]> =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('nav a')).map((a) => (a.textContent || '').trim()),
    );

  try {
    // ══════════════════════════════════════════════════════════════════════
    console.log('\nan unauthenticated visitor');
    // ══════════════════════════════════════════════════════════════════════
    await clearSession();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector(sel('login-submit'));
    check('sees the sign-in form', true);
    check('with an email field, not a token-paste field', (await page.$(sel('login-email'))) !== null);
    check('and a password field', (await page.$(sel('login-password'))) !== null);
    check('and no navigation rendered behind it', (await page.$('nav')) === null);
    await page.screenshot({ path: join(SHOTS, '18-login-form.png') });

    // ══════════════════════════════════════════════════════════════════════
    console.log('\ncredentials that should not work');
    // ══════════════════════════════════════════════════════════════════════
    await signIn(OWNER.email, 'definitely-not-the-password');
    await page.waitForSelector(sel('login-error'), { timeout: 20000 }).catch(() => undefined);
    check('a wrong password shows an error', (await page.$(sel('login-error'))) !== null);
    eq('and stores no token', await storedToken(), null);
    check('and stays on the form', (await page.$(sel('login-submit'))) !== null);
    const wrongPasswordMessage = await page
      .$eval(sel('login-error'), (el: Element) => el.textContent || '')
      .catch(() => '');

    await signIn('nobody-at-all@platform.test', OWNER.password);
    await page.waitForSelector(sel('login-error'), { timeout: 20000 }).catch(() => undefined);
    check('an unknown account also shows an error', (await page.$(sel('login-error'))) !== null);
    const unknownUserMessage = await page
      .$eval(sel('login-error'), (el: Element) => el.textContent || '')
      .catch(() => '');
    check(
      'and the two are indistinguishable — the form does not confirm which addresses exist',
      wrongPasswordMessage.trim() === unknownUserMessage.trim() && wrongPasswordMessage.length > 0,
      `wrong-password: ${JSON.stringify(wrongPasswordMessage)} / unknown: ${JSON.stringify(unknownUserMessage)}`,
    );
    await page.screenshot({ path: join(SHOTS, '19-login-rejected.png') });

    // ══════════════════════════════════════════════════════════════════════
    console.log('\nowner sign-in');
    // ══════════════════════════════════════════════════════════════════════
    await signIn(OWNER.email, OWNER.password);
    await waitForConsole();
    check('the form is replaced by the console', true);

    const token = await storedToken();
    check('a token is stored', typeof token === 'string' && token.length > 40, String(token).slice(0, 20));
    eq(
      'in sessionStorage only — a platform token must not outlive the tab',
      await page.evaluate((k: string) => window.localStorage.getItem(k), TOKEN_KEY),
      null,
    );

    const payload = JSON.parse(
      Buffer.from(String(token).split('.')[1], 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    eq('the token carries the platform audience', payload.aud, 'platform');
    eq('and no orgId — platform staff belong to no organization', payload.orgId, undefined);

    const dashboard = await bodyText();
    check(
      'the dashboard renders data fetched with that token',
      /organization/i.test(dashboard),
      dashboard.slice(0, 200).replace(/\n/g, ' | '),
    );

    const ownerNav = await navLabels();
    for (const item of ['Dashboard', 'Organizations', 'Onboard', 'Plans', 'Platform Staff', 'Audit']) {
      check(`owner navigation includes ${item}`, ownerNav.includes(item), ownerNav.join(' | '));
    }
    await page.screenshot({ path: join(SHOTS, '20-owner-signed-in.png') });

    // A reload must not require signing in again — the session survives
    // navigation, which is the whole reason the token is stored at all.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForConsole();
    check('the session survives a reload', (await page.$(sel('login-submit'))) === null);

    // ══════════════════════════════════════════════════════════════════════
    console.log('\nsign out');
    // ══════════════════════════════════════════════════════════════════════
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('button')).find((b) =>
        /sign out/i.test(b.textContent || ''),
      );
      (button as HTMLButtonElement | undefined)?.click();
    });
    await page.waitForSelector(sel('login-submit'), { timeout: 20000 });
    check('returns to the sign-in form', true);
    eq('and clears the stored token', await storedToken(), null);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector(sel('login-submit'), { timeout: 20000 });
    check('and a reload does not restore the session', true);
    await page.screenshot({ path: join(SHOTS, '21-signed-out.png') });

    // ══════════════════════════════════════════════════════════════════════
    console.log('\ntokens that must not open the console');
    // ══════════════════════════════════════════════════════════════════════
    await seedTokenAndReload('not-a-real-token.but-long-enough.to-look-like-one');
    await page.waitForSelector(sel('login-submit'), { timeout: 20000 });
    check('a malformed token lands on sign-in rather than a broken console', true);
    eq('and is discarded, not left to fail on every request', await storedToken(), null);

    // A TENANT token — the exact case the separate audience exists for. This is
    // a real login against the real tenant route, not a hand-rolled JWT.
    const tenantLogin = (await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.P10A_TENANT_EMAIL || 'p6.admin@abhigyan.fixture',
        password: process.env.P10A_TENANT_PASSWORD || 'P6-fixture-abhigyan!',
      }),
    })
      .then((r) => r.json())
      .catch(() => ({}))) as { token?: string };

    if (tenantLogin.token) {
      await seedTokenAndReload(tenantLogin.token);
      await page.waitForSelector(sel('login-submit'), { timeout: 20000 });
      check('a TENANT token cannot open the console', true);
      eq('and is discarded', await storedToken(), null);

      // The UI refusing it is a convenience. This is the control.
      const atTheDoor = await fetch(`${API_URL}/api/platform/orgs`, {
        headers: { Authorization: `Bearer ${tenantLogin.token}` },
      });
      const atTheDoorBody = (await atTheDoor.json().catch(() => ({}))) as { code?: string };
      eq('and the SERVER refuses it too', atTheDoor.status, 403);
      eq('with an audience mismatch, before any role check', atTheDoorBody.code, 'TOKEN_AUDIENCE_MISMATCH');
      await page.screenshot({ path: join(SHOTS, '22-tenant-token-rejected.png') });
    } else {
      console.log('  ! tenant fixture not reachable — tenant-token rejection SKIPPED');
      check('tenant-token rejection could be exercised', false, `no token from ${API_URL}/api/auth/login`);
    }

    // ══════════════════════════════════════════════════════════════════════
    console.log('\ncapability filtering — support is not owner');
    // ══════════════════════════════════════════════════════════════════════
    await clearSession();
    await signIn(SUPPORT.email, SUPPORT.password);
    await waitForConsole();
    check('support signs in with the same form', true);

    const supportNav = await navLabels();
    check(
      'support sees Organizations — it holds org.read',
      supportNav.includes('Organizations'),
      supportNav.join(' | '),
    );
    check(
      'support does NOT see Platform Staff — it lacks staff.manage',
      !supportNav.includes('Platform Staff'),
      supportNav.join(' | '),
    );
    check(
      'support does NOT see Onboard — it lacks org.manage',
      !supportNav.includes('Onboard'),
      supportNav.join(' | '),
    );
    await page.screenshot({ path: join(SHOTS, '23-support-nav.png') });

    // Hiding the link is not a control; typing the URL is the test.
    await page.goto(`${CONSOLE_URL}/staff`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => /cannot manage staff/i.test(document.body.innerText || ''),
      { timeout: 20000 },
    ).catch(() => undefined);
    const staffText = await bodyText();
    check(
      'and reaching /staff directly says the role cannot manage staff',
      /cannot manage staff/i.test(staffText),
      staffText.slice(0, 200).replace(/\n/g, ' | '),
    );
    check(
      'without leaking any staff account',
      !/@/.test(staffText.replace(/cannot manage staff/i, '')),
      staffText.slice(0, 200).replace(/\n/g, ' | '),
    );

    const supportToken = await storedToken();
    const serverSays = await fetch(`${API_URL}/api/platform/staff`, {
      headers: { Authorization: `Bearer ${supportToken}` },
    });
    const serverBody = (await serverSays.json().catch(() => ({}))) as { code?: string };
    eq('and the SERVER refuses the same call, not just the UI', serverSays.status, 403);
    eq('with a capability denial', serverBody.code, 'PLATFORM_CAPABILITY_DENIED');
    await page.screenshot({ path: join(SHOTS, '24-support-staff-denied.png') });
  } finally {
    await browser.close();
  }

  console.log('');
  if (failures) {
    console.error(`CONSOLE LOGIN E2E FAILED — ${failures} of ${checks}:`);
    for (const label of failedLabels) console.error(`  - ${label}`);
    process.exit(1);
  }
  console.log(`All ${checks} console login checks passed. Screenshots in ${SHOTS}`);
  process.exit(0);
}

main().catch((error) => {
  console.error('console-login.e2e.test.ts crashed:', (error as Error).message);
  process.exit(1);
});
