/**
 * AGTS in a real browser — the website (abhigyan-gurukul-main) built against
 * the real central-be app on a SCRATCH database, driven by headless Chrome.
 *
 *   SCRATCH_DB_NAME=abhigyangurukul_console_scratch_app npm run safety:agts-web
 *   (WEB_DIR defaults to ../abhigyan-gurukul-main)
 *
 * Isolation: the backend runs pre-migration (no TENANT_* variables, exactly
 * like the live legacy deployment) against the scratch database; the website
 * is built with its API pointed at that backend and with a Firebase project
 * that does not exist; and the browser ABORTS every request that is not to
 * 127.0.0.1 — so page-view tracking, Firestore, FormSubmit and ipify cannot
 * reach anything real. Everything created is removed at the end.
 */

import http from 'http';
import { randomBytes } from 'crypto';
import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import type { AddressInfo } from 'net';
import { bootScratchApp, Checks } from './e2eHarness';

const RUN = `zz-agtsweb-${process.pid}`;
const NAME = 'Zzweb';
const BOARD = `AGTS WEB ${process.pid}`;
const WEB_DIR = path.resolve(process.env.WEB_DIR || path.join(__dirname, '../../../abhigyan-gurukul-main'));
const OUT = path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', `agts-web-${process.pid}`);
const SHOTS = path.join(OUT, '_shots');

function chromePath(): string {
  for (const c of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ]) if (fs.existsSync(c)) return c;
  throw new Error('No Chrome or Edge found for puppeteer-core');
}

/** A static server with SPA fallback for the built site. */
function serveStatic(root: string): Promise<{ port: number; close: () => void }> {
  const types: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon',
  };
  const server = http.createServer((req, res) => {
    const clean = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = path.join(root, clean);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() })));
}

async function main() {
  const t = new Checks();
  const { port: apiPort, dbName, mongoose, close } = await bootScratchApp({
    // Pre-migration, as the live legacy deployment runs.
    TENANT_MODE: '',
    TENANT_ENFORCEMENT: '',
    ORG_ID: '',
    AGTS_REGISTER_RATE_LIMIT_MAX: '500',
    AGTS_MAX_ATTEMPTS_PER_PHONE_PER_DAY: '5',
  });
  console.log(`\nAGTS WEB E2E  (scratch db: ${dbName}, api :${apiPort})`);
  if (/^abhigyangurukul(_console)?$/i.test(dbName)) throw new Error('refusing a protected database');

  /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */
  const { withoutTenantScope } = require('../../src/core/tenancy/context');
  const { signSessionToken } = require('../../src/core/auth/tokens');
  const User = require('../../src/models/User').default;
  const Lead = require('../../src/models/Lead').default;
  const ScholarshipAttempt = require('../../src/models/ScholarshipAttempt').default;
  const ScholarshipTest = require('../../src/models/ScholarshipTest').default;
  const AuditLog = require('../../src/models/AuditLog').default;
  const { getClassQuestionModel } = require('../../src/models/ClassQuestion');
  const puppeteer = require('puppeteer-core');
  /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */

  const unscoped = <T>(fn: () => Promise<T>) => withoutTenantScope('e2e:agts-web', fn) as Promise<T>;
  const db = mongoose.connection.db;
  const names = async () => (await db.listCollections({}, { nameOnly: true }).toArray()).map((c: { name: string }) => c.name);
  const before = await names();
  const leadsExisted = before.includes('leads');
  const Q11 = getClassQuestionModel('Class 11');
  let adminId = '';
  let site: { port: number; close: () => void } | null = null;
  let browser: any = null;
  const blocked = new Set<string>();

  const cleanup = async () => {
    await unscoped(async () => {
      await ScholarshipAttempt.deleteMany({ name: { $regex: `^${NAME}` } });
      await Lead.deleteMany({ 'student.name': { $regex: `^${NAME}` } });
      await Q11.deleteMany({ board: BOARD });
      await ScholarshipTest.deleteMany({ description: RUN });
      if (adminId) await AuditLog.deleteMany({ userId: new mongoose.Types.ObjectId(adminId) });
      await User.deleteMany({ email: { $regex: `^${RUN}` } });
    });
  };

  try {
    // ── Fixtures ───────────────────────────────────────────────────────────
    const admin = await unscoped(() =>
      User.create({ name: `${NAME} Admin`, email: `${RUN}-admin@example.test`, password: `Tst-${randomBytes(9).toString('hex')}!9Aa`, role: 'admin', status: 'approved' }),
    );
    adminId = String(admin._id);
    const adminToken = signSessionToken({ id: adminId, role: 'admin', tokenVersion: 0 });
    const docs = [];
    for (const [subject, topics] of [['Mathematics', ['Algebra', 'Geometry']], ['Science', ['Light', 'Electricity']]] as const) {
      for (let i = 0; i < 16; i++) {
        docs.push({
          text: `${subject} question ${i + 1}: what is $${i + 2} \\times 3$?`,
          type: 'mcq',
          options: [{ text: 'Right', isCorrect: true }, { text: 'Wrong A' }, { text: 'Wrong B' }, { text: 'Wrong C' }],
          subject, topic: topics[i % 2], board: BOARD, difficulty: 'medium', marks: 1, createdBy: admin._id, isActive: true,
        });
      }
    }
    await unscoped(() => Q11.insertMany(docs));
    // One Class 11 paper, stored under the pre-AGTS name the production papers carry.
    await unscoped(() =>
      ScholarshipTest.create({
        testName: 'Scholarship Test', description: RUN, eligibleClasses: [11], subjects: ['Math', 'Science'],
        durationMins: 60, questionsPerSubject: 15, isActive: true, shareLink: `${RUN}-paper`,
      }),
    );

    // ── Build the website against this backend ────────────────────────────
    console.log(`  building ${WEB_DIR} → ${OUT} (API http://127.0.0.1:${apiPort}/api)…`);
    const build = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', 'build', '--outDir', OUT, '--emptyOutDir', '--logLevel', 'error'], {
      cwd: WEB_DIR,
      shell: process.platform === 'win32',
      encoding: 'utf8',
      env: {
        ...process.env,
        VITE_API_BASE_URL: `http://127.0.0.1:${apiPort}/api`,
        // A project that does not exist: Firebase calls cannot reach real data.
        VITE_FIREBASE_API_KEY: 'agts-e2e-invalid',
        VITE_FIREBASE_AUTH_DOMAIN: 'agts-e2e-invalid.invalid',
        VITE_FIREBASE_PROJECT_ID: 'agts-e2e-invalid',
        VITE_FIREBASE_STORAGE_BUCKET: 'agts-e2e-invalid.invalid',
        VITE_FIREBASE_MESSAGING_SENDER_ID: '0',
        VITE_FIREBASE_APP_ID: 'agts-e2e-invalid',
      },
    });
    if (build.status !== 0) throw new Error(`website build failed:\n${build.stderr || build.stdout}`);
    fs.mkdirSync(SHOTS, { recursive: true });
    site = await serveStatic(OUT);
    const WEB = `http://127.0.0.1:${site.port}`;

    browser = await puppeteer.launch({ executablePath: chromePath(), headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err: Error) => pageErrors.push(err.message));
    await page.setRequestInterception(true);
    page.on('request', (req: any) => {
      const url = new URL(req.url());
      if (url.hostname === '127.0.0.1' || url.protocol === 'data:' || url.protocol === 'blob:') return req.continue();
      blocked.add(url.hostname);
      return req.abort();
    });

    const shot = (name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
    const noOverflow = async () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    const text = async () => page.evaluate(() => document.body.innerText);
    // Visible elements only: the desktop palette is in the DOM but hidden on
    // a phone, and clicking a hidden twin is not what a person can do.
    const clickText = async (selector: string, label: string) => {
      const handles = await page.$$(selector);
      for (const h of handles) {
        const { txt, visible } = await page.evaluate((el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const style = getComputedStyle(el as HTMLElement);
          return { txt: (el as HTMLElement).innerText.trim(), visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden' };
        }, h);
        if (visible && txt.includes(label)) {
          await h.click();
          return true;
        }
      }
      return false;
    };
    const waitText = (label: string, timeout = 20000) =>
      page.waitForFunction((l: string) => document.body.innerText.includes(l), { timeout }, label);

    // ── Mobile: landing, validation, registration ──────────────────────────
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    t.section('mobile · /agts landing and validation');
    await page.goto(`${WEB}/agts?utm_source=instagram&utm_medium=social&utm_campaign=web_e2e`, { waitUntil: 'networkidle0' });
    await waitText('Know exactly');
    t.check('landing renders the AGTS heading', (await text()).includes('where you stand'));
    t.check('landing shows the paper from the server (30 questions · 60 minutes)', (await text()).includes('30 questions'));
    t.check('no horizontal overflow at 390px', await noOverflow());
    await shot('01-mobile-landing');
    await clickText('button', 'Start the test');
    await waitText('Please agree to be contacted');
    t.check('submitting empty shows field errors incl. consent', (await text()).includes('Enter the student'));

    await page.type('input[name="studentName"]', `${NAME} Aarav`);
    await page.select('select[name="classLevel"]', '11');
    await page.type('input[name="guardianName"]', 'Meera Shah');
    await page.type('input[name="phone"]', '9812345670');
    await page.click('input[name="consent"]');
    await clickText('button', 'Start the test');
    await page.waitForFunction(() => location.pathname.startsWith('/agts/test/'), { timeout: 30000 });
    const attemptId = decodeURIComponent((await page.evaluate(() => location.pathname)).split('/').pop() || '');
    t.check('registration starts the test (/agts/test/AGTS-…)', /^AGTS-11-/.test(attemptId), attemptId);
    const lead: any = await unscoped(() => Lead.findOne({ phoneNormalized: '9812345670' }).lean());
    t.check('a lead was created with consent and the UTM source', lead?.consent?.contact === true && lead?.attribution?.first?.source === 'instagram');
    t.check('landing page stored without query string', lead?.attribution?.first?.landingPage === '/agts');

    // ── Mobile: the player ─────────────────────────────────────────────────
    t.section('mobile · test player');
    await waitText('Question 1');
    t.check('player shows question 1 of 30 and a timer', (await text()).includes('/ 30') && (await text()).includes('time left'));
    t.check('player has no site navigation (full-screen)', !(await page.$('nav[aria-label="Primary"]')));
    t.check('no horizontal overflow in the player', await noOverflow());
    await shot('02-mobile-player');
    for (let i = 0; i < 5; i++) {
      await clickText('label', 'Right');
      await clickText('button', 'Save & next');
      await waitText(`Question ${i + 2}`);
    }
    await clickText('button', 'Mark for review'); // Q6 marked, unanswered
    await clickText('button', 'Save & next'); // Q7 visited…
    await clickText('button', 'Save & next'); // …and skipped
    await page.waitForFunction(() => document.body.innerText.includes('All answers saved'), { timeout: 15000 });
    const stored: any = await unscoped(() => ScholarshipAttempt.findOne({ attemptId }).lean());
    t.check('answers autosaved to the server (5 answered, 1 marked)', (stored.answers || []).filter((a: any) => a.chosenOptionId).length === 5 && (stored.answers || []).some((a: any) => a.markedForReview));
    await clickText('button', 'Questions ·');
    await waitText('All questions');
    const sheet = await text();
    t.check('question sheet shows answered / marked / not answered / not visited', ['Answered', 'Marked for review', 'Not answered', 'Not visited'].every((l) => sheet.includes(l)));
    await shot('03-mobile-question-sheet');
    await clickText('button', 'Close');

    await clickText('button', 'Submit');
    await waitText('Submit your test?');
    const dialog = await text();
    t.check('submit confirmation shows unanswered count (25)', dialog.includes('25 questions are unanswered'));
    await shot('04-mobile-submit-dialog');
    await clickText('button', 'Submit now');
    await page.waitForFunction(() => location.pathname.startsWith('/agts/result/'), { timeout: 30000 });

    // ── Mobile: the report ─────────────────────────────────────────────────
    t.section('mobile · result and analysis');
    await waitText('Subject-wise performance');
    const report = await text();
    t.check('score 5/30 and 16.67% from the server', report.includes('5/30') && report.includes('16.67%'));
    t.check('accuracy 100% (5 of 5 attempted)', report.includes('100%'));
    t.check('subject, topic, strengths/areas, next steps and question map present', ['Topic-wise performance', 'Strengths', 'Areas to improve', 'What to do next', 'Question by question'].every((l) => report.includes(l)));
    t.check('no scholarship language on the report', !/scholarship/i.test(report));
    t.check('no contact details on the report', !report.includes('9812345670') && !report.includes('Meera'));
    t.check('no horizontal overflow on the report', await noOverflow());
    await shot('05-mobile-report');
    await clickText('button', 'Get academic guidance');
    await page.select('select[name="preferredTime"]', 'Evening (4pm–8pm)');
    await clickText('button', 'Request a call');
    await waitText('Guidance requested');
    t.check('guidance request recorded on the lead', (await unscoped(() => Lead.findOne({ phoneNormalized: '9812345670' }).lean()))?.guidance?.requested === true);

    await page.goto(`${WEB}/agts/history`, { waitUntil: 'networkidle0' });
    await waitText('View report');
    t.check('history lists the attempt with its percentage', (await text()).includes('16.67%'));
    await shot('06-mobile-history');

    t.section('legacy URLs');
    await page.goto(`${WEB}/scholarship?test=abc`, { waitUntil: 'networkidle0' });
    t.check('/scholarship?test=… → /agts?test=…', (await page.evaluate(() => location.pathname + location.search)) === '/agts?test=abc');
    await page.goto(`${WEB}/scholarship-test/${attemptId}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => location.pathname.startsWith('/agts/result/'), { timeout: 15000 });
    t.check('/scholarship-test/:id → the AGTS result for a submitted attempt', true);
    await page.goto(`${WEB}/scholarship-results`, { waitUntil: 'networkidle0' });
    t.check('/scholarship-results → AGTS history', (await page.evaluate(() => location.pathname)) === '/agts/history');

    t.section('admissions and home pages');
    await page.goto(`${WEB}/admissions`, { waitUntil: 'networkidle0' });
    await waitText('How admission works');
    const adm = await text();
    t.check('admissions shows AGTS and the procedure', adm.includes('AGTS') && adm.includes('How admission works'));
    t.check('the retired offer is gone (no 30% OFF, no ₹50 Lakh, no Early Bird)', !/30% OFF|50 Lakh|₹50L|Early Bird/i.test(adm));
    t.check('no horizontal overflow on /admissions (mobile)', await noOverflow());
    await shot('07-mobile-admissions');
    await page.goto(`${WEB}/`, { waitUntil: 'networkidle0' });
    t.check('home links to AGTS', (await text()).includes('Take AGTS'));

    // ── Desktop: the staff lead desk ───────────────────────────────────────
    t.section('desktop · AGTS lead desk');
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluate((token: string) => {
      localStorage.setItem('accessToken', token);
      localStorage.setItem('userRole', 'admin');
      localStorage.setItem('isAuthenticated', 'true');
    }, adminToken);
    await page.goto(`${WEB}/student-dashboard/agts-leads`, { waitUntil: 'networkidle0' });
    await waitText('AGTS Leads');
    await waitText(`${NAME} Aarav`);
    const desk = await text();
    t.check('lead listed with score, accuracy and status', desk.includes('16.67%') && desk.includes('AGTS Completed'));
    t.check('guidance request flagged in the list', desk.includes('guidance requested'));
    await shot('08-desktop-lead-desk');
    await clickText('tr', `${NAME} Aarav`);
    await waitText('AGTS history');
    const drawer = await text();
    t.check('drawer shows contact, consent, source and history', ['+91 9812345670', 'Given', 'instagram', 'View analysis'].every((l) => drawer.includes(l)));
    await clickText('button', 'View analysis');
    await waitText('Answer review');
    await clickText('button', 'Answer review');
    await waitText('chosen');
    t.check('complete analysis shows per-question answers and the key', (await text()).includes('correct'));
    await shot('09-desktop-analysis');
    await page.click('button[aria-label="Close analysis"]');
    await page.type('textarea[aria-label="New note"]', 'Called; parent wants Science focus');
    await clickText('button', 'Add');
    await waitText('Note added');
    await page.select('select[aria-label="Lead status"]', 'counselling');
    await clickText('button', 'Update status');
    await waitText('Status updated');
    const after: any = await unscoped(() => Lead.findOne({ phoneNormalized: '9812345670' }).lean());
    t.check('note and status saved (counselling, by the admin)', after.status === 'counselling' && after.notes.some((n: any) => /Science focus/.test(n.text)) && after.statusHistory.some((h: any) => h.to === 'counselling' && h.byName));
    await clickText('button', 'WhatsApp');
    await waitText('Open in WhatsApp');
    const wa = await page.$eval('textarea[aria-label="WhatsApp message"]', (el: any) => el.value);
    t.check('WhatsApp message is built from real data (name, score) and editable', wa.includes('Meera Shah') && wa.includes('5/30') && !/scholarship/i.test(wa));
    await shot('10-desktop-drawer');

    t.check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    t.check('every external request was blocked (nothing left the machine)', true, [...blocked].join(', '));
    console.log(`  external hosts blocked: ${[...blocked].join(', ') || 'none'}`);
    console.log(`  screenshots: ${SHOTS}`);
  } catch (err) {
    console.error('\n  ✗ suite aborted:', (err as Error).stack || err);
    t.check('suite completed without aborting', false);
  } finally {
    if (browser) await browser.close();
    if (site) site.close();
    await cleanup();
    if (!leadsExisted && (await names()).includes('leads')) await db.dropCollection('leads');
    const after = await names();
    t.check('scratch database left with the collections it started with', after.length === before.length);
    await close();
  }
  t.report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
