/**
 * ONE BUILD, TWO ORGANIZATIONS — the claim P6 exists to make, tested.
 *
 * ── What this proves, and how ───────────────────────────────────────────────
 * A single production build of client-platform-web, served from a single
 * process, at a single URL, is driven through both tenants in the same browser
 * session. Nothing between the two runs changes except who logs in. No rebuild,
 * no environment variable, no query string that selects a tenant, no source
 * edit. If the same bytes did not serve both institutes correctly, this suite
 * could not pass.
 *
 * The fixture is chosen so that a client which quietly ignored the tenant
 * context would FAIL rather than coincidentally pass:
 *
 *   Abhigyan     classes 7–12, fifteen subjects, eleven numbered rooms,
 *                +1/0/0 marking, no branding, all 34 modules
 *   ABC Coaching classes 9–12 AND "dropper", four subjects, four halls and
 *                labs, +4/-1/0 marking, orange branding, 30 modules
 *
 * Eleven "Room N" options cannot be mistaken for four halls, and "dropper" is
 * precisely the value the old digit-extracting class normalizer dropped on the
 * floor, so it appearing in a picker is meaningful rather than incidental.
 *
 * ── Three principals, three different reasons to be denied ──────────────────
 *   ABC admin        every permission, restricted PLAN  -> module denials
 *   ABC front desk   full plan, seven permissions       -> permission denials
 *   Abhigyan admin   everything                         -> the control
 *
 * A suite that only varied the plan would never notice a permission gate wired
 * to nothing, and vice versa.
 *
 * ── Prerequisites ───────────────────────────────────────────────────────────
 *   P6_MONGO_URI=<scratch db>  npm run p6:seed      # fixture: two organizations
 *   P6_MONGO_URI=<scratch db>  npm run p6:serve     # api-platform, claim mode, :5055
 *   (in client-platform-web)   NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:5055/api  *                                npm run build && npx next start -p 3200
 *
 *   npm run safety:web
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const WEB_BASE = process.env.P6_WEB_BASE || 'http://127.0.0.1:3200';
const API_BASE = process.env.P6_API_BASE || 'http://127.0.0.1:5055/api';
const SHOTS = join(process.cwd(), 'docs', 'p6-screens');

const ORG_001 = {
  label: 'Abhigyan Gurukull',
  slug: 'abhigyan',
  admin: { email: 'p6.admin@abhigyan.fixture', password: 'P6-fixture-abhigyan!' },
  frontDesk: { email: 'p6.frontdesk@abhigyan.fixture', password: 'P6-fixture-abhigyan!' },
  classKeys: ['7', '8', '9', '10', '11', '12'],
  subjectCount: 15,
  rooms: ['Room 1', 'Room 11'],
  marking: { correct: 1, incorrect: 0, unattempted: 0 },
  moduleCount: 34,
};

const ORG_002 = {
  label: 'ABC Coaching Institute',
  slug: 'abc-coaching',
  admin: { email: 'p6.admin@abc.fixture', password: 'P6-fixture-abc!' },
  frontDesk: { email: 'p6.frontdesk@abc-coaching.fixture', password: 'P6-fixture-abc!' },
  classKeys: ['9', '10', '11', '12', 'dropper'],
  subjectCount: 4,
  rooms: ['Hall A', 'Hall B', 'Lab 1', 'Lab 2'],
  marking: { correct: 4, incorrect: -1, unattempted: 0 },
  moduleCount: 30,
  primaryColor: '#e8590c',
  appName: 'ABC Coaching',
};

let failures = 0;
let checks = 0;
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

function eq<T>(label: string, actual: T, expected: T) {
  check(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
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

interface Ctx {
  organization: { id: string; name: string; slug: string; branding: Record<string, string> };
  permissions: string[];
  permissionSource: string;
  roleNames: string[];
  modules: string[];
  configuration: {
    classLevels: { key: string; label: string }[];
    subjects: string[];
    rooms: { name: string; capacity: number }[];
    batches: { name: string }[];
    policy: { exam: Record<string, unknown> };
  };
  writable: boolean;
}

/** Log in against the real API and return the token, exactly as the app does. */
async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as { token?: string; message?: string };
  if (!body.token) throw new Error(`login failed for ${email}: ${body.message ?? res.status}`);
  return body.token;
}

async function fetchContext(token: string): Promise<Ctx> {
  const res = await fetch(`${API_BASE}/me/context`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`me/context ${res.status}`);
  return (await res.json()) as Ctx;
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

  /**
   * Two different things, deliberately kept apart.
   *
   *   pageErrors     `pageerror` events — genuine uncaught JavaScript
   *                  exceptions. Always a bug, and the only thing asserted on.
   *   consoleErrors  the application's own `console.error` logging. `apiFetch`
   *                  logs every non-2xx by design, and several of those
   *                  responses are the POINT of this suite: step [8] injects a
   *                  deliberately fake token so the client sees exactly what
   *                  api-legacy shows, and every real endpoint correctly 401s.
   *                  Counting those as failures would make the suite fail
   *                  precisely when authorization works.
   *
   * Console output is still scanned for the shapes that only a crash produces,
   * so a component blowing up inside an error boundary — which never reaches
   * `pageerror` — is not silently tolerated.
   */
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const CRASH_SHAPES = [
    /is not a function/i,
    /Cannot read propert/i,
    /Minified React error/i,
    /undefined is not an object/i,
    /Maximum update depth exceeded/i,
    /Hydration failed/i,
  ];
  page.on('pageerror', (e: Error) => pageErrors.push(e.message));
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    consoleErrors.push(text);
    if (CRASH_SHAPES.some((shape) => shape.test(text))) pageErrors.push(text);
  });

  /**
   * Seed the token BEFORE any page script runs.
   *
   * `goto` then `setItem` then `reload` loses the race: the app's provider
   * reads localStorage during the first paint of the FIRST load, so the token
   * has to be there before that document exists.
   */
  let activeToken: string | null = null;
  await page.evaluateOnNewDocument(() => {
    const injected = (window as unknown as { __P6_TOKEN__?: string }).__P6_TOKEN__;
    if (injected) localStorage.setItem('accessToken', injected);
  });

  async function useToken(token: string | null) {
    activeToken = token;
    await page.evaluateOnNewDocument((t: string | null) => {
      try {
        if (t) localStorage.setItem('accessToken', t);
        else {
          localStorage.removeItem('accessToken');
          localStorage.removeItem('user');
          localStorage.removeItem('orgHint');
        }
        // A stale cached context from the previous tenant would mask exactly
        // the bug this suite exists to catch.
        for (const key of Object.keys(sessionStorage)) {
          if (key.startsWith('tenantContext:')) sessionStorage.removeItem(key);
        }
      } catch {
        /* ignore */
      }
    }, token);
  }

  async function go(path: string) {
    await page.goto(`${WEB_BASE}${path}`, { waitUntil: 'domcontentloaded' });
  }

  /**
   * Wait until the provider has an AUTHORITATIVE answer.
   *
   * "The navigation has rendered" and "the navigation has been filtered" are
   * different moments. Reading the menu between them shows the unfiltered list
   * and looks exactly like a gate that does not work — which is what the first
   * run of this suite reported, wrongly, for the front-desk role. The provider
   * publishes `data-tenant-state` precisely so this can be waited on rather
   * than slept through.
   */
  async function tenantReady() {
    await page.waitForFunction(
      () => {
        const state = document.documentElement.getAttribute('data-tenant-state');
        return state === 'resolved' || state === 'legacy';
      },
      { timeout: 30000 },
    );
  }

  /**
   * Open the schedule form and read its pickers.
   *
   * The room and batch selectors live inside a modal, so the page's own
   * selects are not enough — the first version of this helper read the filter
   * bar instead and reported zero rooms for both tenants.
   */
  async function openScheduleForm(): Promise<{ rooms: string[]; batches: string[] }> {
    await go('/dashboard/admin/app-management/schedule');
    await tenantReady();
    // `tenantReady` says the CONTEXT has arrived; it says nothing about this
    // page having finished loading its own schedule data and rendering its
    // toolbar. Waiting for the button itself is the condition that actually
    // matters, and waiting for the wrong one is why this read came back empty.
    await page
      .waitForFunction(
        () =>
          Array.from(document.querySelectorAll('button')).some((b) =>
            /^(add class|add schedule)$/i.test((b.textContent || '').trim()),
          ),
        { timeout: 30000 },
      )
      .catch(() => {});
    const opened = await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('button')).find((b) =>
        /^(add class|add schedule)$/i.test((b.textContent || '').trim()),
      );
      if (!button) return false;
      (button as HTMLButtonElement).click();
      return true;
    });
    if (!opened) {
      const seen = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button'))
          .map((b) => (b.textContent || '').trim())
          .filter(Boolean),
      );
      console.log(`      (schedule form button not found; buttons were: ${seen.join(' | ')})`);
      return { rooms: [], batches: [] };
    }
    await page
      .waitForFunction(
        () =>
          Array.from(document.querySelectorAll('select')).some((s) =>
            Array.from(s.options).some((o) => /^Room \d+$|^(Hall|Lab) /.test((o.textContent || '').trim())),
          ),
        { timeout: 20000 },
      )
      .catch(() => {});
    return page.evaluate(() => {
      const read = (match: RegExp) => {
        for (const s of Array.from(document.querySelectorAll('select'))) {
          const opts = Array.from(s.options).map((o) => (o.textContent || '').trim());
          if (opts.some((o) => match.test(o))) return opts;
        }
        return [] as string[];
      };
      return {
        rooms: read(/^Room \d+$|^(Hall|Lab) /),
        // Every batch selector on the form, flattened — the leak this checks
        // for showed up as extra options in one of several.
        batches: Array.from(document.querySelectorAll('select'))
          .flatMap((s) => Array.from(s.options).map((o) => (o.textContent || '').trim()))
          .filter(Boolean),
      };
    });
  }

  /** Wait until the provider has painted branding, then read the applied tokens. */
  async function brandState(): Promise<{
    primary: string;
    accent: string;
    onPrimary: string;
    brand: string | null;
    title: string;
    orgName: string | null;
  }> {
    await page
      .waitForFunction(
        () => document.documentElement.getAttribute('data-brand') !== null,
        { timeout: 20000 },
      )
      .catch(() => {});
    return page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        primary: cs.getPropertyValue('--brand-primary').trim(),
        accent: cs.getPropertyValue('--brand-accent').trim(),
        onPrimary: cs.getPropertyValue('--brand-on-primary').trim(),
        brand: document.documentElement.getAttribute('data-brand'),
        title: document.title,
        orgName: document.documentElement.getAttribute('data-org-name'),
      };
    });
  }

  async function navLabels(): Promise<string[]> {
    return page.evaluate(() =>
      Array.from(document.querySelectorAll('nav a, header a'))
        .map((a) => (a.textContent || '').trim())
        .filter(Boolean),
    );
  }

  /**
   * Wait for the page's own content, not just the tenant context.
   *
   * `<Protected>` renders "Authenticating…" while it validates the token, so a
   * read taken between `tenantReady()` and that resolving sees an empty main
   * element. Two assertions failed on exactly this and looked like gating bugs.
   */
  async function contentReady() {
    await page
      .waitForFunction(
        () => {
          const text = document.body.innerText || '';
          if (/Authenticating/i.test(text)) return false;
          return document.querySelectorAll('main a').length > 0 || /not part of your plan|do not have access/i.test(text);
        },
        { timeout: 25000 },
      )
      .catch(() => {});
  }

  /**
   * Screenshot after the page has settled.
   *
   * Without the settle these captured the sidebar mid-animation over an
   * "Authenticating…" placeholder — technically the right page, useless as
   * evidence. The assertions never depended on the timing; the artefacts did.
   */
  async function shot(name: string) {
    await contentReady();
    // One frame past the last framer-motion transition on these screens.
    await new Promise((resolve) => setTimeout(resolve, 900));
    await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
  }

  try {
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[0] the build under test is a single artefact');
    // ══════════════════════════════════════════════════════════════════════
    await useToken(null);
    await go('/');
    const buildId = await page.evaluate(() => {
      const data = document.getElementById('__NEXT_DATA__');
      if (data) {
        try {
          return JSON.parse(data.textContent || '{}').buildId ?? null;
        } catch {
          return null;
        }
      }
      // App Router: the build is identified by its chunk paths instead.
      const script = Array.from(document.querySelectorAll('script[src]')).find((s) =>
        (s as HTMLScriptElement).src.includes('/_next/static/'),
      ) as HTMLScriptElement | undefined;
      return script ? script.src.split('/_next/static/')[1].split('/')[0] : null;
    });
    check('a build identifier is readable, so a rebuild between tenants would show', Boolean(buildId), String(buildId));
    const buildAtStart = buildId;

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[1] pre-authentication: the landing page renders unbranded');
    // ══════════════════════════════════════════════════════════════════════
    {
      const brand = await brandState();
      eq('no organization resolves on localhost, so the default palette applies', brand.brand, 'default');
      eq('the default primary is the palette that shipped', brand.primary, '#A3B18A');
      const landing = await page
        .$eval('[data-testid="landing-brand"]', (el: Element) => (el.textContent || '').trim())
        .catch(() => '');
      check(
        'the landing headline falls back to the original name',
        landing.includes('Abhigyan Gurukull'),
        landing,
      );
      await shot('01-preauth-default');
    }

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[2] ORG 001 — Abhigyan admin');
    // ══════════════════════════════════════════════════════════════════════
    const t001 = await login(ORG_001.admin.email, ORG_001.admin.password);
    const c001 = await fetchContext(t001);

    eq('organization resolved from the token claim alone', c001.organization.name, ORG_001.label);
    eq('every module — an unsubscribed organization is not a restricted one', c001.modules.length, ORG_001.moduleCount);
    eq('permissions come from an assigned role, not the legacy bridge', c001.permissionSource, 'roles');
    eq('class levels are the institute\'s own', c001.configuration.classLevels.map((c) => c.key), ORG_001.classKeys);
    eq('subject count', c001.configuration.subjects.length, ORG_001.subjectCount);
    eq('room count — eleven numbered rooms', c001.configuration.rooms.length, 11);
    eq('marking scheme is the platform default, which IS Abhigyan\'s', c001.configuration.policy.exam.markingScheme, ORG_001.marking);
    check('writable', c001.writable === true);

    await useToken(t001);
    await go('/dashboard/admin/app-management');
    await tenantReady();

    {
      const brand = await brandState();
      eq('an organization with no branding keeps the default palette', brand.brand, 'default');
      eq('and the default primary, unchanged', brand.primary, '#A3B18A');
      eq('the tab title carries the institute name', brand.title, ORG_001.label);
      await shot('02-org001-app-management');
    }

    const nav001 = await navLabels();
    for (const label of ['Users', 'Courses', 'Batches', 'Attendance', 'Schedule', 'Leaves', 'EOD Reports', 'Firebase Sync']) {
      check(`org 001 sidebar keeps "${label}"`, nav001.some((n) => n.includes(label)), nav001.join(' | '));
    }

    // The room picker — eleven options, the institute's own names.
    const form001 = await openScheduleForm();
    const rooms001 = form001.rooms;
    eq('the room picker offers exactly the eleven configured rooms', rooms001.length, 11);
    for (const room of ORG_001.rooms) {
      check(`room picker contains "${room}"`, rooms001.includes(room), rooms001.join(', '));
    }
    check(
      'no ABC room leaks into Abhigyan',
      !rooms001.some((r) => ORG_002.rooms.includes(r)),
      rooms001.join(', '),
    );
    // ── The leak this suite actually found ─────────────────────────────────
    // `GET /schedule/batches` did `Batch.find({})`. The tenancy plugin filters
    // reads only under `enforce`, and production runs under `warn`, so every
    // organization's batches reached every organization's picker: Abhigyan's
    // schedule form was offering ABC Coaching's "NEET" and "JEE Advanced".
    for (const foreign of ['NEET', 'JEE Main', 'JEE Advanced', 'Foundation']) {
      check(
        `no ABC batch "${foreign}" appears in Abhigyan's schedule form`,
        !form001.batches.includes(foreign),
        form001.batches.join(', '),
      );
    }
    check(
      "Abhigyan's own batches are still offered",
      form001.batches.includes('Aarambh') && form001.batches.includes('Sankalp'),
      form001.batches.join(', '),
    );
    check(
      "no ABC staff member appears in Abhigyan's teacher picker",
      !form001.batches.some((o) => /ABC Coaching/i.test(o)),
      form001.batches.filter((o) => /Teacher/i.test(o)).join(', '),
    );
    await shot('03-org001-rooms');

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[3] ORG 002 — ABC admin, SAME BUILD, only the login differs');
    // ══════════════════════════════════════════════════════════════════════
    const t002 = await login(ORG_002.admin.email, ORG_002.admin.password);
    const c002 = await fetchContext(t002);

    eq('a different organization for a different credential', c002.organization.name, ORG_002.label);
    eq('a restricted plan yields fewer modules', c002.modules.length, ORG_002.moduleCount);
    check('the AI module is withheld', !c002.modules.includes('ai'));
    check('question import is withheld', !c002.modules.includes('questionImport'));
    check('exams are NOT withheld — the restriction is specific', c002.modules.includes('exams'));
    eq('class levels include a non-numeric one', c002.configuration.classLevels.map((c) => c.key), ORG_002.classKeys);
    eq('four subjects, not fifteen', c002.configuration.subjects.length, ORG_002.subjectCount);
    eq('halls and labs, not numbered rooms', c002.configuration.rooms.map((r) => r.name), ORG_002.rooms);
    eq('competitive marking', c002.configuration.policy.exam.markingScheme, ORG_002.marking);
    eq('its own submit lock', c002.configuration.policy.exam.submitLockPercent, 75);
    eq('its own violation tolerance', c002.configuration.policy.exam.violationThreshold, 3);

    check(
      'the two organizations are genuinely different documents',
      c001.organization.id !== c002.organization.id,
    );

    await useToken(t002);
    await go('/dashboard/admin/app-management');
    await tenantReady();

    {
      const brand = await brandState();
      eq('branding applies', brand.brand, 'tenant');
      eq('the configured primary is painted', brand.primary, ORG_002.primaryColor);
      eq('the configured accent is painted', brand.accent, '#1b3a5c');
      // #E8590C against black is 5.9:1 and against white 3.6:1, so black is the
      // correct choice by contrast ratio. This assertion originally expected
      // white — the "orange is dark, use white" instinct — and the code was
      // right where the expectation was wrong.
      eq('the foreground on the primary is the higher-contrast one', brand.onPrimary, '#111111');
      eq('the tab title carries the configured app name', brand.title, ORG_002.appName);
      eq('and the organization name attribute agrees', brand.orgName, ORG_002.appName);
      await shot('04-org002-app-management');
    }

    const nav002 = await navLabels();
    // The top navbar returns null under /dashboard/admin/app-management — that
    // section has its own layout — so the institute's identity has to come from
    // the sidebar header, which is the only chrome an administrator working in
    // here ever sees.
    const sidebarBrand = await page
      .$eval('[data-testid="brand-name"]', (el: Element) => (el.textContent || '').trim())
      .catch(() => '');
    eq('the sidebar header names the organization', sidebarBrand, ORG_002.appName);
    check(
      'Firebase Sync is GONE — the integrations module is not in the plan',
      !nav002.some((n) => n.includes('Firebase Sync')),
      nav002.join(' | '),
    );
    // The dashboard's Quick Action tiles link to the same routes as the
    // sidebar. Gating one and not the other leaves a working-looking card on
    // the dashboard that lands on a "not in your plan" screen.
    await contentReady();
    const tiles002 = await page.evaluate(() =>
      Array.from(document.querySelectorAll('main a, main h3 ~ div a'))
        .map((a) => (a.textContent || '').trim())
        .filter(Boolean),
    );
    check(
      'and no Quick Action tile offers it either',
      !tiles002.some((t) => /Firebase Sync/i.test(t)),
      tiles002.join(' | '),
    );
    check(
      'tiles for modules that ARE in the plan survive',
      tiles002.some((t) => /Manage Courses/i.test(t)),
      tiles002.join(' | '),
    );
    for (const label of ['Users', 'Courses', 'Attendance', 'Schedule']) {
      check(`org 002 keeps "${label}" — those modules ARE in the plan`, nav002.some((n) => n.includes(label)), nav002.join(' | '));
    }

    // The picker that would betray a client ignoring the context.
    const form002 = await openScheduleForm();
    const rooms002 = form002.rooms;
    eq('the room picker now offers four', rooms002.length, 4);
    eq('and they are ABC\'s own', rooms002, ORG_002.rooms);
    check(
      'not one Abhigyan room survived the tenant switch',
      !rooms002.some((r) => /^Room \d+$/.test(r)),
      rooms002.join(', '),
    );
    for (const foreign of ['Aarambh', 'Sankalp', 'Advanced/Basic']) {
      check(
        `no Abhigyan batch "${foreign}" appears in ABC's schedule form`,
        !form002.batches.includes(foreign),
        form002.batches.join(', '),
      );
    }
    // Not every batch, only the ones valid for the class the form has selected —
    // "Foundation" is a class 9/10 batch and is correctly absent while class 11
    // is chosen. Asserting all four would have been asserting a bug.
    check(
      "ABC's own batches are offered",
      ['JEE Main', 'NEET'].every((b) => form002.batches.includes(b)),
      form002.batches.join(', '),
    );
    // ── The second leak this suite found ───────────────────────────────────
    // `GET /schedule/teachers` did `User.find({ role: 'teacher' })`, so ABC's
    // schedule form offered "Abhigyan Gurukull Teacher" as an assignable
    // teacher. Staff names across tenants are not a cosmetic leak.
    check(
      "no Abhigyan staff member appears in ABC's teacher picker",
      !form002.batches.some((o) => /Abhigyan/i.test(o)),
      form002.batches.filter((o) => /Teacher/i.test(o)).join(', '),
    );
    check(
      "ABC's own teacher IS offered",
      form002.batches.some((o) => /ABC Coaching Institute Teacher/i.test(o)),
      form002.batches.filter((o) => /Teacher/i.test(o)).join(', '),
    );
    // The configured label, not a synthesised one: "Class dropper" is what
    // `Class ${key}` produces for a non-numeric level, and it is why labels are
    // configurable in the first place.
    check(
      'the non-numeric level renders its configured label, not "Class dropper"',
      form002.batches.includes('Dropper') && !form002.batches.includes('Class dropper'),
      form002.batches.filter((o) => /dropper/i.test(o)).join(', '),
    );
    await shot('05-org002-rooms');

    // Class pickers — including the value the old normalizer dropped.
    await go('/dashboard/admin/app-management/courses');
    await page.waitForSelector('select', { timeout: 25000 }).catch(() => {});
    const classOpts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('select'))
        .flatMap((s) => Array.from(s.options).map((o) => (o.textContent || '').trim()))
        .filter(Boolean),
    );
    check(
      'the class picker offers "Dropper" — the value digit-extraction used to lose',
      classOpts.some((o) => /dropper/i.test(o)),
      classOpts.join(', '),
    );
    check(
      'and no longer offers Class 7, which ABC does not teach',
      !classOpts.includes('Class 7'),
      classOpts.join(', '),
    );
    await shot('06-org002-classes');

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[4] a disabled MODULE is explained as a plan boundary');
    // ══════════════════════════════════════════════════════════════════════
    await go('/dashboard/admin/app-management/sync');
    await page.waitForSelector('[data-testid="module-disabled"], [data-testid="not-authorized"]', {
      timeout: 25000,
    }).catch(() => {});
    const denial = await page.evaluate(() => ({
      module: Boolean(document.querySelector('[data-testid="module-disabled"]')),
      role: Boolean(document.querySelector('[data-testid="not-authorized"]')),
      text: (document.querySelector('[data-testid="module-disabled"]')?.textContent || '').trim(),
    }));
    check('the route explains rather than rendering blank', denial.module || denial.role);
    check('and it names the PLAN, not the role — the admin holds every permission', denial.module, JSON.stringify(denial));
    check(
      'the wording tells the reader a role change will not help',
      /plan/i.test(denial.text) && /role/i.test(denial.text),
      denial.text.slice(0, 160),
    );
    await shot('07-org002-module-disabled');

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[5] a missing PERMISSION is explained as a role boundary');
    // ══════════════════════════════════════════════════════════════════════
    const tDesk = await login(ORG_002.frontDesk.email, ORG_002.frontDesk.password);
    const cDesk = await fetchContext(tDesk);
    eq('the narrow role really is narrow', cDesk.permissions.length, 7);
    eq('and it is a real role, named', cDesk.roleNames, ['Front Desk']);
    eq('in the SAME organization, on the same plan', cDesk.modules.length, ORG_002.moduleCount);

    await useToken(tDesk);
    await go('/dashboard/admin/app-management');
    await tenantReady();
    const navDesk = await navLabels();
    check(
      'front desk keeps Attendance — it holds attendance.read',
      navDesk.some((n) => n.includes('Attendance')),
      navDesk.join(' | '),
    );
    check(
      'front desk keeps Users — it holds students.read',
      navDesk.some((n) => n.includes('Users')),
      navDesk.join(' | '),
    );
    check(
      'front desk loses Courses — no courses.read, though the module IS in the plan',
      !navDesk.some((n) => n.includes('Courses')),
      navDesk.join(' | '),
    );
    check(
      'front desk loses EOD Reports — no reports.read',
      !navDesk.some((n) => n.includes('EOD')),
      navDesk.join(' | '),
    );
    await shot('08-org002-frontdesk-nav');

    await go('/dashboard/admin/app-management/courses');
    await page.waitForSelector('[data-testid="module-disabled"], [data-testid="not-authorized"]', {
      timeout: 25000,
    }).catch(() => {});
    const deskDenial = await page.evaluate(() => ({
      module: Boolean(document.querySelector('[data-testid="module-disabled"]')),
      role: Boolean(document.querySelector('[data-testid="not-authorized"]')),
      text: (document.querySelector('[data-testid="not-authorized"]')?.textContent || '').trim(),
    }));
    check('the route explains', deskDenial.module || deskDenial.role);
    check(
      'and it names the ROLE, not the plan — the courses module IS included',
      deskDenial.role && !deskDenial.module,
      JSON.stringify(deskDenial),
    );
    check('the message names the role the user actually holds', /Front Desk/.test(deskDenial.text), deskDenial.text.slice(0, 160));
    await shot('09-org002-frontdesk-denied');

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[6] switching back proves nothing leaked');
    // ══════════════════════════════════════════════════════════════════════
    await useToken(t001);
    await go('/dashboard/admin/app-management');
    await tenantReady();
    {
      const brand = await brandState();
      eq('the orange is gone', brand.brand, 'default');
      eq('the original palette is back', brand.primary, '#A3B18A');
      eq('and the title is Abhigyan\'s again', brand.title, ORG_001.label);
      const navBack = await navLabels();
      check(
        'Firebase Sync returns — Abhigyan has the integrations module',
        navBack.some((n) => n.includes('Firebase Sync')),
        navBack.join(' | '),
      );
      await contentReady();
      const tilesBack = await page.evaluate(() =>
        Array.from(document.querySelectorAll('main a'))
          .map((a) => (a.textContent || '').trim())
          .filter(Boolean),
      );
      check(
        'and its tile returns with it',
        tilesBack.some((t) => /Firebase Sync/i.test(t)),
        tilesBack.join(' | '),
      );
      // The head count on the dashboard was reporting every user on the
      // platform to every institute — nine, for two organizations of four.
      const totalUsers = await page.evaluate(() => {
        const label = Array.from(document.querySelectorAll('*')).find(
          (el) => el.children.length === 0 && /^Total users$/.test((el.textContent || '').trim()),
        );
        const card = label?.closest('a') ?? label?.parentElement;
        const digits = (card?.textContent || '').match(/(\d[\d,]*)/);
        return digits ? Number(digits[1].replace(/,/g, '')) : null;
      });
      check(
        "the user count is this organization's own, not the platform total",
        totalUsers !== null && totalUsers <= 6,
        `Total users showed ${totalUsers} — the fixture gives each organization 4`,
      );
      check(
        'ABC\'s name appears nowhere',
        !navBack.some((n) => n.includes('ABC')),
        navBack.join(' | '),
      );
    }
    await shot('10-org001-restored');

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[7] logging out clears the tenant, not just the token');
    // ══════════════════════════════════════════════════════════════════════
    await useToken(t002);
    await go('/dashboard/admin/app-management');
    await tenantReady();
    await page.evaluate(() => {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('user');
    });
    await useToken(null);
    await go('/');
    {
      const brand = await brandState();
      eq('no cached tenant palette survives a logout', brand.primary, '#A3B18A');
      const leftovers = await page.evaluate(() =>
        Object.keys(sessionStorage).filter((k) => k.startsWith('tenantContext:')),
      );
      eq('and no cached context document survives either', leftovers, []);
    }
    await shot('11-after-logout');

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[8] the legacy deployment is unchanged — the regression that matters most');
    // ══════════════════════════════════════════════════════════════════════
    // Exactly what api-legacy answers: no organization, no modules, no
    // permissions. Every gate must read UNKNOWN and therefore permit.
    await useToken(null);
    await page.evaluateOnNewDocument(() => {
      const original = window.fetch;
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
        if (url.includes('/me/context')) {
          return new Response(
            JSON.stringify({
              organization: null,
              user: { id: 'x', role: 'admin', name: 'Legacy Admin' },
              permissions: [],
              modules: [],
              limits: {},
              usage: {},
              configuration: {},
              version: 0,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('/org/branding')) {
          return new Response(JSON.stringify({ organization: null }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return original(input as RequestInfo, init);
      };
      localStorage.setItem('accessToken', 'legacy-shaped-token-value-long-enough');
    });
    await go('/dashboard/admin/app-management');
    await tenantReady();
    const navLegacy = await navLabels();
    for (const label of ['Users', 'Registrations', 'Courses', 'Batches', 'Resources', 'Attendance', 'Schedule', 'Leaves', 'Holidays', 'EOD Reports', 'Firebase Sync']) {
      check(
        `api-legacy keeps "${label}" — an empty context must not blank the app`,
        navLegacy.some((n) => n.includes(label)),
        navLegacy.join(' | '),
      );
    }
    const legacyDenial = await page.evaluate(() =>
      Boolean(document.querySelector('[data-testid="module-disabled"], [data-testid="not-authorized"]')),
    );
    check('and no route is gated shut', !legacyDenial);
    {
      const brand = await brandState();
      eq('the palette is the one that shipped', brand.primary, '#A3B18A');
    }
    await shot('12-api-legacy-unchanged');

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[9] it really was one build throughout');
    // ══════════════════════════════════════════════════════════════════════
    await useToken(null);
    await go('/');
    const buildAtEnd = await page.evaluate(() => {
      const script = Array.from(document.querySelectorAll('script[src]')).find((s) =>
        (s as HTMLScriptElement).src.includes('/_next/static/'),
      ) as HTMLScriptElement | undefined;
      return script ? script.src.split('/_next/static/')[1].split('/')[0] : null;
    });
    eq('the build identifier is the same as before the first tenant', buildAtEnd, buildAtStart);

    eq('no uncaught exceptions anywhere in the run', pageErrors, []);
    // Informational: the expected shape is HTTP status logging from the
    // deliberately-unauthenticated steps, and nothing else.
    const unexpected = consoleErrors.filter(
      (text) =>
        !/Failed to load resource/i.test(text) &&
        !/^\[apiFetch\]/.test(text) &&
        !/status: 40[13]/i.test(text),
    );
    eq('no unexplained console errors', unexpected, []);
  } finally {
    await browser.close();
  }

  console.log('');
  if (failures) {
    console.error(`CLIENT-PLATFORM-WEB E2E FAILED — ${failures} of ${checks}:`);
    for (const f of failed) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`All ${checks} two-tenant checks passed. Screenshots in ${SHOTS}`);
  process.exit(0);
}

main().catch((error) => {
  console.error('client-platform-web.e2e.test.ts crashed:', error);
  process.exit(1);
});
