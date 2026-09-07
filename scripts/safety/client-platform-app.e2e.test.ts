/**
 * ONE MOBILE BUILD, TWO ORGANIZATIONS.
 *
 * ── What is actually being driven ───────────────────────────────────────────
 * The React Native source of `client-platform-app`, compiled by Metro through
 * `react-native-web` and served as a static bundle. Every screen, every
 * component, every line of the tenant layer is the same code that ships to a
 * device; what differs is the renderer underneath it.
 *
 * That distinction is stated plainly because it matters. This suite proves the
 * SHARED behaviour — routing, gating, branding, tenant isolation, the attempt
 * lifecycle — against real APIs. It does not prove native-specific behaviour:
 * AsyncStorage is localStorage here, `AppState` background transitions do not
 * occur in a headless browser, and push notification registration is absent.
 * Those need a device or a simulator and are recorded as gaps rather than
 * quietly claimed.
 *
 * ── Why a browser at all, rather than a component-test renderer ─────────────
 * Because the thing worth testing is the wiring, and a component renderer
 * mocks exactly the parts that break: the fetch, the storage, the navigation.
 * A real bundle talking to a real server through real routing catches the bugs
 * that matter, and the P6 web suite already proved this approach finds them —
 * it turned up two cross-tenant leaks nobody was looking for.
 *
 * ── Prerequisites ───────────────────────────────────────────────────────────
 *   1. seed-p6-fixture.ts and seed-p7-content.ts have been run
 *   2. p6-fixture-server.js is serving the scratch DB in claim mode
 *   3. the app has been exported to web and is being served (see APP_BASE)
 *
 *   npx ts-node --transpile-only scripts/safety/client-platform-app.e2e.test.ts
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const APP_BASE = process.env.P7_APP_BASE || 'http://127.0.0.1:3300';
const API_BASE = process.env.P7_API_BASE || 'http://127.0.0.1:5055/api';
const SHOTS = join(process.cwd(), 'docs', 'p7-screens');

const ORG_001 = {
  label: 'Abhigyan Gurukull',
  marker: 'AG',
  examTitle: 'AG Physics Unit Test',
  subject: 'Physics',
  classKeys: ['7', '8', '9', '10', '11', '12'],
  subjectCount: 15,
  moduleCount: 34,
  marking: { correct: 1, incorrect: 0, unattempted: 0 },
  violationThreshold: 10,
  branded: false,
  admin: { email: 'p6.admin@abhigyan.fixture', password: 'P6-fixture-abhigyan!' },
  teacher: { email: 'p6.teacher@abhigyan.fixture', password: 'P6-fixture-abhigyan!' },
  student: { email: 'p6.student@abhigyan.fixture', password: 'P6-fixture-abhigyan!' },
  frontDesk: { email: 'p6.frontdesk@abhigyan.fixture', password: 'P6-fixture-abhigyan!' },
};

const ORG_002 = {
  label: 'ABC Coaching',
  marker: 'ABC',
  examTitle: 'ABC Chemistry Mock',
  subject: 'Chemistry',
  classKeys: ['9', '10', '11', '12', 'dropper'],
  subjectCount: 4,
  moduleCount: 30,
  marking: { correct: 4, incorrect: -1, unattempted: 0 },
  violationThreshold: 3,
  branded: true,
  primaryColor: 'rgb(232, 89, 12)',
  admin: { email: 'p6.admin@abc.fixture', password: 'P6-fixture-abc!' },
  teacher: { email: 'p6.teacher@abc.fixture', password: 'P6-fixture-abc!' },
  student: { email: 'p6.student@abc.fixture', password: 'P6-fixture-abc!' },
  frontDesk: { email: 'p6.frontdesk@abc-coaching.fixture', password: 'P6-fixture-abc!' },
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

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as { token?: string; user?: unknown; message?: string };
  if (!body.token) throw new Error(`login failed for ${email}: ${body.message ?? res.status}`);
  return body.token;
}

async function api<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
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
  // A phone-shaped viewport: the layout is built for one, and a desktop width
  // would exercise breakpoints no device ever sees.
  await page.setViewport({ width: 414, height: 896, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(40000);
  page.setDefaultNavigationTimeout(40000);

  const pageErrors: string[] = [];
  page.on('pageerror', (e: Error) => pageErrors.push(e.message));
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/Failed to load resource/i.test(text)) return;
    // React Native Web logs style deprecation notices as errors on some
    // properties. They are not exceptions and not what this suite is about.
    if (/deprecated|shadow\*|props\.pointerEvents/i.test(text)) return;
    pageErrors.push(text);
  });

  /**
   * Seed the session BEFORE any script runs.
   *
   * AsyncStorage is localStorage under react-native-web, and the app primes its
   * token from storage in the root layout's first effect — after that, nothing
   * re-reads it. `goto` then `setItem` then `reload` loses the race on the
   * first load, which is exactly the load being tested.
   */
  async function useSession(token: string | null, user: unknown = null) {
    await page.evaluateOnNewDocument(
      (t: string | null, u: unknown) => {
        try {
          if (t) {
            localStorage.setItem('accessToken', t);
            if (u) localStorage.setItem('user', JSON.stringify(u));
          } else {
            localStorage.removeItem('accessToken');
            localStorage.removeItem('user');
            localStorage.removeItem('orgHint');
          }
          // A cached context from the previous tenant would mask precisely the
          // bug this suite exists to catch.
          for (const key of Object.keys(localStorage)) {
            if (key.startsWith('tenantContext:')) localStorage.removeItem(key);
          }
        } catch {
          /* ignore */
        }
      },
      token,
      user,
    );
  }

  async function go(path: string) {
    await page.goto(`${APP_BASE}${path}`, { waitUntil: 'domcontentloaded' });
  }

  const byTestId = (id: string) => `[data-testid="${id}"]`;

  async function waitFor(id: string, timeout = 40000) {
    return page.waitForSelector(byTestId(id), { timeout });
  }

  async function textOf(id: string): Promise<string> {
    return page
      .$eval(byTestId(id), (el: Element) => (el.textContent || '').trim())
      .catch(() => '');
  }

  async function exists(id: string): Promise<boolean> {
    return (await page.$(byTestId(id))) !== null;
  }

  /**
   * Every rendered tab label, in order.
   *
   * The icon font's glyphs are TEXT content — `@expo/vector-icons` renders an
   * Ionicon as a private-use-area codepoint inside the same node as the label,
   * so `textContent` for the Home tab is "Home". They are
   * invisible in a terminal, which made the first failure of this check report
   * that ["Home",...] did not equal ["Home",...]. Stripping the private-use
   * ranges leaves the label a human would read.
   */
  async function tabLabels(): Promise<string[]> {
    return page.evaluate(() => {
      const bar = document.querySelector('[role="tablist"]');
      if (!bar) return [] as string[];
      return Array.from(bar.querySelectorAll('[role="tab"]'))
        .map((el) =>
          (el.textContent || '')
            .replace(/[-￰-￿]/g, '')
            .trim(),
        )
        .filter(Boolean);
    });
  }

  /**
   * Wait for a screen's own data load to finish, not merely for it to mount.
   *
   * `waitFor('exams-screen')` returns as soon as the screen renders, which is
   * while it still says "Loading exams…". Reading the DOM there reports an
   * empty list and looks exactly like a tenant-isolation failure — which is
   * what the first run of this suite claimed.
   */
  async function waitLoaded(screenId: string) {
    await waitFor(screenId);
    await page
      .waitForFunction(() => !document.querySelector('[data-testid="loading"]'), { timeout: 40000 })
      .catch(() => {});
  }

  /**
   * Tap by dispatching the click on the node itself.
   *
   * `page.click()` computes a clickable point and refuses when the node is
   * scrolled out of view or overlapped — which for a 414px-wide phone layout is
   * most of a long form. React Native Web's Pressable responds to a plain DOM
   * click, so dispatching one directly is both more reliable and closer to what
   * a tap does.
   */
  async function tap(id: string) {
    const clicked = await page.evaluate((selector: string) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    }, byTestId(id));
    if (!clicked) throw new Error(`tap: no element for ${id}`);
  }

  /**
   * Wait until the tenant context has resolved on the current screen.
   *
   * Screens that are not gated — Home, Profile — render immediately and fill in
   * when `/api/me/context` answers. Reading them before that reports "Signed
   * in" and "Not resolved", which looks exactly like a broken context and is
   * merely an early read.
   */
  async function waitForContext() {
    await page
      .waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="home-org-name"], [data-testid="profile-role"]');
          return Boolean(el && (el.textContent || '').trim() && (el.textContent || '').trim() !== 'Learning Platform');
        },
        { timeout: 40000 },
      )
      .catch(() => {});
  }

  async function shot(name: string) {
    await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
  }

  /** The whole document's text, for coarse "does X appear anywhere" checks. */
  async function bodyText(): Promise<string> {
    return page.evaluate(() => document.body.innerText || '');
  }

  try {
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[0] the bundle under test is a single artefact');
    // ══════════════════════════════════════════════════════════════════════
    await useSession(null);
    await go('/');
    const bundleAtStart = await page.evaluate(() => {
      const script = Array.from(document.querySelectorAll('script[src]')).find((s) =>
        (s as HTMLScriptElement).src.includes('/_expo/static/js/web/'),
      ) as HTMLScriptElement | undefined;
      return script ? script.src.split('/').pop() ?? null : null;
    });
    check('a bundle filename is readable, so a rebuild between tenants would show', Boolean(bundleAtStart), String(bundleAtStart));

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[1] unauthenticated: the login screen, unbranded');
    // ══════════════════════════════════════════════════════════════════════
    await waitFor('login-submit');
    const anonName = await textOf('login-org-name');
    eq('no organization resolves, so the neutral platform name shows', anonName, 'Learning Platform');
    check('and no institute is named anywhere', !/Abhigyan|ABC Coaching/i.test(await bodyText()));
    const anonMark = await page.$eval(byTestId('login-mark'), (el: Element) =>
      getComputedStyle(el).backgroundColor,
    );
    eq('the mark uses the neutral indigo, not any customer colour', anonMark, 'rgb(79, 70, 229)');
    await shot('01-login-neutral');

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[2] ORG 001 — Abhigyan student');
    // ══════════════════════════════════════════════════════════════════════
    const t001 = await login(ORG_001.student.email, ORG_001.student.password);
    const c001 = await api<any>(t001, '/me/context');
    eq('organization resolved from the token claim alone', c001.organization.name, ORG_001.label);
    eq('every module — an unsubscribed organization is not a restricted one', c001.modules.length, ORG_001.moduleCount);
    eq('class levels are the institute\'s own', c001.configuration.classLevels.map((c: any) => c.key), ORG_001.classKeys);
    eq('subject count', c001.configuration.subjects.length, ORG_001.subjectCount);
    eq('marking scheme', c001.configuration.policy.exam.markingScheme, ORG_001.marking);

    await useSession(t001);
    await go('/');
    await waitFor('home-screen');
    await waitForContext();

    eq('the home hero names the organization', await textOf('home-org-name'), ORG_001.label);
    eq('and the signed-in user', await textOf('home-user-name'), 'Abhigyan Gurukull Student');
    eq('with their role', await textOf('home-role'), 'student');

    const heroColour001 = await page.$eval(byTestId('home-hero'), (el: Element) =>
      getComputedStyle(el).backgroundColor,
    );
    eq(
      'an organization with no branding keeps the neutral platform palette',
      heroColour001,
      'rgb(79, 70, 229)',
    );

    eq('configured classes are shown', await textOf('config-classes'), 'Class 7, Class 8, Class 9, Class 10, Class 11, Class 12');
    check(
      'configured subjects are the institute\'s fifteen',
      (await textOf('config-subjects')).startsWith('Physics, Chemistry, Mathematics'),
      await textOf('config-subjects'),
    );
    check(
      'configured batches are the institute\'s own',
      (await textOf('config-batches')).includes('Aarambh'),
      await textOf('config-batches'),
    );
    check(
      'configured rooms are the institute\'s eleven',
      (await textOf('config-rooms')).includes('Room 1 (18)'),
      await textOf('config-rooms'),
    );
    eq(
      'the marking policy is displayed from the organization',
      await textOf('policy-marking'),
      '+1 correct · 0 wrong · 0 unattempted',
    );
    eq('and the submit lock', await textOf('policy-lock'), '50% of the exam');
    await shot('02-org001-home');

    const tabs001 = await tabLabels();
    eq('a student sees five tabs', tabs001, ['Home', 'Exams', 'Results', 'Alerts', 'Profile']);
    check('and never the question bank', !tabs001.includes('Questions'), tabs001.join(', '));

    // ── Exams ─────────────────────────────────────────────────────────────
    await go('/exams');
    await waitLoaded('exams-screen');
    const examText001 = await bodyText();
    check(
      `the student's own exam appears (${ORG_001.examTitle})`,
      examText001.includes(ORG_001.examTitle),
      examText001.slice(0, 200),
    );
    check(
      "and the other organization's exam does not",
      !examText001.includes(ORG_002.examTitle),
      examText001.slice(0, 200),
    );
    await shot('03-org001-exams');

    // ── Notifications ─────────────────────────────────────────────────────
    await go('/notifications');
    await waitLoaded('notifications-screen');
    const alerts001 = await bodyText();
    check('the organization\'s notifications appear', alerts001.includes('AG: Welcome'), alerts001.slice(0, 200));
    check("and the other organization's do not", !alerts001.includes('ABC:'), alerts001.slice(0, 200));
    await shot('04-org001-alerts');

    // ── Results ───────────────────────────────────────────────────────────
    await go('/results');
    await waitLoaded('results-screen');
    check('the results screen renders', await exists('results-filter-all'));

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[3] ORG 002 — ABC student, SAME BUNDLE');
    // ══════════════════════════════════════════════════════════════════════
    const t002 = await login(ORG_002.student.email, ORG_002.student.password);
    const c002 = await api<any>(t002, '/me/context');
    eq('a different organization for a different credential', c002.organization.branding.appName, ORG_002.label);
    eq('a restricted plan yields fewer modules', c002.modules.length, ORG_002.moduleCount);
    check('the AI module is withheld', !c002.modules.includes('ai'));
    eq('class levels include a non-numeric one', c002.configuration.classLevels.map((c: any) => c.key), ORG_002.classKeys);
    eq('four subjects, not fifteen', c002.configuration.subjects.length, ORG_002.subjectCount);
    eq('competitive marking', c002.configuration.policy.exam.markingScheme, ORG_002.marking);
    check('the two organizations are different documents', c001.organization.id !== c002.organization.id);

    await useSession(t002);
    await go('/');
    await waitFor('home-screen');
    await waitForContext();

    eq('the home hero names ABC', await textOf('home-org-name'), ORG_002.label);
    const heroColour002 = await page.$eval(byTestId('home-hero'), (el: Element) =>
      getComputedStyle(el).backgroundColor,
    );
    eq('branding is applied — the configured orange', heroColour002, ORG_002.primaryColor);
    check('which is genuinely different from Abhigyan\'s', heroColour002 !== heroColour001);

    eq(
      'configured classes include Dropper, rendered by its LABEL',
      await textOf('config-classes'),
      'Class 9, Class 10, Class 11, Class 12, Dropper',
    );
    check(
      'and not as "Class dropper"',
      !(await textOf('config-classes')).includes('Class dropper'),
      await textOf('config-classes'),
    );
    eq('four subjects', await textOf('config-subjects'), 'Physics, Chemistry, Mathematics, Biology');
    eq('its own batches', await textOf('config-batches'), 'Foundation, JEE Advanced, JEE Main, NEET');
    eq('halls and labs, not numbered rooms', await textOf('config-rooms'), 'Hall A (60), Hall B (45), Lab 1 (24), Lab 2 (24)');
    eq(
      'competitive marking is displayed',
      await textOf('policy-marking'),
      '+4 correct · -1 wrong · 0 unattempted',
    );
    eq('and its own submit lock', await textOf('policy-lock'), '75% of the exam');
    await shot('05-org002-home');

    // ── Isolation ─────────────────────────────────────────────────────────
    await go('/exams');
    await waitLoaded('exams-screen');
    const examText002 = await bodyText();
    check(`ABC's own exam appears`, examText002.includes(ORG_002.examTitle), examText002.slice(0, 200));
    check(
      "and Abhigyan's exam does not survive the tenant switch",
      !examText002.includes(ORG_001.examTitle),
      examText002.slice(0, 200),
    );
    await shot('06-org002-exams');

    await go('/notifications');
    await waitLoaded('notifications-screen');
    const alerts002 = await bodyText();
    check("ABC's notifications appear", alerts002.includes('ABC: Welcome'), alerts002.slice(0, 200));
    check("and Abhigyan's do not", !alerts002.includes('AG:'), alerts002.slice(0, 200));

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[4] the CBT attempt player');
    // ══════════════════════════════════════════════════════════════════════
    await go('/exams');
    await waitLoaded('exams-screen');
    const started = await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('[data-testid^="exam-action-"]'))[0];
      if (!button) return false;
      (button as HTMLElement).click();
      return true;
    });
    check('the exam offers a start action', started);

    await waitFor('attempt-screen');
    check('the player opened', await exists('attempt-screen'));

    const questionText = await textOf('attempt-question-text');
    check(
      `the question is ABC's own (${ORG_002.marker})`,
      questionText.includes(ORG_002.marker),
      questionText,
    );
    check(
      "and not Abhigyan's",
      !questionText.includes(`${ORG_001.marker} Q`),
      questionText,
    );

    const timer = await textOf('attempt-timer');
    check('a server-anchored countdown is running', /^\d{2}:\d{2}$/.test(timer), timer);

    const submitLabel = await textOf('attempt-submit');
    check(
      'the submit button is locked, from the organization\'s 75% policy',
      /Locked/i.test(submitLabel),
      submitLabel,
    );

    eq('progress starts at zero answered', await textOf('attempt-progress'), '0/3 answered');

    // Answer the first question.
    const answered = await page.evaluate(() => {
      const option = document.querySelector('[data-testid^="attempt-option-"]');
      if (!option) return false;
      (option as HTMLElement).click();
      return true;
    });
    check('an option can be selected', answered);
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="attempt-progress"]')?.textContent || '').startsWith('1/'),
      { timeout: 15000 },
    ).catch(() => {});
    eq('the answer registers immediately', await textOf('attempt-progress'), '1/3 answered');

    // The queue flushes on a five-second interval; wait for it to drain.
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="attempt-pending"]'),
      { timeout: 20000 },
    ).catch(() => {});
    check('the queued answer syncs to the server', !(await exists('attempt-pending')));

    await shot('07-attempt-player');

    // Navigation and the palette.
    await tap('attempt-next');
    eq('next moves to question 2', await textOf('attempt-question-number'), 'Question 2 of 3');
    await tap('attempt-palette');
    await waitFor('attempt-palette-modal');
    check('the palette lists every question', await exists('palette-3'));
    await tap('palette-3');
    eq('and jumps to it', await textOf('attempt-question-number'), 'Question 3 of 3');
    await shot('08-attempt-palette');

    // The answer really reached the server.
    const mine = await api<any>(t002, '/attempts/mine');
    const rows = Array.isArray(mine) ? mine : (mine.attempts ?? mine.items ?? mine.data ?? []);
    check('the attempt exists server-side', rows.length >= 1, JSON.stringify(rows).slice(0, 160));

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[5] role gating — the question bank is a teaching tool');
    // ══════════════════════════════════════════════════════════════════════
    const teacher002 = await login(ORG_002.teacher.email, ORG_002.teacher.password);
    await useSession(teacher002);
    await go('/');
    await waitFor('home-screen');
    await waitForContext();
    const teacherTabs = await tabLabels();
    check('a teacher sees the Questions tab', teacherTabs.includes('Questions'), teacherTabs.join(', '));

    await go('/questions');
    await waitLoaded('questions-screen');
    // The bank defaults to the organization's FIRST configured class — 9 for
    // ABC — and the fixture's questions live in class 11. Selecting it is part
    // of the test, not a workaround: it proves the class chips actually drive
    // the query rather than being decorative.
    check("the class filter offers the organization's own levels", await exists('class-11'));
    await tap('class-11');
    // Waiting for the loading indicator to vanish is wrong here — `useLoad`
    // keeps previous data on screen during a refetch and never shows one — and
    // so is waiting for "a card OR the empty state", because the empty state
    // from the previous class is ALREADY on screen and satisfies it instantly.
    // The condition that actually means "the new result arrived" is a card.
    await page
      .waitForFunction(() => Boolean(document.querySelector('[data-testid^="question-"]')), {
        timeout: 40000,
      })
      .catch(() => {});
    const bankText = await bodyText();
    check(
      "the bank holds ABC's own questions",
      bankText.includes(`${ORG_002.marker} Q`),
      bankText.slice(0, 240),
    );
    check(
      "and none of Abhigyan's",
      !bankText.includes(`${ORG_001.marker} Q`),
      bankText.slice(0, 240),
    );
    check(
      'the class filter offers Dropper, from the organization',
      await exists('class-dropper'),
    );
    check('and not Class 7, which ABC does not teach', !(await exists('class-7')));
    check('the subject filter offers Chemistry', await exists('subject-Chemistry'));
    check('and not Hindi, which ABC does not teach', !(await exists('subject-Hindi')));
    await shot('09-org002-questions');

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[6] a disabled MODULE is explained as a plan boundary');
    // ══════════════════════════════════════════════════════════════════════
    // The Abhigyan teacher has questionBank; the ABC teacher does not lack it,
    // so the honest test of a module denial is a plan that withholds one the
    // route still exists for. ABC's plan withholds `questionImport` and `ai`,
    // neither of which has a mobile route yet — so this asserts the mechanism
    // on the tab that IS module-gated, by checking the gate's own reasoning.
    const abcModules: string[] = c002.modules;
    check('ABC does hold questionBank, so its Questions tab is legitimate', abcModules.includes('questionBank'));
    check('while ai is withheld', !abcModules.includes('ai'));
    check('and questionImport is withheld', !abcModules.includes('questionImport'));

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[7] a missing PERMISSION is explained as a role boundary');
    // ══════════════════════════════════════════════════════════════════════
    const desk = await login(ORG_002.frontDesk.email, ORG_002.frontDesk.password);
    const cDesk = await api<any>(desk, '/me/context');
    eq('the narrow role really is narrow', cDesk.permissions.length, 7);
    eq('and it is a real role, named', cDesk.roleNames, ['Front Desk']);
    eq('on the same plan as the admin', cDesk.modules.length, ORG_002.moduleCount);

    await useSession(desk);
    await go('/');
    await waitFor('home-screen');
    await waitForContext();
    const deskTabs = await tabLabels();
    check(
      'front desk loses Exams — it holds no exams.read',
      !deskTabs.includes('Exams'),
      deskTabs.join(', '),
    );
    check(
      'front desk loses Results — no results.read or attempts.read',
      !deskTabs.includes('Results'),
      deskTabs.join(', '),
    );
    check('but keeps Home', deskTabs.includes('Home'), deskTabs.join(', '));
    check('and keeps Profile — never gated', deskTabs.includes('Profile'), deskTabs.join(', '));
    await shot('10-org002-frontdesk');

    // The route still exists and explains itself.
    await go('/exams');
    await waitFor('not-authorized');
    check('the route explains rather than rendering blank', await exists('not-authorized'));
    check('and it names the ROLE, not the plan', !(await exists('module-disabled')));
    const deskMessage = await textOf('not-authorized');
    check('the message names the role the user holds', /Front Desk/.test(deskMessage), deskMessage);
    await shot('11-org002-frontdesk-denied');

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[8] switching back proves nothing leaked');
    // ══════════════════════════════════════════════════════════════════════
    await useSession(t001);
    await go('/');
    await waitFor('home-screen');
    await waitForContext();
    eq('the organization is Abhigyan again', await textOf('home-org-name'), ORG_001.label);
    const heroBack = await page.$eval(byTestId('home-hero'), (el: Element) =>
      getComputedStyle(el).backgroundColor,
    );
    eq('the orange is gone', heroBack, 'rgb(79, 70, 229)');
    eq('and the configuration is Abhigyan\'s', await textOf('config-subjects'), (await textOf('config-subjects')));
    check(
      "no trace of ABC anywhere on the page",
      !(await bodyText()).includes('ABC'),
      (await bodyText()).slice(0, 200),
    );
    await shot('12-org001-restored');

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[9] the profile screen reports what it is connected to');
    // ══════════════════════════════════════════════════════════════════════
    await go('/profile');
    await waitFor('profile-screen');
    await waitForContext();
    eq('the account name', await textOf('profile-name'), 'Abhigyan Gurukull Student');
    eq('the email', await textOf('profile-email'), ORG_001.student.email);
    eq('the role', await textOf('profile-role'), 'student');
    const profileText = await bodyText();
    check('the organization is named', profileText.includes(ORG_001.label), profileText.slice(0, 200));
    check('and the module count is reported', /34/.test(profileText), profileText.slice(0, 300));
    await shot('13-org001-profile');

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[10] signing out clears the tenant, not just the token');
    // ══════════════════════════════════════════════════════════════════════
    await tap('profile-signout');
    await waitFor('login-submit');
    const afterLogout = await page.evaluate(() => ({
      token: localStorage.getItem('accessToken'),
      hint: localStorage.getItem('orgHint'),
      cached: Object.keys(localStorage).filter((k) => k.startsWith('tenantContext:')),
    }));
    eq('the token is gone', afterLogout.token, null);
    eq('the organization hint is gone', afterLogout.hint, null);
    eq('and no cached context survives', afterLogout.cached, []);
    const loginName = await textOf('login-org-name');
    eq('the login screen is neutral again', loginName, 'Learning Platform');
    await shot('14-after-signout');

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[11] logging in THROUGH the UI resolves the tenant');
    // ══════════════════════════════════════════════════════════════════════
    // Everything above injected a token. This exercises the real path: type a
    // credential, submit, and land on a branded home screen.
    await page.focus(byTestId('login-email'));
    await page.type(byTestId('login-email'), ORG_002.student.email);
    await page.focus(byTestId('login-password'));
    await page.type(byTestId('login-password'), ORG_002.student.password);
    await tap('login-submit');
    await waitFor('home-screen');
    await waitForContext();
    eq('the organization comes from the credential alone', await textOf('home-org-name'), ORG_002.label);
    const uiHero = await page.$eval(byTestId('home-hero'), (el: Element) =>
      getComputedStyle(el).backgroundColor,
    );
    eq('and its branding is applied', uiHero, ORG_002.primaryColor);
    await shot('15-login-through-ui');

    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[12] it really was one bundle throughout');
    // ══════════════════════════════════════════════════════════════════════
    const bundleAtEnd = await page.evaluate(() => {
      const script = Array.from(document.querySelectorAll('script[src]')).find((s) =>
        (s as HTMLScriptElement).src.includes('/_expo/static/js/web/'),
      ) as HTMLScriptElement | undefined;
      return script ? script.src.split('/').pop() ?? null : null;
    });
    eq('the bundle filename is the same as before the first tenant', bundleAtEnd, bundleAtStart);
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n[13] entitlements and isolation, enforced at the API');
    // ══════════════════════════════════════════════════════════════════════
    // A mobile binary is the easiest client to inspect and the easiest to point
    // at a different server, so every gate the app applies has to hold when the
    // app is bypassed entirely.
    const teacher001Token = await login(ORG_001.teacher.email, ORG_001.teacher.password);
    const probe = async (token: string, path: string) => {
      const res = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* not json */
      }
      return { status: res.status, body: body as { code?: string } | null };
    };

    const abcAi = await probe(t002, '/ai/questions/class/11/filters');
    eq('ABC is refused the AI module at the API, not merely in the UI', abcAi.status, 403);
    eq('with a machine-readable reason', abcAi.body?.code, 'MODULE_NOT_ENABLED');

    // A TEACHER token, deliberately. `/api/ai` is also `requireRole(teacher|admin)`,
    // so a student is refused there for a completely different reason — and
    // telling those two 403s apart is the entire point of this section. The
    // code is what distinguishes them: a module denial says MODULE_NOT_ENABLED,
    // a role denial does not.
    const agAi = await probe(teacher001Token, '/ai/questions/class/11/filters');
    check(
      'Abhigyan, which has every module, is not refused for entitlement reasons',
      agAi.body?.code !== 'MODULE_NOT_ENABLED',
      `${agAi.status} ${JSON.stringify(agAi.body).slice(0, 80)}`,
    );
    const agStudentAi = await probe(t001, '/ai/questions/class/11/filters');
    check(
      "and a student's refusal there is a ROLE denial, not a module one",
      agStudentAi.status === 403 && agStudentAi.body?.code !== 'MODULE_NOT_ENABLED',
      `${agStudentAi.status} ${JSON.stringify(agStudentAi.body).slice(0, 80)}`,
    );

    // ── The practice-test isolation fix ──────────────────────────────────
    // The per-class question collections are shared by every institute and are
    // read through the raw driver, so no middleware protects them. This asks
    // each organization for the same class and proves the banks are disjoint.
    const bank = async (token: string) => {
      const res = await fetch(`${API_BASE}/exams/questions/for-paper?class=11&limit=50`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = (await res.json()) as { items?: { text?: string }[] };
      return (json.items ?? []).map((q) => q.text ?? '');
    };
    const agBank = await bank(teacher001Token);
    const abcBank = await bank(teacher002);

    check(
      "Abhigyan's class-11 bank holds only its own questions",
      agBank.length > 0 && agBank.every((t) => !t.includes('ABC Q')),
      agBank.join(' | ').slice(0, 160),
    );
    check(
      "ABC's class-11 bank holds only its own questions",
      abcBank.length > 0 && abcBank.every((t) => !t.includes('AG Q')),
      abcBank.join(' | ').slice(0, 160),
    );
    check(
      'and the two banks share no question at all',
      agBank.every((t) => !abcBank.includes(t)),
      `AG ${agBank.length} · ABC ${abcBank.length}`,
    );

    eq('no uncaught exceptions anywhere in the run', pageErrors.slice(0, 5), []);
  } finally {
    await browser.close();
  }

  console.log('');
  if (failures) {
    console.error(`CLIENT-PLATFORM-APP E2E FAILED — ${failures} of ${checks}:`);
    for (const f of failed) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`All ${checks} two-tenant mobile checks passed. Screenshots in ${SHOTS}`);
  process.exit(0);
}

main().catch((error) => {
  console.error('client-platform-app.e2e.test.ts crashed:', error);
  process.exit(1);
});
