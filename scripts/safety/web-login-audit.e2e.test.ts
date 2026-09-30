/**
 * THE SIGN-IN AUDIT — both systems, every role, in a real browser.
 *
 * `web-single-login.e2e.test.ts` proves the single sign-in exists. This suite
 * audits everything around it, end to end:
 *
 *   · the sign-in form itself: the button is disabled only while a field is
 *     empty (including a field the browser autofilled without telling React),
 *     shows its progress while the account is resolved, recovers after a
 *     failure, toggles the password, submits on Enter, and fits a phone, a
 *     tablet and a desktop;
 *   · every LEGACY role (admin, teacher, student, parent) reaches its own
 *     screens, under the legacy identity, with every request going to the
 *     legacy system; the admin's panel tabs and legacy App Management pages
 *     all still render;
 *   · every ORGANIZATION role reaches its own screens under its organization's
 *     name, logo and colours; the administrator sees App Management and
 *     nothing else;
 *   · switching accounts in one browser, in every direction (legacy ⇄
 *     organization, organization A → organization B), leaves nothing of the
 *     previous account on screen;
 *   · a refresh keeps the session and its identity;
 *   · signed out, no dashboard address shows anything but the sign-in —
 *     not even for a frame;
 *   · a role or a system cannot reach another's screens by typing an address;
 *   · the organization of a signed-in session cannot be chosen by the
 *     browser: not by `X-Org-Id`, not by editing localStorage, not by `?org=`;
 *   · an expired session lands on a neutral sign-in, not the last institute's.
 *
 * `WL_PHASE=single-legacy` runs the checks for the other real configuration:
 * ONE backend at the organization address, serving the legacy database (a
 * developer switching `MONGO_URI`). Start the organization port in that mode
 * first — see the runner.
 *
 * Everything runs on SCRATCH databases, refused by `assertNotProduction`
 * otherwise. Nothing touches `abhigyangurukul` or `abhigyangurukul_console`.
 *
 *   node scripts/safety/web-login-audit.runner.js          (starts everything)
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
const PHASE = (process.env.WL_PHASE || 'two-backends').trim();
const SHOTS =
  process.env.WL_SHOTS || join(process.cwd(), 'docs', 'login-audit-screens');
const RUN = `zz-wla-${process.pid}`;
// Generated per run — a throwaway account on a scratch database; never stored.
const PASSWORD = `Tst-${randomBytes(9).toString('hex')}!9Aa`;

/** The neutral palette (lib/brand.ts NEUTRAL_BRAND) and the legacy one (tenant/branding.ts DEFAULT_BRAND). */
const NEUTRAL_PRIMARY = '#4F46E5';
const LEGACY_PRIMARY = '#A3B18A';
const LEGACY_NAME = 'Abhigyan Gurukull';

const ORG_A = {
  name: 'Lakeside Audit Academy',
  tagline: 'Learning by the lake',
  primary: '#E8590C',
  secondary: '#1B3A5C',
  logo:
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#E8590C"/><text x="32" y="42" font-size="28" text-anchor="middle" fill="#fff" font-family="Arial">LA</text></svg>',
    ),
};
const ORG_B = {
  name: 'Riverside Audit School',
  tagline: 'By the river',
  primary: '#0F766E',
  secondary: '#7C3AED',
};

/** Things only an administrator's navigation, or a signed-in screen, ever shows. */
const ADMIN_MARKERS = [
  'App Mgmt',
  'Firebase Sync',
  'Back to Main Admin',
  'Admin Panel',
  'Manage platform entities',
  'Control Center',
];

let checks = 0;
let failures = 0;
const failed: string[] = [];
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    failed.push(label);
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

  const options = {
    serverSelectionTimeoutMS: 20000,
    autoCreate: false,
    autoIndex: false,
  };
  const platform = await mongoose
    .createConnection(platformUri, options)
    .asPromise();
  const legacy = await mongoose
    .createConnection(legacyUri, options)
    .asPromise();
  console.log(
    `\nSIGN-IN AUDIT — ${PHASE}  (organization system: ${platform.db.databaseName}, legacy system: ${legacy.db.databaseName})`,
  );

  const email = (tag: string) => `${RUN}-${tag}@example.test`;
  const cleanup = async () => {
    const orgs = await platform.db
      .collection('orgs')
      .find({ slug: { $regex: '^zz-wla-' } })
      .project({ _id: 1 })
      .toArray();
    const ids = orgs.map((o: { _id: unknown }) => o._id);
    await platform.db
      .collection('entitlements')
      .deleteMany({ orgId: { $in: ids } });
    await platform.db
      .collection('auditlogs')
      .deleteMany({ orgId: { $in: ids.map(String) } });
    await platform.db.collection('orgs').deleteMany({ _id: { $in: ids } });
    for (const db of [platform.db, legacy.db]) {
      await db
        .collection('users')
        .deleteMany({ email: { $regex: '^zz-wla-' } });
    }
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
    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();
    const slugA = `${RUN}-a`;
    const slugB = `${RUN}-b`;
    await platform.db.collection('orgs').insertMany([
      {
        _id: orgA,
        name: ORG_A.name,
        slug: slugA,
        status: 'active',
        branding: {
          appName: ORG_A.name,
          tagline: ORG_A.tagline,
          primaryColor: ORG_A.primary,
          secondaryColor: ORG_A.secondary,
          logoUrl: ORG_A.logo,
        },
        createdAt: new Date(),
      },
      {
        _id: orgB,
        name: ORG_B.name,
        slug: slugB,
        status: 'active',
        branding: {
          appName: ORG_B.name,
          tagline: ORG_B.tagline,
          primaryColor: ORG_B.primary,
          secondaryColor: ORG_B.secondary,
        },
        createdAt: new Date(),
      },
    ]);
    await platform.db.collection('entitlements').insertMany(
      [orgA, orgB].map((orgId) => ({
        orgId,
        modules: MODULES.map((m: { key: string }) => m.key),
        limits: {},
        status: 'active',
        writable: true,
        version: 1,
        resolvedAt: new Date(),
      })),
    );
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
      person('a-admin', 'admin', { orgId: String(orgA) }),
      person('a-teacher', 'teacher', {
        orgId: String(orgA),
        empCode: `${RUN}-T1`,
      }),
      person('a-student', 'student', {
        orgId: String(orgA),
        classLevel: 'Class 11',
        empCode: `${RUN}-S1`,
      }),
      person('a-parent', 'parent', { orgId: String(orgA) }),
      person('a-revoked', 'admin', { orgId: String(orgA) }),
      person('b-admin', 'admin', { orgId: String(orgB) }),
      person('learner', 'student', { accountType: 'PUBLIC_LEARNER' }),
      // Known to the organization system, attached to no organization, and
      // unknown to the legacy system: nowhere to go.
      person('orphan', 'admin'),
    ]);
    await legacy.db.collection('users').insertMany([
      person('l-admin', 'admin'),
      person('l-teacher', 'teacher', { empCode: `${RUN}-LT1` }),
      person('l-student', 'student', {
        classLevel: 'Class 11',
        empCode: `${RUN}-LS1`,
      }),
      person('l-parent', 'parent'),
      // An organization's account found in the LEGACY database — refused
      // there (single-legacy phase).
      person('tagged', 'admin', { orgId: String(orgA) }),
    ]);
    check(
      'two organizations, every role in each system, and the edge cases',
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
    // Anything an administrator's screen shows, seen at ANY moment while
    // signed out — reported by a watcher injected into every document.
    const leaks: string[] = [];
    page.on('console', (msg: { text: () => string }) => {
      const t = msg.text();
      if (t.startsWith('__WLA_LEAK__'))
        leaks.push(t.slice('__WLA_LEAK__'.length));
    });
    await page.evaluateOnNewDocument((markers: string[]) => {
      const w = window as unknown as { __wlaArmed?: boolean };
      const scan = () => {
        try {
          if (!w.__wlaArmed || !document.body) return;
          if (localStorage.getItem('accessToken')) return;
          const sidebar = document.querySelector(
            '[data-testid="app-sidebar"], [data-testid="client-topbar"]',
          );
          if (sidebar)
            console.log(
              `__WLA_LEAK__${location.pathname}: ${sidebar.getAttribute('data-testid')}`,
            );
          const t = document.body.textContent || '';
          for (const m of markers)
            if (t.includes(m))
              console.log(`__WLA_LEAK__${location.pathname}: "${m}"`);
        } catch {
          /* page tearing down */
        }
      };
      w.__wlaArmed = sessionStorage.getItem('__wlaArmed') === '1';
      new MutationObserver(scan).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    }, ADMIN_MARKERS);

    const go = async (path: string) => {
      await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded' });
      await page
        .waitForNetworkIdle({ idleTime: 400, timeout: 8000 })
        .catch(() => undefined);
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
    const waitForText = async (needle: string, timeoutMs = 20000) =>
      page
        .waitForFunction(
          (n: string) => document.body.innerText.includes(n),
          { timeout: timeoutMs },
          needle,
        )
        .then(() => true)
        .catch(() => false);
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
        base: localStorage.getItem('accountApiBase'),
        hint: localStorage.getItem('orgHint'),
      }))) as {
        local: string[];
        session: string[];
        source: string | null;
        base: string | null;
        hint: string | null;
      };
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
    const submitState = async () =>
      (await page.$eval('button[type="submit"]', (b: Element) => ({
        disabled: (b as HTMLButtonElement).disabled,
        busy: b.getAttribute('aria-busy'),
        text: (b.textContent || '').trim(),
      }))) as { disabled: boolean; busy: string | null; text: string };
    const freshLogin = async (query = '') => {
      await page
        .evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        })
        .catch(() => undefined);
      await go(`/login${query}`);
      await page.waitForSelector('#email');
      // The page reads the session after mount; let that settle before typing.
      await sleep(300);
    };
    const signIn = async (who: string, password = PASSWORD) => {
      await freshLogin();
      await page.type('#email', email(who));
      await page.type('#password', password);
      await page.click('button[type="submit"]');
    };
    const signOutVia = async (selector: string) => {
      await page.waitForSelector(selector);
      await page.click(selector);
      await waitForPath((p) => p.startsWith('/login'));
      await page.waitForSelector('#email');
      await sleep(500);
    };

    /** Visit a screen and judge it: it stays, it renders, it throws nothing. */
    const screen = async (
      label: string,
      url: string,
      expect: {
        stays?: (p: string) => boolean;
        marker?: string;
        selector?: string;
      } = {},
    ) => {
      const before = pageErrors.length;
      await go(url);
      const base = url.split('?')[0];
      const stays = expect.stays ?? ((p: string) => p.split('?')[0] === base);
      const landed = await waitForPath(stays, 12000);
      if (expect.selector)
        await page
          .waitForSelector(expect.selector, { timeout: 15000 })
          .catch(() => undefined);
      const marked = expect.marker
        ? await waitForText(expect.marker, 15000)
        : true;
      await sleep(400);
      const body = await text();
      const crashed =
        /Application error|Unhandled Runtime Error|client-side exception/i.test(
          body,
        );
      const thrown = pageErrors.slice(before);
      const ok =
        stays(landed) &&
        !crashed &&
        body.trim().length > 40 &&
        thrown.length === 0 &&
        marked;
      check(
        `${label}`,
        ok,
        `landed ${landed}${crashed ? ' | CRASHED' : ''}${thrown.length ? ` | threw: ${thrown.slice(0, 2).join(' / ')}` : ''}${
          marked ? '' : ` | "${expect.marker}" never appeared`
        } | ${body.replace(/\s+/g, ' ').slice(0, 140)}`,
      );
      return body;
    };

    if (PHASE === 'single-legacy') {
      await singleLegacy();
    } else {
      await loginForm();
      await legacyFlows();
      await organizationFlows();
      await switching();
      await signedOutAddresses();
      await crossRole();
      await organizationCannotBeChosen();
      await expiredSession();
      await publicScreens();
    }

    section('health');
    check(
      'no uncaught page errors anywhere',
      pageErrors.length === 0,
      pageErrors.slice(0, 5).join(' | '),
    );

    /* ══ The sign-in form ═════════════════════════════════════════════════ */
    async function loginForm() {
      section('the sign-in form');
      await freshLogin();
      await shot('01-login-desktop');
      let s = await submitState();
      check(
        'empty form → the button is disabled',
        s.disabled,
        JSON.stringify(s),
      );
      await page.type('#email', email('l-admin'));
      s = await submitState();
      check('email only → still disabled', s.disabled, JSON.stringify(s));
      await page.type('#password', 'x');
      s = await submitState();
      check('email and password → enabled', !s.disabled, JSON.stringify(s));
      await page.click('#password', { clickCount: 3 });
      await page.keyboard.press('Backspace');
      s = await submitState();
      check('password cleared → disabled again', s.disabled, JSON.stringify(s));

      // Password visibility.
      await page.type('#password', 'secret-1');
      const toggle = 'button[aria-label="Show password"]';
      const hasToggle = (await page.$(toggle)) !== null;
      check('there is a "Show password" control', hasToggle);
      if (hasToggle) {
        await page.click(toggle);
        const shown = (await page.$eval(
          '#password',
          (el: Element) => (el as HTMLInputElement).type,
        )) as string;
        const pressed = await page
          .$eval('button[aria-label="Hide password"]', (el: Element) =>
            el.getAttribute('aria-pressed'),
          )
          .catch(() => null);
        check('…which shows the password', shown === 'text', shown);
        check(
          '…and says so (aria-pressed, "Hide password")',
          pressed === 'true',
          String(pressed),
        );
        await page.click('button[aria-label="Hide password"]');
        const hidden = (await page.$eval(
          '#password',
          (el: Element) => (el as HTMLInputElement).type,
        )) as string;
        check('…and hides it again', hidden === 'password', hidden);
      }

      // Keyboard: Tab order and Enter to submit (a wrong password, so no navigation).
      await freshLogin();
      await page.focus('#email');
      await page.keyboard.type(email('l-admin'));
      await page.keyboard.press('Tab');
      const afterTab = (await page.evaluate(
        () => document.activeElement?.id || '',
      )) as string;
      check(
        'Tab moves from email to password',
        afterTab === 'password',
        afterTab,
      );
      await page.keyboard.type('not-the-password');
      await page.keyboard.press('Enter');
      const errored = await page
        .waitForSelector('[data-testid="login-error"]', { timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      check('Enter submits the form', errored);
      const message = errored
        ? ((await page.$eval(
            '[data-testid="login-error"]',
            (el: Element) => el.textContent || '',
          )) as string)
        : '';
      check(
        'a wrong password: "Email or password is incorrect."',
        message.includes('Email or password is incorrect.'),
        message,
      );
      s = await submitState();
      check(
        '…and the button is usable again at once',
        !s.disabled && s.busy !== 'true',
        JSON.stringify(s),
      );
      await shot('02-login-error');

      // Progress while the credentials are checked, and while the account is resolved.
      await page.setRequestInterception(true);
      const holds = new Map<string, number>();
      const onRequest = (req: {
        url: () => string;
        method: () => string;
        continue: () => Promise<void>;
        isInterceptResolutionHandled?: () => boolean;
      }) => {
        const url = req.url();
        const hold = [...holds.entries()].find(([needle]) =>
          url.includes(needle),
        );
        if (hold && req.method() !== 'OPTIONS')
          setTimeout(() => void req.continue().catch(() => undefined), hold[1]);
        else void req.continue().catch(() => undefined);
      };
      page.on('request', onRequest);
      try {
        holds.set(`:${PLATFORM_PORT}/api/auth/login`, 1500);
        await freshLogin();
        await page.type('#email', email('l-admin'));
        await page.type('#password', 'not-the-password');
        await page.click('button[type="submit"]');
        await sleep(400);
        s = await submitState();
        check(
          'while signing in, the button is busy and says so',
          s.disabled && s.busy === 'true' && /Signing in/i.test(s.text),
          JSON.stringify(s),
        );
        await shot('03-login-busy');
        await page
          .waitForSelector('[data-testid="login-error"]', { timeout: 20000 })
          .catch(() => undefined);
        holds.clear();

        holds.set(`:${PLATFORM_PORT}/api/me/context`, 2000);
        await freshLogin();
        await page.type('#email', email('a-teacher'));
        await page.type('#password', PASSWORD);
        await page.click('button[type="submit"]');
        const resolving = await page
          .waitForFunction(
            () => /Checking your account/i.test(document.body.innerText),
            { timeout: 4000 },
          )
          .then(() => true)
          .catch(() => false);
        check(
          'while the account is resolved, the form says "Checking your account"',
          resolving,
        );
        await shot('04-login-resolving');
        await waitForPath((p) => p.startsWith('/dashboard/teacher'));
        holds.clear();
      } finally {
        page.off('request', onRequest);
        await page.setRequestInterception(false);
      }

      // Neither system reachable.
      await page.setRequestInterception(true);
      const abort = (req: {
        url: () => string;
        abort: () => Promise<void>;
        continue: () => Promise<void>;
      }) => {
        const url = req.url();
        if (
          url.includes(`:${PLATFORM_PORT}/api/auth/login`) ||
          url.includes(`:${LEGACY_PORT}/api/auth/login`)
        )
          void req.abort().catch(() => undefined);
        else void req.continue().catch(() => undefined);
      };
      page.on('request', abort);
      try {
        await freshLogin();
        await page.type('#email', email('l-admin'));
        await page.type('#password', PASSWORD);
        await page.click('button[type="submit"]');
        await page
          .waitForSelector('[data-testid="login-error"]', { timeout: 20000 })
          .catch(() => undefined);
        const down = (await page
          .$eval(
            '[data-testid="login-error"]',
            (el: Element) => el.textContent || '',
          )
          .catch(() => '')) as string;
        check(
          'no server: "We couldn\'t reach the sign-in service…"',
          /couldn.t reach the sign-in service/i.test(down),
          down,
        );
        s = await submitState();
        check(
          '…and the button is usable again',
          !s.disabled,
          JSON.stringify(s),
        );
        await shot('05-login-unavailable');
      } finally {
        page.off('request', abort);
        await page.setRequestInterception(false);
      }

      // An account with nowhere to go.
      await signIn('orphan');
      await page
        .waitForSelector('[data-testid="login-error"]', { timeout: 20000 })
        .catch(() => undefined);
      const orphan = (await page
        .$eval(
          '[data-testid="login-error"]',
          (el: Element) => el.textContent || '',
        )
        .catch(() => '')) as string;
      check(
        'an account linked to no institute is told so',
        /isn.t linked to an institute/i.test(orphan),
        orphan,
      );
      check(
        '…and nothing is stored',
        !(await storage()).local.includes('accessToken'),
      );

      // The browser fills the fields WITHOUT telling React (Chrome's autofill
      // before the first click, a password manager): the button must still
      // come on, and the submit must use what is in the fields.
      await freshLogin();
      const autofillRule = (await page.evaluate(() => {
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRuleList | null = null;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          for (const rule of Array.from(rules)) {
            const r = rule as CSSStyleRule;
            // The rule that STARTS when a field is autofilled (not its `:not()` twin).
            if (
              r.selectorText &&
              r.selectorText.includes('-webkit-autofill') &&
              !r.selectorText.includes(':not(') &&
              r.style &&
              r.style.animationName
            )
              return r.style.animationName;
          }
        }
        return null;
      })) as string | null;
      check(
        "the page listens for the browser's autofill signal",
        autofillRule !== null,
        String(autofillRule),
      );
      await page.evaluate(
        (e: string, p: string, animation: string | null) => {
          const set = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )!.set!;
          const emailEl = document.getElementById('email') as HTMLInputElement;
          const passwordEl = document.getElementById(
            'password',
          ) as HTMLInputElement;
          set.call(emailEl, e);
          set.call(passwordEl, p);
          // What Chrome fires when it autofills (the page's :-webkit-autofill animation).
          for (const el of [emailEl, passwordEl]) {
            el.dispatchEvent(
              new AnimationEvent('animationstart', {
                animationName: animation || 'login-autofill',
                bubbles: true,
              }),
            );
          }
        },
        email('l-admin'),
        PASSWORD,
        autofillRule,
      );
      await sleep(300);
      s = await submitState();
      check(
        'autofilled fields → the button is enabled',
        !s.disabled,
        JSON.stringify(s),
      );
      if (!s.disabled) {
        await page.click('button[type="submit"]');
        const landed = await waitForPath(
          (p) => p.startsWith('/dashboard/admin'),
          20000,
        );
        check(
          '…and signing in uses the autofilled values',
          landed.startsWith('/dashboard/admin'),
          landed,
        );
      }
      await page.evaluate(() => localStorage.clear());

      // Sizes.
      for (const [label, width, height] of [
        ['phone', 375, 812],
        ['tablet', 820, 1180],
        ['laptop', 1366, 900],
        ['wide desktop', 1920, 1080],
      ] as [string, number, number][]) {
        await page.setViewport({ width, height });
        await freshLogin();
        await sleep(600);
        const fit = (await page.evaluate(() => {
          const box = (sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
            };
          };
          return {
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            email: box('#email'),
            submit: box('button[type="submit"]'),
            vw: window.innerWidth,
            vh: window.innerHeight,
          };
        })) as {
          overflow: number;
          email: {
            left: number;
            right: number;
            top: number;
            bottom: number;
          } | null;
          submit: {
            left: number;
            right: number;
            top: number;
            bottom: number;
          } | null;
          vw: number;
          vh: number;
        };
        check(
          `${label} (${width}×${height}): no sideways scrolling`,
          fit.overflow <= 0,
          `overflow ${fit.overflow}px`,
        );
        check(
          `${label}: the whole form is on the first screen`,
          !!fit.email &&
            !!fit.submit &&
            fit.email.left >= 0 &&
            fit.email.right <= fit.vw &&
            fit.submit.bottom <= fit.vh &&
            fit.submit.top >= 0,
          JSON.stringify(fit),
        );
        await shot(`06-login-${label.replace(/\s+/g, '-')}`);
      }
      await page.setViewport({ width: 1366, height: 900 });
    }

    /* ══ Legacy accounts ══════════════════════════════════════════════════ */
    async function legacyFlows() {
      section('legacy accounts: their own screens, their own system');

      // Administrator.
      apiCalls.length = 0;
      await signIn('l-admin');
      const landed = await waitForPath((p) =>
        p.startsWith('/dashboard/admin?tab=dashboard'),
      );
      check(
        'the legacy administrator lands on the old admin panel',
        landed.startsWith('/dashboard/admin?tab=dashboard'),
        landed,
      );
      await waitForText('Admin Panel');
      await sleep(800);
      await shot('10-legacy-admin');
      let body = await text();
      check('…under the legacy identity', body.includes(LEGACY_NAME));
      check(
        '…in the legacy palette',
        (await brandState()).primary === LEGACY_PRIMARY,
        JSON.stringify(await brandState()),
      );
      check(
        '…with the old top navigation',
        body.includes('Question Papers') && body.includes('Logout'),
      );
      check(
        '…and no organization',
        !body.includes(ORG_A.name) && !body.includes(ORG_B.name),
      );
      const st = await storage();
      check(
        'the session is a legacy one',
        st.source === 'legacy',
        JSON.stringify(st),
      );

      const tabs: [string, string][] = [
        ['dashboard', 'Dashboard'],
        ['users', 'Users'],
        ['exams', 'Exams'],
        ['questions', 'Question Bank'],
        ['create-paper', 'Create Paper'],
        ['papers', 'Question Papers'],
        ['smart-import', 'Smart Import'],
        ['eod-reports', 'EOD Reports'],
        ['analytics', 'Analytics'],
        ['guidance', 'LLM Guidance'],
        ['public-tests', 'Public Tests'],
        ['automation', 'EPUB Automation'],
        ['questml', 'QuestMl Ingest'],
      ];
      for (const [tab, label] of tabs) {
        await screen(
          `legacy admin panel · ${label}`,
          `/dashboard/admin?tab=${tab}`,
          {
            stays: (p) => p === `/dashboard/admin?tab=${tab}`,
            marker: 'Admin Panel',
          },
        );
      }
      const appPages: [string, string][] = [
        ['', 'App Management'],
        ['users', 'Users'],
        ['registrations', 'Registrations'],
        ['courses', 'Courses'],
        ['batches', 'Batches'],
        ['resources', 'Resources'],
        ['public-tests', 'Public Learning tests'],
        ['attendance', 'Attendance'],
        ['schedule', 'Schedule'],
        ['leaves', 'Leaves'],
        ['holidays', 'Holidays'],
        ['eod', 'EOD Reports'],
        ['sync', 'Firebase Sync'],
      ];
      for (const [slug, label] of appPages) {
        const url = `/dashboard/admin/app-management${slug ? `/${slug}` : ''}`;
        await screen(`legacy App Management · ${label}`, url, {
          selector: '[data-testid="app-sidebar"][data-experience="legacy"]',
        });
      }
      await screen(
        'legacy biometric attendance',
        '/dashboard/admin/attendance',
      );
      body = await screen(
        'legacy App Management: the organization pages are not offered',
        '/dashboard/admin/app-management/organization',
        {
          selector: '[data-testid="not-available"]',
        },
      );
      check(
        '…"Institute settings … aren\'t available for this account"',
        body.includes("aren't available for this account"),
      );

      const legacyAfterLogin = apiCalls.slice(
        apiCalls.findIndex((u) =>
          u.includes(`:${LEGACY_PORT}/api/auth/login`),
        ) + 1,
      );
      check(
        'every request after signing in went to the legacy system',
        legacyAfterLogin.length > 0 &&
          legacyAfterLogin.every((u) => u.includes(`:${LEGACY_PORT}/`)),
        legacyAfterLogin
          .filter((u) => !u.includes(`:${LEGACY_PORT}/`))
          .slice(0, 5)
          .join(', '),
      );

      // A refresh keeps the session and the identity.
      await go('/dashboard/admin?tab=users');
      await waitForText('Admin Panel');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForText('Admin Panel');
      await sleep(600);
      body = await text();
      check(
        'refresh: still the legacy admin panel, still the legacy identity',
        (await path()).startsWith('/dashboard/admin?tab=users') &&
          body.includes(LEGACY_NAME) &&
          (await storage()).source === 'legacy',
        await path(),
      );

      await page.click('button ::-p-text(Logout)');
      await waitForPath((p) => p.startsWith('/login'));
      await page.waitForSelector('#email');
      await sleep(500);
      const after = await storage();
      check(
        'Logout lands on the sign-in, with the session gone',
        !after.local.includes('accessToken') &&
          !after.local.includes('accountSource'),
        after.local.join(','),
      );
      body = await text();
      check('…saying so', /signed out/i.test(body));
      check(
        '…in the neutral palette, with no legacy identity',
        (await brandState()).primary === NEUTRAL_PRIMARY &&
          !body.includes(LEGACY_NAME),
        JSON.stringify(await brandState()),
      );
      await shot('11-signed-out');

      // Teacher.
      await signIn('l-teacher');
      let home = await waitForPath((p) => p.startsWith('/dashboard/teacher'));
      check(
        'the legacy teacher lands on the teacher dashboard',
        home.startsWith('/dashboard/teacher'),
        home,
      );
      await sleep(800);
      await shot('12-legacy-teacher');
      body = await text();
      check(
        '…under the legacy identity, with the legacy navigation',
        body.includes(LEGACY_NAME) && body.includes('Logout'),
      );
      for (const tab of ['create-paper', 'exams', 'ai', 'papers', 'import']) {
        await screen(
          `legacy teacher · ${tab}`,
          `/dashboard/teacher?tab=${tab}`,
          { stays: (p) => p.startsWith('/dashboard/teacher') },
        );
      }
      await screen('legacy teacher · reviews', '/dashboard/teacher/reviews');
      await screen('legacy teacher · schedule', '/dashboard/teacher/schedule');
      await page.click('button ::-p-text(Logout)');
      await waitForPath((p) => p.startsWith('/login'));

      // Student.
      await signIn('l-student');
      home = await waitForPath((p) => p.startsWith('/dashboard/student'));
      check(
        'the legacy student lands on the student dashboard',
        home.startsWith('/dashboard/student'),
        home,
      );
      await sleep(800);
      await shot('13-legacy-student');
      for (const tab of ['exams', 'progress', 'practice', 'results']) {
        await screen(
          `legacy student · ${tab}`,
          `/dashboard/student?tab=${tab}`,
          { stays: (p) => p.startsWith('/dashboard/student') },
        );
      }
      await screen('legacy student · schedule', '/dashboard/student/schedule');
      await screen(
        'legacy student · attendance',
        '/dashboard/student/attendance',
      );
      await page.click('button ::-p-text(Logout)');
      await waitForPath((p) => p.startsWith('/login'));

      // Parent.
      await signIn('l-parent');
      home = await waitForPath((p) => p.startsWith('/dashboard/parent'));
      check(
        'the legacy parent lands on the parent dashboard',
        home.startsWith('/dashboard/parent'),
        home,
      );
      await sleep(800);
      await shot('14-legacy-parent');
      await screen('legacy parent · dashboard', '/dashboard/parent');
      body = await text();
      check('…under the legacy identity', body.includes(LEGACY_NAME));
      await page.click('button ::-p-text(Logout)');
      await waitForPath((p) => p.startsWith('/login'));
    }

    /* ══ Organization accounts ════════════════════════════════════════════ */
    async function organizationFlows() {
      section(
        "organization accounts: their organization's screens, and only those",
      );

      apiCalls.length = 0;
      await signIn('a-admin');
      const landed = await waitForPath((p) =>
        p.startsWith('/dashboard/admin/app-management'),
      );
      check(
        'the administrator lands in App Management',
        landed.startsWith('/dashboard/admin/app-management'),
        landed,
      );
      await page.waitForSelector(
        '[data-testid="app-sidebar"][data-experience="organization"]',
      );
      await waitForText(ORG_A.name);
      await sleep(800);
      await shot('20-org-admin');
      let body = await text();
      let brand = await brandState();
      check("…under the organization's name", body.includes(ORG_A.name));
      check(
        "…in the organization's colour",
        brand.primary === ORG_A.primary && brand.brand === 'tenant',
        JSON.stringify(brand),
      );
      check('…with its logo as the tab icon', brand.tenantIcon === ORG_A.logo);
      check('…titled with its name', brand.title === ORG_A.name, brand.title);
      check(
        '…and nothing of the legacy identity',
        !/Abhigyan|Tree of Knowledge/i.test(body),
      );
      for (const tool of [
        'Firebase Sync',
        'EPUB Automation',
        'QuestMl',
        'Back to Main Admin',
        'Admin Panel',
        'Manage platform entities',
        'Tests & Series',
      ]) {
        check(`no "${tool}"`, !body.includes(tool));
      }
      check(
        'the organization system served everything',
        apiCalls.length > 0 &&
          apiCalls.every((u) => u.includes(`:${PLATFORM_PORT}/`)),
        apiCalls.filter((u) => !u.includes(`:${PLATFORM_PORT}/`)).join(', '),
      );

      const pages: [string, string][] = [
        ['organization', 'Organization'],
        ['parent-requests', 'Parent requests'],
        ['users', 'Users'],
        ['registrations', 'Registrations'],
        ['exams', 'Exams'],
        ['question-bank', 'Question bank'],
        ['create-paper', 'Create paper'],
        ['papers', 'Question papers'],
        ['smart-import', 'Smart import'],
        ['ai-guidance', 'AI guidance'],
        ['courses', 'Courses'],
        ['batches', 'Batches'],
        ['resources', 'Resources'],
        ['schedule', 'Schedule'],
        ['leaves', 'Leaves'],
        ['holidays', 'Holidays'],
        ['eod', 'EOD Reports'],
        ['analytics', 'Analytics'],
      ];
      for (const [slug, label] of pages) {
        await screen(
          `App Management · ${label}`,
          `/dashboard/admin/app-management/${slug}`,
          {
            selector:
              '[data-testid="app-sidebar"][data-experience="organization"]',
          },
        );
      }
      for (const [from, to] of [
        ['/dashboard/admin', '/dashboard/admin/app-management'],
        ['/dashboard/admin?tab=exams', '/dashboard/admin/app-management/exams'],
        ['/dashboard/admin?tab=users', '/dashboard/admin/app-management/users'],
        ['/dashboard/admin?tab=automation', '/dashboard/admin/app-management'],
        ['/dashboard/admin/automation', '/dashboard/admin/app-management'],
        ['/dashboard/admin/questml', '/dashboard/admin/app-management'],
        ['/dashboard/admin/attendance', '/dashboard/admin/app-management'],
      ] as [string, string][]) {
        await go(from);
        const p = await waitForPath((x) => x.split('?')[0] === to, 15000);
        check(`the legacy address ${from} → ${to}`, p.split('?')[0] === to, p);
      }
      for (const slug of ['sync', 'attendance', 'public-tests']) {
        await go(`/dashboard/admin/app-management/${slug}`);
        const shown = await page
          .waitForSelector('[data-testid="not-available"]', { timeout: 15000 })
          .then(() => true)
          .catch(() => false);
        check(
          `the legacy/platform tool "${slug}" by address: "not available"`,
          shown,
        );
      }

      await go('/dashboard/admin/app-management/users');
      await waitForText(ORG_A.name);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector(
        '[data-testid="app-sidebar"][data-experience="organization"]',
      );
      await waitForText(ORG_A.name);
      await sleep(600);
      brand = await brandState();
      check(
        "refresh: still App Management, still the organization's identity",
        (await path()).startsWith('/dashboard/admin/app-management/users') &&
          brand.primary === ORG_A.primary &&
          brand.title === ORG_A.name,
        `${await path()} ${JSON.stringify(brand)}`,
      );
      await signOutVia('[data-testid="sign-out"]');
      body = await text();
      brand = await brandState();
      check(
        'signed out: nothing of the organization remains',
        !body.includes(ORG_A.name) &&
          brand.primary === NEUTRAL_PRIMARY &&
          brand.tenantIcon === null,
        JSON.stringify(brand),
      );
      const st = await storage();
      check(
        '…and nothing of the session',
        st.local.filter((k) => !k.startsWith('__')).length === 0 &&
          st.session.length === 0,
        `${st.local.join(',')} | ${st.session.join(',')}`,
      );

      // Teacher, student, parent: the organization's shell.
      for (const [who, home, extra] of [
        [
          'a-teacher',
          '/dashboard/teacher',
          [
            '/dashboard/teacher?tab=create-paper',
            '/dashboard/teacher?tab=exams',
            '/dashboard/teacher?tab=papers',
            '/dashboard/teacher/reviews',
            '/dashboard/teacher/schedule',
          ],
        ],
        [
          'a-student',
          '/dashboard/student',
          [
            '/dashboard/student?tab=exams',
            '/dashboard/student?tab=progress',
            '/dashboard/student?tab=results',
            '/dashboard/student/schedule',
          ],
        ],
        ['a-parent', '/dashboard/parent', []],
      ] as [string, string, string[]][]) {
        await signIn(who);
        const p = await waitForPath((x) => x.startsWith(home));
        check(
          `the organization's ${who.slice(2)} lands on ${home}`,
          p.startsWith(home),
          p,
        );
        await page
          .waitForSelector('[data-testid="client-topbar"]')
          .catch(() => undefined);
        await waitForText(ORG_A.name);
        await sleep(700);
        await shot(`21-org-${who.slice(2)}`);
        body = await text();
        brand = await brandState();
        check(
          `…inside the organization's top bar, under its name and colour`,
          body.includes(ORG_A.name) && brand.primary === ORG_A.primary,
          JSON.stringify(brand),
        );
        check(
          '…and nothing of the legacy identity',
          !/Abhigyan|Tree of Knowledge|Logout/.test(body),
        );
        for (const url of extra) {
          await screen(
            `organization ${who.slice(2)} · ${url.replace(/^\/dashboard\//, '')}`,
            url,
            {
              stays: (x) => x.startsWith(url.split('?')[0]),
              selector: '[data-testid="client-topbar"]',
            },
          );
        }
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForText(ORG_A.name);
        check(
          `refresh keeps the ${who.slice(2)} in the organization`,
          (await brandState()).primary === ORG_A.primary,
        );
        await signOutVia('[data-testid="sign-out"]');
      }
    }

    /* ══ Switching accounts in one browser ════════════════════════════════ */
    async function switching() {
      section('switching accounts leaves nothing behind');

      // Legacy → organization.
      await signIn('l-admin');
      await waitForPath((p) => p.startsWith('/dashboard/admin?tab='));
      await waitForText('Admin Panel');
      await page.click('button ::-p-text(Logout)');
      await waitForPath((p) => p.startsWith('/login'));
      await page.waitForSelector('#email');
      await page.type('#email', email('a-admin'));
      await page.type('#password', PASSWORD);
      await page.click('button[type="submit"]');
      await waitForPath((p) => p.startsWith('/dashboard/admin/app-management'));
      await waitForText(ORG_A.name);
      await sleep(700);
      let body = await text();
      let brand = await brandState();
      check(
        'legacy → organization: the organization, and nothing of the legacy screens',
        body.includes(ORG_A.name) &&
          !body.includes(LEGACY_NAME) &&
          brand.primary === ORG_A.primary &&
          (await storage()).source === 'console',
        JSON.stringify(brand),
      );

      // Organization → legacy.
      await signOutVia('[data-testid="sign-out"]');
      await page.type('#email', email('l-admin'));
      await page.type('#password', PASSWORD);
      await page.click('button[type="submit"]');
      await waitForPath((p) => p.startsWith('/dashboard/admin?tab='));
      await waitForText('Admin Panel');
      await sleep(700);
      body = await text();
      brand = await brandState();
      check(
        'organization → legacy: the legacy screens, and nothing of the organization',
        body.includes(LEGACY_NAME) &&
          !body.includes(ORG_A.name) &&
          brand.primary === LEGACY_PRIMARY &&
          brand.tenantIcon !== ORG_A.logo &&
          brand.title !== ORG_A.name,
        JSON.stringify(brand),
      );
      await page.click('button ::-p-text(Logout)');
      await waitForPath((p) => p.startsWith('/login'));

      // Organization A → organization B.
      await signIn('a-admin');
      await waitForPath((p) => p.startsWith('/dashboard/admin/app-management'));
      await waitForText(ORG_A.name);
      await signOutVia('[data-testid="sign-out"]');
      body = await text();
      check(
        'between the two: a neutral sign-in',
        !body.includes(ORG_A.name) &&
          (await brandState()).primary === NEUTRAL_PRIMARY,
      );
      await page.type('#email', email('b-admin'));
      await page.type('#password', PASSWORD);
      await page.click('button[type="submit"]');
      await waitForPath((p) => p.startsWith('/dashboard/admin/app-management'));
      await waitForText(ORG_B.name);
      await sleep(800);
      await shot('22-org-b-admin');
      body = await text();
      brand = await brandState();
      check("organization A → B: B's name", body.includes(ORG_B.name));
      check(
        "…B's colour",
        brand.primary === ORG_B.primary,
        JSON.stringify(brand),
      );
      check("…B's title", brand.title === ORG_B.name, brand.title);
      check(
        '…and nothing of A: not its name, logo or icon',
        !body.includes(ORG_A.name) &&
          brand.tenantIcon === null &&
          (await page.$(`img[src="${ORG_A.logo}"]`)) === null,
        JSON.stringify(brand),
      );
      await signOutVia('[data-testid="sign-out"]');
    }

    /* ══ Signed out, every dashboard address is the sign-in ═══════════════ */
    async function signedOutAddresses() {
      section(
        'signed out: every dashboard address shows the sign-in, and nothing else — ever',
      );
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        sessionStorage.setItem('__wlaArmed', '1');
      });
      leaks.length = 0;
      for (const url of [
        '/dashboard',
        '/dashboard/admin',
        '/dashboard/admin?tab=users',
        '/dashboard/admin/app-management',
        '/dashboard/admin/app-management/eod',
        '/dashboard/admin/app-management/attendance',
        '/dashboard/admin/app-management/schedule',
        '/dashboard/admin/attendance',
        '/dashboard/admin/automation',
        '/dashboard/teacher',
        '/dashboard/teacher/reviews',
        '/dashboard/student',
        '/dashboard/student/attendance',
        '/dashboard/parent',
        '/dashboard/leaves',
        '/dashboard/schedule',
        '/dashboard/exam',
      ]) {
        const before = leaks.length;
        await go(url);
        const p = await waitForPath((x) => x.startsWith('/login'), 12000);
        await sleep(300);
        const body = await text();
        const shown = ADMIN_MARKERS.filter((m) => body.includes(m));
        check(
          `${url} → the sign-in, with nothing of a dashboard shown on the way`,
          p.startsWith('/login') &&
            shown.length === 0 &&
            leaks.length === before,
          `landed ${p}; on screen: ${shown.join(', ') || '—'}; seen while loading: ${leaks.slice(before).slice(0, 4).join(' | ') || '—'}`,
        );
      }
      await go('/dashboard/admin/app-management/eod');
      await waitForPath((x) => x.startsWith('/login'), 12000);
      await shot('30-signed-out-direct-address');
      const notice = await text();
      check(
        '…and the sign-in says why',
        /sign in to continue/i.test(notice),
        notice.slice(0, 200),
      );
      await page.evaluate(() => sessionStorage.removeItem('__wlaArmed'));
    }

    /* ══ Roles and systems cannot reach each other's screens ══════════════ */
    async function crossRole() {
      section("a role cannot open another role's screens by address");
      for (const [who, home, targets] of [
        [
          'l-teacher',
          '/dashboard/teacher',
          [
            '/dashboard/admin',
            '/dashboard/admin/app-management',
            '/dashboard/admin/app-management/eod',
            '/dashboard/admin/app-management/schedule',
            '/dashboard/admin/attendance',
            '/dashboard/student',
          ],
        ],
        [
          'l-student',
          '/dashboard/student',
          [
            '/dashboard/admin',
            '/dashboard/admin/app-management/users',
            '/dashboard/teacher',
          ],
        ],
        [
          'a-teacher',
          '/dashboard/teacher',
          [
            '/dashboard/admin',
            '/dashboard/admin/app-management',
            '/dashboard/admin/app-management/eod',
            '/dashboard/admin/app-management/leaves',
            '/dashboard/admin/attendance',
          ],
        ],
        [
          'a-student',
          '/dashboard/student',
          [
            '/dashboard/admin/app-management/users',
            '/dashboard/admin/app-management/schedule',
            '/dashboard/teacher',
          ],
        ],
      ] as [string, string, string[]][]) {
        await signIn(who);
        await waitForPath((x) => x.startsWith(home));
        await sleep(500);
        for (const target of targets) {
          await go(target);
          const p = await waitForPath((x) => x.startsWith(home), 15000);
          await sleep(300);
          const sidebar =
            (await page.$('[data-testid="app-sidebar"]')) !== null;
          check(
            `${who}: ${target} → ${home}`,
            p.startsWith(home) && !sidebar,
            `landed ${p}${sidebar ? ' | an admin sidebar is on screen' : ''}`,
          );
        }
        await page.evaluate(() => localStorage.clear());
      }
    }

    /* ══ A signed-in session's organization cannot be chosen by the browser ═ */
    async function organizationCannotBeChosen() {
      section(
        "a signed-in session's organization comes from the account, never the browser",
      );
      await signIn('a-teacher');
      await waitForPath((x) => x.startsWith('/dashboard/teacher'));
      await waitForText(ORG_A.name);
      await page.evaluate(
        (slug: string) => localStorage.setItem('orgHint', slug),
        slugB,
      );
      await go(`/dashboard/teacher?org=${slugB}`);
      await waitForText(ORG_A.name);
      await sleep(800);
      const body = await text();
      const brand = await brandState();
      check(
        'an edited orgHint and ?org=<another organization> change nothing',
        body.includes(ORG_A.name) &&
          !body.includes(ORG_B.name) &&
          brand.primary === ORG_A.primary,
        JSON.stringify(brand),
      );
      const probe = (await page.evaluate(
        async (base: string, hints: string[]) => {
          const token = localStorage.getItem('accessToken');
          const out: { hint: string; status: number; org: string | null }[] =
            [];
          for (const hint of hints) {
            const res = await fetch(`${base}/me/context`, {
              headers: { Authorization: `Bearer ${token}`, 'X-Org-Id': hint },
            });
            let org: string | null = null;
            try {
              const data = await res.json();
              org = data?.organization?.id ?? null;
            } catch {
              org = null;
            }
            out.push({ hint, status: res.status, org });
          }
          return out;
        },
        `http://127.0.0.1:${PLATFORM_PORT}/api`,
        [String(orgB), slugB],
      )) as { hint: string; status: number; org: string | null }[];
      check(
        'X-Org-Id naming another organization never yields that organization',
        probe.every((r) => r.org !== String(orgB)),
        JSON.stringify(probe),
      );
      check(
        "…the server refuses the mismatch or keeps the account's own",
        probe.every(
          (r) => r.status === 400 || r.status === 403 || r.org === String(orgA),
        ),
        JSON.stringify(probe),
      );
      await page.evaluate(() =>
        localStorage.setItem('accountApiBase', 'http://127.0.0.1:9/api'),
      );
      apiCalls.length = 0;
      await go('/dashboard/teacher');
      await waitForText(ORG_A.name);
      await sleep(600);
      check(
        "a planted API address is ignored: every request still goes to the account's own system",
        apiCalls.length > 0 &&
          apiCalls.every((u) => u.includes(`:${PLATFORM_PORT}/`)),
        apiCalls.slice(0, 4).join(', '),
      );
      await signOutVia('[data-testid="sign-out"]');
    }

    /* ══ An expired session ═══════════════════════════════════════════════ */
    async function expiredSession() {
      section('an ended session lands on a neutral sign-in');
      await signIn('a-revoked');
      await waitForPath((x) => x.startsWith('/dashboard/admin/app-management'));
      await waitForText(ORG_A.name);
      await platform.db
        .collection('users')
        .updateOne(
          { email: email('a-revoked') },
          { $set: { tokenVersion: 1 } },
        );
      await go('/dashboard/admin/app-management/users');
      const p = await waitForPath((x) => x.startsWith('/login'), 20000);
      check(
        'a revoked session is sent to the sign-in',
        p.startsWith('/login?session=expired'),
        p,
      );
      await page.waitForSelector('#email').catch(() => undefined);
      await sleep(900);
      await shot('31-session-ended');
      const body = await text();
      const brand = await brandState();
      check(
        '…which says the session ended',
        /session has ended/i.test(body),
        body.slice(0, 200),
      );
      check(
        '…and shows nothing of the last institute',
        !body.includes(ORG_A.name) &&
          brand.primary === NEUTRAL_PRIMARY &&
          brand.tenantIcon === null,
        JSON.stringify(brand),
      );
      const st = await storage();
      check(
        '…or of its session',
        !st.local.includes('accessToken') && st.hint === null,
        JSON.stringify(st),
      );
    }

    /* ══ Public screens ═══════════════════════════════════════════════════ */
    async function publicScreens() {
      section('public screens');
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      await go('/');
      await sleep(500);
      let body = await text();
      let brand = await brandState();
      check(
        'the landing page is neutral when no organization is known',
        !body.includes(ORG_A.name) &&
          !body.includes(LEGACY_NAME) &&
          brand.primary === NEUTRAL_PRIMARY,
        JSON.stringify(brand),
      );
      check(
        '…with one way in and no role buttons',
        /Sign in/.test(body) &&
          !/Student Login|Teacher Login|Admin Login|Select Your Role/.test(
            body,
          ),
      );
      await go(`/login?org=${slugA}`);
      await waitForText(ORG_A.name);
      await sleep(400);
      brand = await brandState();
      check(
        'a sign-in link that names an organization shows its name and colours',
        brand.primary === ORG_A.primary,
        JSON.stringify(brand),
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForText(ORG_A.name);
      check(
        '…and keeps them on refresh',
        (await brandState()).primary === ORG_A.primary,
      );
      await shot('32-login-org-link');
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      await go('/login');
      await sleep(600);
      body = await text();
      brand = await brandState();
      check(
        'without the link: neutral again',
        !body.includes(ORG_A.name) && brand.primary === NEUTRAL_PRIMARY,
        JSON.stringify(brand),
      );
      await go('/login?session=expired');
      check(
        '/login?session=expired explains itself',
        /session has ended/i.test(await text()),
      );
      await go('/no-such-page');
      await sleep(400);
      body = await text();
      check(
        'an unknown address: a "doesn\'t exist" page with a way to sign in',
        /doesn.t exist/i.test(body) && /sign in/i.test(body),
        body.slice(0, 160),
      );
      check(
        '…and no dashboard navigation',
        !ADMIN_MARKERS.some((m) => body.includes(m)) &&
          (await page.$('[data-testid="client-topbar"]')) === null,
      );
      await shot('33-not-found');
    }

    /* ══ One backend at the organization address, serving the legacy DB ══ */
    async function singleLegacy() {
      section('one backend, legacy database, at the organization address');
      await freshLogin();
      check(
        'the sign-in is neutral',
        (await brandState()).primary === NEUTRAL_PRIMARY,
      );
      apiCalls.length = 0;
      await signIn('l-admin');
      const landed = await waitForPath((p) =>
        p.startsWith('/dashboard/admin?tab=dashboard'),
      );
      check(
        'a legacy administrator gets the legacy admin panel',
        landed.startsWith('/dashboard/admin?tab=dashboard'),
        landed,
      );
      await waitForText('Admin Panel');
      await sleep(700);
      await shot('40-single-legacy-admin');
      const st = await storage();
      check(
        '…as a legacy session bound to the address that accepted it',
        st.source === 'legacy' &&
          st.base === `http://127.0.0.1:${PLATFORM_PORT}/api`,
        JSON.stringify(st),
      );
      check(
        '…and every request went to that address',
        apiCalls.length > 0 &&
          apiCalls.every((u) => u.includes(`:${PLATFORM_PORT}/`)),
        apiCalls.filter((u) => !u.includes(`:${PLATFORM_PORT}/`)).join(', '),
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForText('Admin Panel');
      check(
        'refresh keeps it',
        (await storage()).source === 'legacy' &&
          (await text()).includes(LEGACY_NAME),
      );
      await page.click('button ::-p-text(Logout)');
      await waitForPath((p) => p.startsWith('/login'));
      await page.waitForSelector('#email');

      await signIn('l-teacher');
      const teacher = await waitForPath((p) =>
        p.startsWith('/dashboard/teacher'),
      );
      check(
        'a legacy teacher gets the teacher dashboard',
        teacher.startsWith('/dashboard/teacher'),
        teacher,
      );
      await page.evaluate(() => localStorage.clear());

      await signIn('tagged');
      await page
        .waitForSelector('[data-testid="login-error"]', { timeout: 20000 })
        .catch(() => undefined);
      const refused = (await page
        .$eval(
          '[data-testid="login-error"]',
          (el: Element) => el.textContent || '',
        )
        .catch(() => '')) as string;
      check(
        'an organization account in the legacy database is refused, and told where to go',
        /belongs to an organization/i.test(refused),
        refused,
      );
      check(
        '…with nothing stored',
        !(await storage()).local.includes('accessToken'),
      );
      check(
        '…and nothing internal on screen',
        !/abhigyangurukul|mongo|stack|token/i.test(await text()),
      );
      await shot('41-single-legacy-org-refused');
    }
  } finally {
    await browser.close().catch(() => undefined);
    await cleanup().catch((e: Error) =>
      console.error('cleanup failed:', e.message),
    );
    await platform.close();
    await legacy.close();
  }

  console.log(
    `\n  ${checks - failures}/${checks} checks passed.   (screens: ${SHOTS})`,
  );
  if (failed.length) console.log(`  failed:\n    - ${failed.join('\n    - ')}`);
  console.log('');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
