/**
 * ONE SIGN-IN, TWO SYSTEMS — in a real browser, against two real backends.
 *
 * What must hold:
 *
 *   · there is one sign-in screen and no role to choose; the old per-role
 *     addresses land on it;
 *   · an ORGANIZATION account (organization system) enters the organization's
 *     application: an administrator lands in App Management and can reach
 *     nothing of the old platform-style admin panel — every old address is
 *     translated, and no platform tool (Firebase sync, EPUB automation, QuestMl
 *     ingest) is offered; teachers get the organization's branded shell;
 *   · a LEGACY account (legacy system) gets the old screens, and every request
 *     after sign-in goes to the legacy system — never the organization's;
 *   · an organization-system account attached to NO organization is treated as
 *     a legacy account (the legacy system is asked with the same credentials);
 *   · each organization is painted in its own name, logo and colours — never
 *     another institute's;
 *   · signing out removes the session, the organization context, the branding
 *     and cached data, and lands on the public sign-in screen;
 *   · a refused sign-in says one sentence that does not reveal which system
 *     knew the email.
 *
 * Everything runs on SCRATCH databases. Nothing touches `abhigyangurukul`
 * (production) or `abhigyangurukul_console` (the main database): both URIs are
 * derived with a scratch suffix and refused by `assertNotProduction` otherwise.
 *
 * ── Prerequisites ───────────────────────────────────────────────────────────
 *   organization system  P6_MONGO_URI=<…_console_scratch_app>  P6_PORT=5071
 *                        CORS_ORIGIN=http://127.0.0.1:3210  node scripts/safety/p6-fixture-server.js
 *   legacy system        P6_MONGO_URI=<p6_client_platform_web_scratch>  P6_MODE=legacy  P6_PORT=5072
 *                        CORS_ORIGIN=http://127.0.0.1:3210  node scripts/safety/p6-fixture-server.js
 *   web (client-platform-web)
 *                        NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:5071/api
 *                        NEXT_PUBLIC_LEGACY_API_BASE_URL=http://127.0.0.1:5072/api  npx next build
 *                        NEXT_DIST_DIR=.next-e2e  npx next start -p 3210
 *
 *   npm run safety:web-login
 */

import { existsSync, mkdirSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { config } from 'dotenv';
import { assertNotProduction, configureDnsForSrv, requireEnv } from './lib';
import { scratchUriFor } from './e2eHarness';

config({ quiet: true } as never);

const WEB = process.env.WL_WEB || 'http://127.0.0.1:3210';
const PLATFORM_PORT = process.env.WL_PLATFORM_PORT || '5071';
const LEGACY_PORT = process.env.WL_LEGACY_PORT || '5072';
const SHOTS =
  process.env.WL_SHOTS || join(process.cwd(), 'docs', 'single-login-screens');
const RUN = `zz-wsl-${process.pid}`;
// Generated per run — a throwaway account on a scratch database; never stored.
const PASSWORD = `Tst-${randomBytes(9).toString('hex')}!9Aa`;

const ORG = {
  name: 'Lakeside Test Academy',
  tagline: 'Learning by the lake',
  primary: '#E8590C',
  secondary: '#1B3A5C',
  // A self-contained logo, so the test depends on no network.
  logo:
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#E8590C"/><text x="32" y="42" font-size="28" text-anchor="middle" fill="#fff" font-family="Arial">LT</text></svg>',
    ),
};

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
function section(title: string) {
  console.log(`\n${title}`);
}

function chromePath(): string {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('No Chrome or Edge found for puppeteer-core');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const production = requireEnv('MONGO_URI');
  configureDnsForSrv();
  const platformUri = process.env.WL_PLATFORM_URI || scratchUriFor(production);
  const legacyUri =
    process.env.WL_LEGACY_URI ||
    platformUri.replace(/\/[^/?]+(\?|$)/, '/p6_client_platform_web_scratch$1');
  assertNotProduction(platformUri, production);
  assertNotProduction(legacyUri, production);

  /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */
  const mongoose = require('mongoose');
  const bcrypt = require('bcrypt');
  const { MODULES } = require('../../src/core/entitlements/moduleRegistry');
  const puppeteer = require('puppeteer-core');
  /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */

  const platform = await mongoose
    .createConnection(platformUri, {
      serverSelectionTimeoutMS: 20000,
      autoCreate: false,
      autoIndex: false,
    })
    .asPromise();
  const legacy = await mongoose
    .createConnection(legacyUri, {
      serverSelectionTimeoutMS: 20000,
      autoCreate: false,
      autoIndex: false,
    })
    .asPromise();
  console.log(
    `\nSINGLE SIGN-IN  (organization system: ${platform.db.databaseName}, legacy system: ${legacy.db.databaseName})`,
  );

  const email = (tag: string) => `${RUN}-${tag}@example.test`;
  const cleanup = async () => {
    const orgs = await platform.db
      .collection('orgs')
      .find({ slug: { $regex: '^zz-wsl-' } })
      .project({ _id: 1 })
      .toArray();
    const ids = orgs.map((o: { _id: unknown }) => o._id);
    await platform.db
      .collection('entitlements')
      .deleteMany({ orgId: { $in: ids } });
    for (const db of [platform.db, legacy.db]) {
      await db
        .collection('users')
        .deleteMany({ email: { $regex: '^zz-wsl-' } });
    }
    await platform.db
      .collection('auditlogs')
      .deleteMany({ orgId: { $in: ids.map(String) } });
    await platform.db.collection('orgs').deleteMany({ _id: { $in: ids } });
  };

  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    await cleanup();

    /* ══ Fixtures ═════════════════════════════════════════════════════════ */
    section('fixtures (scratch databases only)');
    const hash = await bcrypt.hash(PASSWORD, 10);
    const orgId = new mongoose.Types.ObjectId();
    await platform.db.collection('orgs').insertOne({
      _id: orgId,
      name: ORG.name,
      slug: RUN,
      status: 'active',
      branding: {
        appName: ORG.name,
        tagline: ORG.tagline,
        primaryColor: ORG.primary,
        secondaryColor: ORG.secondary,
        logoUrl: ORG.logo,
      },
      createdAt: new Date(),
    });
    await platform.db.collection('entitlements').insertOne({
      orgId,
      modules: MODULES.map((m: { key: string }) => m.key),
      limits: {},
      status: 'active',
      writable: true,
      version: 1,
      resolvedAt: new Date(),
    });
    const person = (
      tag: string,
      role: string,
      extra: Record<string, unknown> = {},
    ) => ({
      name: `${tag.replace(/-/g, ' ')} ${RUN.slice(-4)}`,
      email: email(tag),
      password: hash,
      role,
      status: 'approved',
      tokenVersion: 0,
      createdAt: new Date(),
      ...extra,
    });
    await platform.db.collection('users').insertMany([
      person('org-admin', 'admin', { orgId: String(orgId) }),
      person('org-teacher', 'teacher', {
        orgId: String(orgId),
        empCode: `${RUN}-T1`,
      }),
      person('learner', 'student', { accountType: 'PUBLIC_LEARNER' }),
      // Known to the organization system, but attached to no organization —
      // as a legacy account copied into it would be.
      person('dual', 'admin'),
    ]);
    await legacy.db
      .collection('users')
      .insertMany([person('legacy-admin', 'admin'), person('dual', 'admin')]);
    check(
      'an organization, its admin and teacher, a learner, and legacy accounts',
      true,
    );

    /* ══ Browser helpers ══════════════════════════════════════════════════ */
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(45000);

    const apiCalls: string[] = [];
    page.on('request', (req: { url: () => string }) => {
      const url = req.url();
      if (
        url.includes(`:${PLATFORM_PORT}/`) ||
        url.includes(`:${LEGACY_PORT}/`)
      )
        apiCalls.push(url);
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (err: Error) => pageErrors.push(err.message));

    const go = async (path: string) => {
      await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle0' });
    };
    const text = async () =>
      (await page.evaluate(() => document.body.innerText)) as string;
    const path = async () =>
      (await page.evaluate(
        () => location.pathname + location.search,
      )) as string;
    const waitForPath = async (
      predicate: (p: string) => boolean,
      timeoutMs = 30000,
    ) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const p = await path().catch(() => '');
        if (predicate(p)) return p;
        await sleep(200);
      }
      return path();
    };
    const shot = async (name: string) => {
      await page.screenshot({
        path: join(SHOTS, `${name}.png`),
        fullPage: false,
      });
    };
    const storage = async () =>
      (await page.evaluate(() => ({
        local: Object.keys(localStorage),
        session: Object.keys(sessionStorage),
        source: localStorage.getItem('accountSource'),
      }))) as { local: string[]; session: string[]; source: string | null };
    const brandState = async () =>
      (await page.evaluate(() => {
        const root = document.documentElement;
        const icon = document.querySelector(
          'link[rel="icon"][data-brand]',
        ) as HTMLLinkElement | null;
        return {
          brand: root.getAttribute('data-brand'),
          primary: getComputedStyle(root)
            .getPropertyValue('--brand-primary')
            .trim()
            .toUpperCase(),
          title: document.title,
          tenantIcon: icon ? icon.getAttribute('href') : null,
        };
      })) as {
        brand: string | null;
        primary: string;
        title: string;
        tenantIcon: string | null;
      };
    const signIn = async (who: string, password = PASSWORD) => {
      await go('/login');
      await page.waitForSelector('#email');
      await page.type('#email', email(who));
      await page.type('#password', password);
      await Promise.all([page.click('button[type="submit"]'), sleep(300)]);
    };
    const signOutViaButton = async () => {
      await page.waitForSelector('[data-testid="sign-out"]');
      await page.click('[data-testid="sign-out"]');
      await waitForPath((p) => p.startsWith('/login'));
      await page.waitForSelector('[data-testid="login-form"]');
      await sleep(400);
    };

    /* ══ 1. The public screens ════════════════════════════════════════════ */
    section('public screens: one way in, no roles, no stale identity');
    await go('/');
    await shot('01-landing');
    let body = await text();
    check('the landing page offers "Sign in"', /Sign in/.test(body));
    check(
      'and no role selection',
      // The old buttons' exact labels — the new copy says, in lower case, that
      // there is no separate "student, teacher or admin login".
      !/Select Your Role|Student Login|Teacher Login|Admin Login/.test(body),
      body.slice(0, 200),
    );
    check(
      'no institute is named when none is known',
      !/Abhigyan|Lakeside/i.test(body),
      body.slice(0, 200),
    );
    let brand = await brandState();
    check(
      "neutral palette, not an institute's",
      brand.brand === 'default' && brand.primary === '#4F46E5',
      JSON.stringify(brand),
    );

    await go('/login/admin');
    check(
      'the old admin sign-in address lands on the single sign-in',
      (await path()).startsWith('/login') &&
        !(await path()).startsWith('/login/'),
    );
    await go('/login/student?org=xyz');
    check(
      '...keeping its query',
      (await path()) === '/login?org=xyz',
      await path(),
    );
    // The hint an address carries is kept for the tab (sessionStorage).
    await page.evaluate(() => sessionStorage.removeItem('orgHint'));

    await go('/login');
    await shot('02-login');
    body = await text();
    check(
      'the sign-in screen asks for credentials only',
      (await page.$('#email')) !== null && (await page.$('#password')) !== null,
    );
    check(
      '...with no role to choose',
      !/Student|Teacher|Admin Login|login type/i.test(
        body.replace(/Administrators, teachers, students and parents/i, ''),
      ),
      body.slice(0, 300),
    );

    await go(`/?org=${RUN}`);
    await page.waitForFunction(
      (n: string) => document.body.innerText.includes(n),
      {},
      ORG.name,
    );
    await shot('03-landing-branded');
    brand = await brandState();
    check(
      'an address that names an organization is painted in its colours',
      brand.primary === ORG.primary,
      JSON.stringify(brand),
    );
    check('...and titled with its name', brand.title === ORG.name, brand.title);
    // The hint an address carries is kept for the tab (sessionStorage).
    await page.evaluate(() => sessionStorage.removeItem('orgHint'));

    /* ══ 2. Refusals ══════════════════════════════════════════════════════ */
    section('a refused sign-in');
    await signIn('org-admin', 'not-the-password');
    await page.waitForSelector('[data-testid="login-error"]');
    const wrongMsg = await page.$eval(
      '[data-testid="login-error"]',
      (el: Element) => el.textContent,
    );
    await signIn('nobody');
    await page.waitForSelector('[data-testid="login-error"]');
    const missingMsg = await page.$eval(
      '[data-testid="login-error"]',
      (el: Element) => el.textContent,
    );
    check(
      'a wrong password reads "Email or password is incorrect."',
      wrongMsg === 'Email or password is incorrect.',
      String(wrongMsg),
    );
    check(
      'an unknown email reads exactly the same',
      missingMsg === wrongMsg,
      `${missingMsg} vs ${wrongMsg}`,
    );
    check(
      'nothing is stored',
      !(await storage()).local.includes('accessToken'),
    );

    /* ══ 3. An organization's administrator ═══════════════════════════════ */
    section('an organization administrator enters App Management — only');
    apiCalls.length = 0;
    await signIn('org-admin');
    const adminLanding = await waitForPath((p) =>
      p.startsWith('/dashboard/admin/app-management'),
    );
    check(
      'lands in App Management',
      adminLanding.startsWith('/dashboard/admin/app-management'),
      adminLanding,
    );
    await page.waitForSelector(
      '[data-testid="app-sidebar"][data-experience="organization"]',
    );
    await page.waitForFunction(
      (n: string) => document.body.innerText.includes(n),
      {},
      ORG.name,
    );
    await sleep(800);
    await shot('04-org-admin-app-management');
    body = await text();
    check(
      "the sidebar is the organization's",
      (await page.$(
        '[data-testid="app-sidebar"][data-experience="organization"]',
      )) !== null,
    );
    check('its name is on screen', body.includes(ORG.name));
    for (const tool of [
      'Firebase Sync',
      'EPUB Automation',
      'QuestMl',
      'Back to Main Admin',
      'Admin Panel',
      'Manage platform entities',
    ]) {
      check(`no "${tool}"`, !body.includes(tool));
    }
    for (const entry of [
      'Exams',
      'Question bank',
      'Create paper',
      'Question papers',
      'Organization',
      'Users',
    ]) {
      check(`"${entry}" is there`, body.includes(entry));
    }
    check('no Abhigyan anywhere', !/Abhigyan/i.test(body));
    brand = await brandState();
    check(
      "painted in the organization's own colour",
      brand.primary === ORG.primary && brand.brand === 'tenant',
      JSON.stringify(brand),
    );
    check('its logo is the tab icon', brand.tenantIcon === ORG.logo);
    check(
      'the tab is titled with its name',
      brand.title === ORG.name,
      brand.title,
    );
    check(
      "the session is the organization system's",
      (await storage()).source === 'console',
    );
    check(
      'every request went to the organization system',
      apiCalls.length > 0 &&
        apiCalls.every((u) => u.includes(`:${PLATFORM_PORT}/`)),
      apiCalls.filter((u) => !u.includes(`:${PLATFORM_PORT}/`)).join(', '),
    );

    const translations: [string, string][] = [
      ['/dashboard/admin', '/dashboard/admin/app-management'],
      ['/dashboard/admin?tab=exams', '/dashboard/admin/app-management/exams'],
      [
        '/dashboard/admin?tab=questions',
        '/dashboard/admin/app-management/question-bank',
      ],
      ['/dashboard/admin?tab=automation', '/dashboard/admin/app-management'],
      ['/dashboard/admin/questml', '/dashboard/admin/app-management'],
      ['/dashboard/admin/automation', '/dashboard/admin/app-management'],
    ];
    for (const [from, to] of translations) {
      await go(from);
      const landed = await waitForPath((p) => p.split('?')[0] === to);
      check(`${from} → ${to}`, landed.split('?')[0] === to, landed);
    }
    await go('/dashboard/admin/app-management/exams');
    await page.waitForFunction(() => document.body.innerText.includes('Exams'));
    await sleep(600);
    await shot('05-org-admin-exams');
    check(
      "the old panel's Exams tool opens inside App Management",
      (await page.$('[data-testid="app-sidebar"]')) !== null,
    );
    await go('/dashboard/admin/app-management/sync');
    await page.waitForSelector('[data-testid="not-available"]');
    check(
      'a legacy-only integration by URL says "not available"',
      (await text()).includes("isn't available for your organization"),
    );

    /* ══ 4. Signing out ═══════════════════════════════════════════════════ */
    section('signing out leaves nothing behind');
    await go('/dashboard/admin/app-management');
    await page.waitForSelector('[data-testid="sign-out"]');
    await page.evaluate(() =>
      localStorage.setItem(
        'createPaperFlow_state',
        '{"formData":{"instituteName":"x"}}',
      ),
    );
    await signOutViaButton();
    await shot('06-signed-out');
    const after = await storage();
    for (const key of [
      'accessToken',
      'refreshToken',
      'user',
      'accountSource',
      'orgHint',
      'createPaperFlow_state',
    ]) {
      check(
        `"${key}" is gone`,
        !after.local.includes(key),
        after.local.join(','),
      );
    }
    check(
      'sessionStorage is empty',
      after.session.length === 0,
      after.session.join(','),
    );
    brand = await brandState();
    check(
      "the organization's colours are gone",
      brand.brand === 'default' && brand.primary === '#4F46E5',
      JSON.stringify(brand),
    );
    check(
      'its icon is gone',
      brand.tenantIcon === null,
      String(brand.tenantIcon),
    );
    body = await text();
    check('its name is gone', !body.includes(ORG.name));
    check('the sign-in screen says so', body.includes('You have signed out.'));

    /* ══ 5. A legacy account ══════════════════════════════════════════════ */
    section(
      'a legacy account gets the legacy screens, served by the legacy system',
    );
    apiCalls.length = 0;
    await signIn('legacy-admin');
    const legacyLanding = await waitForPath((p) =>
      p.startsWith('/dashboard/admin?tab=dashboard'),
    );
    check(
      'lands on the old admin panel',
      legacyLanding.startsWith('/dashboard/admin?tab=dashboard'),
      legacyLanding,
    );
    await page.waitForFunction(() =>
      document.body.innerText.includes('Admin Panel'),
    );
    await sleep(1200);
    await shot('07-legacy-admin');
    body = await text();
    check('the old panel renders', body.includes('Admin Panel'));
    check(
      'with the old top navigation',
      body.includes('Question Papers') && body.includes('Logout'),
    );
    check("under the legacy source's name", body.includes('Abhigyan Gurukull'));
    check(
      "the session is the legacy system's",
      (await storage()).source === 'legacy',
    );
    const afterLogin = apiCalls.slice(
      apiCalls.findIndex((u) => u.includes(`:${LEGACY_PORT}/api/auth/login`)) +
        1,
    );
    check(
      'after signing in, every request went to the legacy system',
      afterLogin.length > 0 &&
        afterLogin.every((u) => u.includes(`:${LEGACY_PORT}/`)),
      afterLogin.filter((u) => !u.includes(`:${LEGACY_PORT}/`)).join(', '),
    );
    check(
      'the legacy system was never asked for an organization context',
      !apiCalls.some((u) => u.includes(`:${LEGACY_PORT}/api/me/context`)),
    );
    await page.click('button ::-p-text(Logout)');
    await waitForPath((p) => p.startsWith('/login'));
    check(
      'its Logout lands on the public sign-in',
      (await path()).startsWith('/login'),
    );
    check(
      '...with the session gone',
      !(await storage()).local.includes('accessToken'),
    );

    /* ══ 6. Known to the organization system, attached to nothing ═════════ */
    section(
      'an organization-system account attached to no organization is a legacy account',
    );
    await signIn('dual');
    const dualLanding = await waitForPath((p) =>
      p.startsWith('/dashboard/admin?tab='),
    );
    check(
      'it lands on the legacy screens',
      dualLanding.startsWith('/dashboard/admin?tab='),
      dualLanding,
    );
    check('as a legacy session', (await storage()).source === 'legacy');
    await page.evaluate(() => localStorage.clear());

    /* ══ 7. An organization's teacher ═════════════════════════════════════ */
    section("an organization's teacher gets its branded shell");
    await signIn('org-teacher');
    const teacherLanding = await waitForPath((p) =>
      p.startsWith('/dashboard/teacher'),
    );
    check(
      'lands on the teacher dashboard',
      teacherLanding.startsWith('/dashboard/teacher'),
      teacherLanding,
    );
    await page.waitForSelector('[data-testid="client-topbar"]');
    await page.waitForFunction(
      (n: string) => document.body.innerText.includes(n),
      {},
      ORG.name,
    );
    await sleep(800);
    await shot('08-org-teacher');
    body = await text();
    check(
      "inside the organization's top bar, under its name",
      body.includes(ORG.name),
    );
    check(
      "with the teacher's destinations",
      body.includes('Create paper') && body.includes('Question Papers'),
    );
    check('and no legacy identity', !/Abhigyan|Tree of Knowledge/i.test(body));
    const hidden = (await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="client-nav"]');
      if (!bar) return ['(no nav)'];
      const edge = bar.getBoundingClientRect().right;
      return [...bar.querySelectorAll('a')]
        .filter((a) => a.getBoundingClientRect().right > edge + 1)
        .map((a) => a.textContent ?? '');
    })) as string[];
    check(
      'every destination fits on a 1366px screen (nothing scrolled out of view)',
      hidden.length === 0,
      hidden.join(', '),
    );
    await signOutViaButton();

    /* ══ 8. A public learner ══════════════════════════════════════════════ */
    section('a public learner is told where its account belongs');
    await signIn('learner');
    const learnerLanding = await waitForPath((p) =>
      p.startsWith('/account-unavailable'),
    );
    check(
      'an explanation, not a broken dashboard',
      learnerLanding.startsWith('/account-unavailable?reason=learner'),
      learnerLanding,
    );
    await page.waitForSelector('[data-testid="account-unavailable"]');
    await shot('09-learner');
    await page.click('[data-testid="account-unavailable"] button');
    await waitForPath((p) => p.startsWith('/login'));
    check(
      '...with a way to sign out',
      !(await storage()).local.includes('accessToken'),
    );

    /* ══ 9. Health ════════════════════════════════════════════════════════ */
    section('no uncaught errors');
    check(
      'no uncaught page errors',
      pageErrors.length === 0,
      pageErrors.slice(0, 3).join(' | '),
    );
  } finally {
    await browser.close().catch(() => undefined);
    await cleanup().catch((e: Error) =>
      console.error('cleanup failed:', e.message),
    );
    await platform.close();
    await legacy.close();
  }

  console.log(
    `\n  ${checks - failures}/${checks} checks passed.   (screens: ${SHOTS})\n`,
  );
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
