/**
 * Drive the REAL platform-console UI in a real browser, against the REAL
 * platform-core API.
 *
 * ── Why this exists on top of the API e2e ───────────────────────────────────
 * `platform-onboarding.e2e.test.ts` proves the API contract. It cannot prove
 * the console renders, that a click reaches the right endpoint, that the token
 * survives navigation, or that a capability-filtered nav actually hides what it
 * should. Those are exactly the failures a user hits first, and none of them
 * are visible from curl.
 *
 * No mocks and no fixtures: Chrome talks to Next.js on 3100, which talks to
 * platform-core on 5055, which talks to a scratch database.
 *
 * Prerequisites (the harness checks and fails clearly if missing):
 *   platform-core    http://127.0.0.1:5055   `npm run p6:serve`
 *   platform-console http://127.0.0.1:3100
 *   pc-tokens.env with OWNER_TOKEN and SUPPORT_TOKEN — mint-platform-tokens.ts
 *
 *   npx ts-node --transpile-only scripts/safety/console-ui.e2e.test.ts
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const CONSOLE_URL = process.env.CONSOLE_URL || 'http://127.0.0.1:3100';
const API_URL = process.env.API_URL || 'http://127.0.0.1:5055';
const SHOTS = join(process.cwd(), 'docs', 'console-screens');

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function loadTokens(): { owner: string; support: string } {
  // Git Bash maps /tmp to %LOCALAPPDATA%/Temp while Node resolves it to a
  // non-existent C:/tmp, so a literal '/tmp/...' written by the shell is
  // invisible here. os.tmpdir() is the same directory both sides agree on.
  const path = process.env.TOKENS_FILE || join(tmpdir(), 'pc-tokens.env');
  if (!existsSync(path)) {
    throw new Error(
      `${path} not found — mint tokens first, or set TOKENS_FILE to their location`,
    );
  }
  const text = readFileSync(path, 'utf8');
  const owner = text.match(/OWNER_TOKEN=(\S+)/)?.[1];
  const support = text.match(/SUPPORT_TOKEN=(\S+)/)?.[1];
  if (!owner || !support) throw new Error('OWNER_TOKEN / SUPPORT_TOKEN missing');
  return { owner, support };
}

function chromePath(): string {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('No Chrome or Edge found for puppeteer-core');
}

async function main() {
  const { owner, support } = loadTokens();
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
  // networkidle2 waits for the connection count to drop and stay down; a Next.js
  // server holding one open means that never happens, so every navigation timed
  // out at the first page. Explicit selector waits are both faster and a truer
  // statement of what the test is actually waiting for.
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);

  // Surface console errors from the app itself — a page that renders but throws
  // is not a working page.
  // Two different things, deliberately kept apart.
  //
  //   pageErrors  genuine uncaught JavaScript exceptions — always a bug.
  //   httpNoise   the browser logging a non-2xx response. Some of those are the
  //               POINT of this test: the support-session section asserts a 403,
  //               and counting that as a failure would mean the suite fails
  //               precisely when authorization works.
  const pageErrors: string[] = [];
  const httpNoise: string[] = [];
  page.on('pageerror', (e: Error) => pageErrors.push(e.message));
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/Failed to load resource/i.test(text)) httpNoise.push(text);
    else pageErrors.push(text);
  });

  /**
   * Seed the token BEFORE any page script runs, on every document.
   *
   * The obvious approach — navigate, setItem, reload — loses the token to a
   * race between Puppeteer's same-URL navigation and the app's own bootstrap,
   * and presents as "the nav never appeared" rather than as an auth problem.
   * Instrumenting Storage.removeItem proved the app never clears it, so this is
   * a harness ordering issue and not a session bug.
   *
   * evaluateOnNewDocument runs before the first byte of app JS, on every
   * navigation, which removes the ordering question entirely.
   */
  let seeded: string | null = null;
  const signIn = async (token: string) => {
    seeded = token;
    await page.evaluateOnNewDocument((t: string) => {
      window.sessionStorage.setItem('platform.token', t);
    }, token);
    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.nav', { timeout: 25000 });
  };

  /** Drop the seeded token, for the unauthenticated case. */
  const signOutHard = async () => {
    seeded = null;
    await page.evaluateOnNewDocument(() => window.sessionStorage.removeItem('platform.token'));
    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
  };
  void seeded;

  const go = async (path: string, waitFor: string) => {
    await page.goto(`${CONSOLE_URL}${path}`, { waitUntil: 'domcontentloaded' });
    // Report the page's own words rather than a bare selector timeout — a
    // sign-in form here means the session was lost, which is a different bug
    // from a panel that failed to load.
    try {
      await page.waitForSelector(waitFor, { timeout: 25000 });
    } catch {
      const body = await page.evaluate(() => document.body.innerText);
      throw new Error(
        `${path}: selector "${waitFor}" never appeared. Page said: ${body.slice(0, 300)}`,
      );
    }
  };

  const text = () => page.evaluate(() => document.body.innerText);

  /**
   * Case-insensitive contains.
   *
   * Chrome's innerText returns RENDERED text, and `.pill` carries
   * `text-transform: uppercase` — so subjects come back as "PHYSICS" and role
   * types as "CUSTOM". Asserting on the source casing failed against a UI that
   * was displaying exactly the right thing.
   */
  const has = (haystack: string, needle: string) =>
    haystack.toLowerCase().includes(needle.toLowerCase());
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });

  try {
    console.log('Console UI — real browser, real API\n');

    // ── Unauthenticated ───────────────────────────────────────────────────
    console.log('session gate');
    await signOutHard();
    await page.waitForSelector('form', { timeout: 20000 });
    // The gate now asks for a credential rather than for a pasted token — see
    // console-login.e2e.test.ts, which exercises that form for real. Here it is
    // only the "no session" branch that matters, so assert on the fields that
    // identify the screen rather than on prose.
    check(
      'no token shows the sign-in screen',
      (await page.$('[data-testid="login-email"]')) !== null &&
        (await page.$('[data-testid="login-password"]')) !== null,
      (await text()).slice(0, 200),
    );
    await shot('01-signin');

    // ── Owner session ─────────────────────────────────────────────────────
    console.log('\ndashboard');
    await signIn(owner);
    await go('/', 'table');
    const dash = await text();
    check('dashboard renders', dash.includes('Dashboard'));
    check('  shows a real organization count', /Organizations/.test(dash));
    check('  shows the 34-module catalogue count', dash.includes('34'), dash.slice(0, 300));
    check('  nav shows owner sections', dash.includes('Platform Staff') && dash.includes('Audit'));
    await shot('02-dashboard');

    console.log('\norganizations');
    await go('/organizations', 'table');
    check('organization list renders', (await text()).includes('Abhigyan'), (await text()).slice(0, 300));
    await shot('03-organizations');

    // ── ONBOARD ABC THROUGH THE UI ────────────────────────────────────────
    console.log('\nonboarding ABC Coaching through the UI');
    await go('/onboard', 'textarea');
    // Give it a distinct slug so the run is repeatable alongside other fixtures.
    await page.evaluate(() => {
      const ta = document.querySelector('textarea') as HTMLTextAreaElement;
      const parsed = JSON.parse(ta.value);
      parsed.organization.slug = 'abc-coaching-ui';
      parsed.admin.email = 'ui-admin@abc-coaching.test';
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value',
      )!.set!;
      setter.call(ta, JSON.stringify(parsed, null, 2));
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Onboard organization'),
      ) as HTMLButtonElement;
      btn.click();
    });

    await page.waitForFunction(
      () => /Organization ready|Partially completed/.test(document.body.innerText),
      { timeout: 60000 },
    );
    const onboardText = await text();
    check(
      'onboarding through the UI reports READY',
      onboardText.includes('Organization ready'),
      onboardText.slice(0, 400),
    );
    check('  every step shows ok', !onboardText.includes('failed'), 'a step reported failure');
    await shot('04-onboard-result');

    // ── Organization detail, every tab ────────────────────────────────────
    console.log('\norganization detail tabs');
    const orgId = await page.evaluate(() => {
      const link = [...document.querySelectorAll('a')].find((a) =>
        a.getAttribute('href')?.startsWith('/organizations/'),
      );
      return link?.getAttribute('href')?.split('/').pop() ?? null;
    });
    check('detail link was produced', Boolean(orgId));
    if (!orgId) throw new Error('no orgId link — cannot continue');

    await go(`/organizations/${orgId}`, '.tabs');
    let t = await text();
    check('overview renders ABC Coaching', t.includes('ABC Coaching Institute'));
    check('  branding colour is shown', t.includes('#E8590C'), t.slice(0, 500));
    check('  lifecycle controls present', t.includes('Set suspended'));
    await shot('05-org-overview');

    const clickTab = async (name: string) => {
      await page.evaluate((n: string) => {
        const b = [...document.querySelectorAll('.tabs button')].find(
          (x) => x.textContent?.trim() === n,
        ) as HTMLButtonElement;
        b.click();
      }, name);
      await new Promise((r) => setTimeout(r, 1200));
    };

    await clickTab('Configuration');
    t = await text();
    check('configuration tab shows Dropper', t.includes('Dropper'));
    check('  shows Hall A and Lab 1', t.includes('Hall A') && t.includes('Lab 1'));
    check('  shows the 4 ABC subjects', has(t, 'Physics') && has(t, 'Biology'), t.slice(0, 600));
    check('  shows the +4 / -1 marking policy', t.includes('"correct": 4'), t.slice(-600));
    await shot('06-org-configuration');

    await clickTab('Entitlement');
    t = await text();
    check('entitlement tab renders module checkboxes', t.includes('Enabled modules'));
    check('  Question Bank is listed', t.includes('Question Bank'));
    await shot('07-org-entitlement');

    await clickTab('Roles');
    t = await text();
    check('roles tab shows Centre Manager', t.includes('Centre Manager'));
    check('  and Counsellor', t.includes('Counsellor'));
    check('  custom vs system is distinguished', has(t, 'custom') && has(t, 'system'), t.slice(0, 400));
    await shot('08-org-roles');

    await clickTab('Users');
    t = await text();
    check('users tab shows the onboarded admin', t.includes('ui-admin@abc-coaching.test'), t.slice(0, 400));
    await shot('09-org-users');

    await clickTab('Audit');
    t = await text();
    check('audit tab shows org.onboard', t.includes('org.onboard'), t.slice(0, 400));
    await shot('10-org-audit');

    // ── Suspend through the UI ────────────────────────────────────────────
    console.log('\nlifecycle through the UI');
    await clickTab('Overview');
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => x.textContent?.trim() === 'Set suspended',
      ) as HTMLButtonElement;
      b.click();
    });
    await page.waitForFunction(() => /Currently suspended/.test(document.body.innerText), { timeout: 25000 });
    check('suspending through the UI takes effect', (await text()).includes('Currently suspended'));
    await shot('11-org-suspended');

    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => x.textContent?.trim() === 'Set active',
      ) as HTMLButtonElement;
      b.click();
    });
    await page.waitForFunction(() => /Currently active/.test(document.body.innerText), { timeout: 25000 });
    check('reactivating through the UI takes effect', (await text()).includes('Currently active'));

    // ── Modules ───────────────────────────────────────────────────────────
    console.log('\nmodules');
    await go('/modules', 'table');
    t = await text();
    check('module catalogue renders', has(t, 'Question Bank') && has(t, 'assessment'));
    check('  core tier is labelled always-on', has(t, 'always on'));
    await shot('12-modules');

    // ── Plans CRUD ────────────────────────────────────────────────────────
    console.log('\nplans CRUD');
    // Waiting on a bare `button` matched the nav's Sign-out immediately, so the
    // click ran before the plans panel had rendered. Wait for the actual control.
    await page.goto(`${CONSOLE_URL}/plans`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'New plan'),
      { timeout: 25000 },
    );
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => x.textContent?.trim() === 'New plan',
      ) as HTMLButtonElement;
      b.click();
    });
    await page.waitForSelector('#k', { timeout: 15000 });
    await page.type('#k', 'p5-professional');
    await page.type('#nm', 'Professional (P5 test)');
    await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('input[type=checkbox]')] as HTMLInputElement[];
      // Tick a couple of non-core modules.
      boxes.filter((b) => !b.disabled).slice(0, 3).forEach((b) => b.click());
    });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => x.textContent?.trim() === 'Save plan',
      ) as HTMLButtonElement;
      b.click();
    });
    await page.waitForFunction(() => /Saved "/.test(document.body.innerText), { timeout: 25000 });
    // The "Saved" banner renders before reload() has refreshed the table, so
    // asserting immediately raced the refetch.
    await page.waitForFunction(
      () => document.body.innerText.includes('p5-professional'),
      { timeout: 25000 },
    );
    t = await text();
    check('a plan can be CREATED through the UI', has(t, 'Professional (P5 test)'), t.slice(0, 400));
    check('  it appears in the table', t.includes('p5-professional'));
    await shot('13-plans-created');

    await page.waitForFunction(
      () => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Withdraw'),
      { timeout: 25000 },
    );
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => x.textContent?.trim() === 'Withdraw',
      ) as HTMLButtonElement;
      b.click();
    });
    await page.waitForFunction(() => /withdrawn from sale/.test(document.body.innerText), { timeout: 25000 });
    check('a plan can be WITHDRAWN through the UI', has(await text(), 'withdrawn'));

    // ── Staff ─────────────────────────────────────────────────────────────
    console.log('\nplatform staff');
    await go('/staff', 'table');
    t = await text();
    // Asserted by SHAPE, not by a fixture's email address. Pinning
    // `p5-console-owner@platform.local` made this suite pass against exactly one
    // database and fail everywhere else with "staff list renders" — a message
    // that says nothing about the actual cause. What the check means is "the
    // table rendered real staff rows", so that is what it now asserts.
    const staffRows = await page.$$eval('table tbody tr', (rows: Element[]) =>
      rows.map((r) => (r.textContent || '').trim()).filter(Boolean),
    );
    check(
      'staff list renders real rows',
      staffRows.length > 0 && staffRows.some((r: string) => r.includes('@')),
      `${staffRows.length} row(s): ${staffRows.slice(0, 2).join(' / ')}`,
    );
    check(
      'and the signed-in owner account is among them',
      staffRows.some((r: string) => /owner/i.test(r)),
      staffRows.join(' / ').slice(0, 200),
    );
    check('  roles are shown', has(t, 'owner') && has(t, 'support'));
    await shot('14-staff');

    // ── Audit ─────────────────────────────────────────────────────────────
    console.log('\naudit');
    await go('/audit', 'table');
    t = await text();
    check('audit renders platform actions', t.includes('org.onboard') || t.includes('plan.upsert'), t.slice(0, 400));
    await shot('15-audit');

    // ── Capability filtering with a SUPPORT token ─────────────────────────
    console.log('\ncapability filtering (support session)');
    await signIn(support);
    await page.goto(`${CONSOLE_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.nav', { timeout: 20000 });
    const nav = await page.evaluate(() =>
      [...document.querySelectorAll('.nav a')].map((a) => a.textContent?.trim()),
    );
    check('support sees Organizations', nav.includes('Organizations'));
    check('support does NOT see Platform Staff', !nav.includes('Platform Staff'), nav.join(','));
    check('support does NOT see Onboard', !nav.includes('Onboard'), nav.join(','));
    await shot('16-support-nav');

    // Navigation hiding is convenience; the server is the control. Prove it.
    await page.goto(`${CONSOLE_URL}/staff`, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 1500));
    check(
      'support hitting /staff directly is refused',
      (await text()).includes('cannot manage staff'),
      (await text()).slice(0, 300),
    );
    await shot('17-support-staff-denied');

    // ── No unhandled page errors ──────────────────────────────────────────
    console.log('\nruntime health');
    const realErrors = pageErrors.filter(
      (e) => !/favicon|Download the React DevTools/i.test(e),
    );
    check(
      'no uncaught JavaScript exceptions across the whole run',
      realErrors.length === 0,
      realErrors.slice(0, 5).join(' | '),
    );
    // Reported, not asserted: a 403 here is the authorization test succeeding.
    console.log(`  – ${httpNoise.length} non-2xx resource log(s), incl. the deliberate 403`);
  } finally {
    await browser.close();
  }

  console.log('');
  if (failures) {
    console.error(`CONSOLE UI E2E FAILED — ${failures} of ${checks}.`);
    process.exit(1);
  }
  console.log(`All ${checks} console UI checks passed.`);
  console.log(`Screenshots: ${SHOTS}`);
  process.exit(0);
}

main().catch((error) => {
  console.error('[console-ui] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
