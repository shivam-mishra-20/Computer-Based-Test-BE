/**
 * /api/* and /platform-api/* are two systems on two databases — proved end to
 * end through the REAL server: `src/server.ts` booted exactly as `npm run dev`
 * boots it, which starts the platform runtime beside itself.
 *
 *   /api/*            → the existing system on scratch database E
 *   /platform-api/*   → the platform runtime on scratch database P
 *
 * The server is booted with the configuration that produced the regression —
 * TENANT_MODE=claim and NO LEGACY_DB_NAMES — to prove the existing system no
 * longer depends on either.
 *
 * Matrix (both numberings the requests used):
 *   A/1  existing admin, no orgId → signs in, authorized, no 403
 *   B/2  existing normal user → its own permissions, unchanged role rules
 *   C/7  existing write → written, to E only
 *   D/3  platform admin with a valid organization → authorized, on P
 *   E/4  platform account without an organization → rejected (TENANT_REQUIRED)
 *   F/5  platform account reaching another organization → rejected
 *   G    existing admin on /platform-api/* → no platform access
 *   H    platform account on /api/* → no access to the existing system
 *   I/9  sign out, sign in again → no stale realm or organization context
 *   J/10 an old token (no orgId, no tv, no aud) → still works on /api/*
 *   8    AGTS works on /api/* with no organization
 *   6    every authenticated GET on /api/* for the existing admin: nothing
 *        from the organization system answers
 *   +    the runtime is unreachable except through the gateway; without
 *        PLATFORM_MONGODB_URI, /platform-api/* is 503 and /api/* unaffected
 *
 * Nothing here touches a production database: both databases are named
 * scratch databases (assertNotProduction), connections are opened with
 * collection and index creation off, and every test record is removed.
 *
 *   npm run safety:realm-separation
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import jwt from 'jsonwebtoken';
import { Checks, request, type Res } from './e2eHarness';
import { assertNotProduction, configureDnsForSrv, requireEnv } from './lib';

const ROOT = path.resolve(__dirname, '..', '..');
const RUN = `zz-realm-${process.pid}`;
// Generated per run — throwaway accounts on a scratch database; never stored.
const PW_EXISTING = `Tst-${randomBytes(9).toString('hex')}!9Aa`;
const PW_PLATFORM = `Tst-${randomBytes(9).toString('hex')}!9Aa`;
const PW_TWIN = `Tst-${randomBytes(9).toString('hex')}!9Aa`;
const EXISTING_DB = process.env.REALM_E2E_EXISTING_DB || 'abhigyangurukul_console_scratch_app';
const PLATFORM_DB = process.env.REALM_E2E_PLATFORM_DB || 'p6_client_platform_web_scratch';

/** Codes only the organization system produces. None may answer an existing /api/* request. */
const ORG_SYSTEM_CODES = new Set([
  'TENANT_REQUIRED',
  'TENANT_MISMATCH',
  'ORGANIZATION_ACCOUNT',
  'MODULE_NOT_ENABLED',
  'PERMISSION_UNRESOLVED',
  'ORG_NOT_FOUND',
  'ORG_READ_ONLY',
  'ORG_DELETING',
  'FEATURE_NOT_AVAILABLE',
  'LEARNER_SCOPE',
  'PARENT_SCOPE',
  'TOKEN_AUDIENCE_MISMATCH',
  'PLATFORM_NOT_CONFIGURED',
  'PLATFORM_UNAVAILABLE',
  'PLATFORM_GATEWAY_REQUIRED',
]);

function scratchUri(base: string, db: string): string {
  const m = base.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/);
  if (!m) throw new Error('MONGO_URI could not be parsed.');
  return `${m[1]}${db}${m[3] ?? ''}`;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Booted {
  child: ChildProcess;
  port: number;
  log: () => string;
}

async function boot(extraEnv: Record<string, string>): Promise<Booted> {
  const port = await freePort();
  let output = '';
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, PORT: String(port) };
  const child = spawn(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), 'src/server.ts'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => (output += d.toString()));
  child.stderr?.on('data', (d) => (output += d.toString()));
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output.slice(-3000)}`);
    try {
      const res = await request(port, 'GET', '/api/health');
      if (res.status === 200) return { child, port, log: () => output };
    } catch {
      /* not listening yet */
    }
    await sleep(1000);
  }
  throw new Error(`server did not come up on ${port}:\n${output.slice(-3000)}`);
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
}

async function waitFor(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch {
      /* retry */
    }
    await sleep(1000);
  }
  return false;
}

function codeOf(res: Res): string {
  const body = res.json as Record<string, unknown> | null;
  return String(body?.code ?? '');
}

function brief(res: Res): string {
  return `${res.status} ${res.raw.slice(0, 180)}`;
}

async function main() {
  const t = new Checks();
  const base = requireEnv('MONGO_URI');
  const JWT_SECRET = requireEnv('JWT_SECRET');
  const uriE = scratchUri(base, EXISTING_DB);
  const uriP = scratchUri(base, PLATFORM_DB);
  assertNotProduction(uriE, base);
  assertNotProduction(uriP, base);
  configureDnsForSrv();

  /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */
  const mongoose = require('mongoose');
  // Before any model compiles: the tenancy plugin is what gives a schema its
  // `orgId` path — without it, strict mode silently drops the organization.
  require('../../src/core/tenancy').registerTenancy();
  const { withoutTenantScope } = require('../../src/core/tenancy/context');
  const UserModel = require('../../src/models/User').default;
  const OrgModel = require('../../src/models/Org').default;
  const AnnouncementModel = require('../../src/models/Announcement').default;
  /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */

  // Our own connections: collection and index creation OFF, so seeding can
  // never add a collection to a cluster that sits near its cap.
  const connE = await mongoose.createConnection(uriE, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 20000 }).asPromise();
  const connP = await mongoose.createConnection(uriP, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 20000 }).asPromise();
  const UserE = connE.model('User', UserModel.schema);
  const UserP = connP.model('User', UserModel.schema);
  const OrgP = connP.model('Org', OrgModel.schema);
  const AnnE = connE.model('Announcement', AnnouncementModel.schema);
  const AnnP = connP.model('Announcement', AnnouncementModel.schema);

  const collectionCount = async (conn: typeof connE) =>
    (await conn.db.listCollections({}, { nameOnly: true }).toArray()).length;
  const cleanup = async () => {
    const re = new RegExp(`^${RUN}`);
    await withoutTenantScope('e2e:realm-cleanup', () =>
      Promise.all([
        UserE.deleteMany({ email: re }),
        UserP.deleteMany({ email: re }),
        OrgP.deleteMany({ slug: re }),
        AnnE.deleteMany({ title: re }),
        AnnP.deleteMany({ title: re }),
      ]),
    );
  };

  const booted: Booted[] = [];
  const beforeE = await collectionCount(connE);
  const beforeP = await collectionCount(connP);

  try {
    await cleanup();
    console.log(`\nREALM SEPARATION  (/api/* → ${EXISTING_DB}, /platform-api/* → ${PLATFORM_DB})`);

    /* ── Accounts ──────────────────────────────────────────────────────── */
    const email = (tag: string) => `${RUN}-${tag}@example.test`;
    const seed = <T>(fn: () => Promise<T>) => withoutTenantScope('e2e:realm-seed', fn) as Promise<T>;
    const legacyAdmin = await seed(() => UserE.create({ name: 'Realm Existing Admin', email: email('admin'), password: PW_EXISTING, role: 'admin', status: 'approved' }));
    await seed(() => UserE.create({ name: 'Realm Existing Student', email: email('student'), password: PW_EXISTING, role: 'student', status: 'approved', classLevel: 'Class 10' }));
    const orgX = await seed(() => OrgP.create({ name: 'Realm Org X', slug: `${RUN}-x`, status: 'active', mobile: { androidPackage: `com.zzrealm.x${process.pid}` } }));
    const orgY = await seed(() => OrgP.create({ name: 'Realm Org Y', slug: `${RUN}-y`, status: 'active', mobile: { androidPackage: `com.zzrealm.y${process.pid}` } }));
    await seed(() => UserP.create({ name: 'Realm Platform Admin', email: email('padmin'), password: PW_PLATFORM, role: 'admin', status: 'approved', orgId: orgX._id }));
    const userY = await seed(() => UserP.create({ name: 'Realm Platform Y', email: email('py'), password: PW_PLATFORM, role: 'admin', status: 'approved', orgId: orgY._id }));
    await seed(() => UserP.create({ name: 'Realm Platform NoOrg', email: email('pnoorg'), password: PW_PLATFORM, role: 'admin', status: 'approved' }));
    // Same email as the existing admin, different password, in the OTHER database.
    const twin = await seed(() => UserP.create({ name: 'Realm Platform Twin', email: email('admin'), password: PW_TWIN, role: 'admin', status: 'approved', orgId: orgX._id }));
    const seeded = await seed(() => UserP.findById(userY._id).select('orgId').lean());
    if (!seeded?.orgId) throw new Error('seeding lost the organization — the tenancy plugin did not reach the User schema');

    /* ── Boot: the regression's configuration ──────────────────────────── */
    const common: Record<string, string> = {
      MONGO_URI: uriE,
      MONGODB_URI: '',
      MONGO_URI_DIRECT: '',
      PLATFORM_MONGODB_URI_DIRECT: '',
      LEGACY_DB_NAMES: '',
      TENANT_MODE: 'claim',
      TENANT_ENFORCEMENT: 'warn',
      ORG_ID: '',
      LEGACY_DATA_ORG_ID: '',
      ENABLE_CRON: 'false',
      PLATFORM_ENABLE_CRON: '',
      PPT_WORKER_EMBEDDED: 'false',
      PLATFORM_PPT_WORKER_EMBEDDED: 'false',
      APP_BUILD_WORKER_EMBEDDED: 'false',
      REDIS_ENABLED: 'false',
      DB_BOOT_SCHEMA_SYNC: 'false',
      ADMIN_EMAIL: email('bootstrap'),
      ADMIN_PASSWORD: `Boot-${process.pid}-Strap!`,
      AUTH_RATE_LIMIT_MAX: '5000',
      GLOBAL_RATE_LIMIT_MAX: '100000',
      PASSWORD_RESET_RATE_LIMIT_MAX: '5000',
      PUBLIC_FORM_RATE_LIMIT_MAX: '5000',
      APP_BUILD_QUEUE_NAME: `app-builds-test-${process.pid}`,
    };
    const server = await boot({ ...common, PLATFORM_MONGODB_URI: uriP });
    booted.push(server);
    const port = server.port;
    const ready = await waitFor(async () => (await request(port, 'GET', '/platform-api/health')).status === 200, 240_000);

    t.section('the server — booted with TENANT_MODE=claim and no LEGACY_DB_NAMES');
    t.check('/api/* is up (the existing system)', (await request(port, 'GET', '/api/health')).status === 200);
    t.check('/platform-api/* is up (the platform runtime, through the gateway)', ready, server.log().slice(-1500));
    t.check(
      'the boot log names both realms and their databases',
      /existing system — serves \/api\/\* on database "abhigyangurukul_console_scratch_app"/.test(server.log()) &&
        new RegExp(`platform runtime on 127\\.0\\.0\\.1:\\d+ \\(database "${PLATFORM_DB}"\\)`).test(server.log()),
      server.log().split('\n').filter((l) => /realm|platform/.test(l)).slice(0, 12).join('\n'),
    );
    const runtimePort = Number((server.log().match(/platform runtime on 127\.0\.0\.1:(\d+)/) || [])[1] || 0);
    if (runtimePort) {
      const direct = await request(runtimePort, 'GET', '/api/health');
      t.check('the runtime refuses anything that bypasses the gateway', direct.status === 403 && codeOf(direct) === 'PLATFORM_GATEWAY_REQUIRED', brief(direct));
    } else {
      t.check('the runtime port was reported', false, 'no runtime port in the log');
    }

    const loginAt = (prefix: string, tag: string, password: string, extra: Record<string, unknown> = {}) =>
      request(port, 'POST', `${prefix}/auth/login`, { body: { email: email(tag), password, ...extra } });

    /* ── A / CASE 1 ────────────────────────────────────────────────────── */
    t.section('A / CASE 1 — existing admin, no orgId → /api/*');
    const adminLogin = await loginAt('/api', 'admin', PW_EXISTING);
    let adminToken = String(adminLogin.json?.token ?? '');
    t.check('signs in', adminLogin.status === 200 && Boolean(adminToken), brief(adminLogin));
    const me = await request(port, 'GET', '/api/auth/me', { token: adminToken });
    t.check('GET /api/auth/me → 200 (the request that answered 403 TENANT_REQUIRED)', me.status === 200 && me.json?.email === email('admin'), brief(me));
    for (const route of ['/api/users', '/api/users/pending', '/api/users/registrations', '/api/admin/settings', '/api/admin/audit-logs', '/api/announcements', '/api/agts/admin/leads', '/api/eod/admin/all', '/api/attendance/admin/today']) {
      const res = await request(port, 'GET', route, { token: adminToken });
      t.check(`GET ${route} → 2xx`, res.status >= 200 && res.status < 300, brief(res));
    }
    const ctx = await request(port, 'GET', '/api/me/context', { token: adminToken });
    t.check('/api/me/context: dataSource "legacy", no organization', ctx.status === 200 && ctx.json?.dataSource === 'legacy' && ctx.json?.organization === null, brief(ctx));
    const webLogin = await loginAt('/api', 'admin', PW_EXISTING, { session: 'refresh' });
    const webMe = await request(port, 'GET', '/api/auth/me', { token: String(webLogin.json?.token ?? '') });
    t.check('the web sign-in shape (session: refresh) works too', webLogin.status === 200 && webMe.status === 200, `${brief(webLogin)} | ${brief(webMe)}`);

    /* ── B / CASE 2 ────────────────────────────────────────────────────── */
    t.section('B / CASE 2 — existing normal user → /api/*');
    const studentLogin = await loginAt('/api', 'student', PW_EXISTING);
    const studentToken = String(studentLogin.json?.token ?? '');
    t.check('signs in', studentLogin.status === 200 && Boolean(studentToken), brief(studentLogin));
    const studentMe = await request(port, 'GET', '/api/auth/me', { token: studentToken });
    t.check('GET /api/auth/me → 200', studentMe.status === 200, brief(studentMe));
    const assigned = await request(port, 'GET', '/api/attempts/assigned', { token: studentToken });
    t.check('a student route → 200', assigned.status === 200, brief(assigned));
    const studentAdmin = await request(port, 'GET', '/api/users', { token: studentToken });
    t.check(
      'an admin route → 403 by ROLE (unchanged), never by organization',
      studentAdmin.status === 403 && !ORG_SYSTEM_CODES.has(codeOf(studentAdmin)),
      brief(studentAdmin),
    );

    /* ── J / CASE 10 (before any sign-out bumps the token version) ─────── */
    t.section('J / CASE 10 — an old token (no orgId, no tv, no aud) → /api/*');
    const oldToken = jwt.sign({ id: String(legacyAdmin._id), role: 'admin' }, JWT_SECRET, { expiresIn: '3650d' });
    const oldMe = await request(port, 'GET', '/api/auth/me', { token: oldToken });
    t.check('GET /api/auth/me → 200', oldMe.status === 200, brief(oldMe));
    const oldUsers = await request(port, 'GET', '/api/users', { token: oldToken });
    t.check('an admin route → 200', oldUsers.status === 200, brief(oldUsers));

    /* ── C / CASE 7 ────────────────────────────────────────────────────── */
    t.section('C / CASE 7 — an existing write → written, to the existing database only');
    const title = `${RUN} announcement`;
    const created = await request(port, 'POST', '/api/announcements', { token: adminToken, body: { title, content: 'realm e2e', isPublished: false } });
    t.check('POST /api/announcements → 201', created.status === 201, brief(created));
    t.check('…the record is in the existing database', (await seed(() => AnnE.countDocuments({ title }))) === 1);
    t.check('…and NOT in the platform database', (await seed(() => AnnP.countDocuments({ title }))) === 0);
    const renamed = await request(port, 'PATCH', '/api/auth/profile', { token: adminToken, body: { name: 'Realm Existing Admin Renamed' } });
    t.check('PATCH /api/auth/profile → 200', renamed.status === 200, brief(renamed));
    const afterE = (await seed(() => UserE.findById(legacyAdmin._id).lean())) as { name?: string } | null;
    const afterTwin = (await seed(() => UserP.findById(twin._id).lean())) as { name?: string } | null;
    t.check(
      '…changed in the existing database; the same email in the platform database untouched',
      afterE?.name === 'Realm Existing Admin Renamed' && afterTwin?.name === 'Realm Platform Twin',
      `${afterE?.name} / ${afterTwin?.name}`,
    );

    /* ── 8 ─────────────────────────────────────────────────────────────── */
    t.section('CASE 8 — AGTS on /api/* needs no organization');
    const agtsPublic = await request(port, 'GET', '/api/agts/tests');
    t.check('GET /api/agts/tests (public) → 200', agtsPublic.status === 200, brief(agtsPublic));
    const agtsAdmin = await request(port, 'GET', '/api/agts/admin/leads', { token: adminToken });
    t.check('GET /api/agts/admin/leads (existing admin) → 200', agtsAdmin.status === 200, brief(agtsAdmin));

    /* ── D / CASE 3 ────────────────────────────────────────────────────── */
    t.section('D / CASE 3 — platform admin with an organization → /platform-api/*');
    const pLogin = await loginAt('/platform-api', 'padmin', PW_PLATFORM, { session: 'refresh' });
    let pToken = String(pLogin.json?.token ?? '');
    t.check('signs in', pLogin.status === 200 && Boolean(pToken), brief(pLogin));
    const pMe = await request(port, 'GET', '/platform-api/auth/me', { token: pToken });
    t.check('GET /platform-api/auth/me → 200', pMe.status === 200 && pMe.json?.email === email('padmin'), brief(pMe));
    const pCtx = await request(port, 'GET', '/platform-api/me/context', { token: pToken });
    const pOrgId = String((pCtx.json?.organization as Record<string, unknown> | null)?.id ?? (pCtx.json?.organization as Record<string, unknown> | null)?._id ?? '');
    t.check(
      '/platform-api/me/context: dataSource "platform", its own organization',
      pCtx.status === 200 && pCtx.json?.dataSource === 'platform' && pOrgId === String(orgX._id),
      brief(pCtx),
    );
    const pUsers = await request(port, 'GET', '/platform-api/users', { token: pToken });
    const listed = JSON.stringify(pUsers.json ?? '');
    t.check(
      'GET /platform-api/users → 200, its organization only (no org Y, no existing accounts)',
      pUsers.status === 200 && listed.includes(email('padmin')) && !listed.includes(email('py')) && !listed.includes(email('student')),
      brief(pUsers),
    );
    const pRenamed = await request(port, 'PATCH', '/platform-api/auth/profile', { token: pToken, body: { name: 'Realm Platform Admin Renamed' } });
    const pAfter = (await seed(() => UserP.findOne({ email: email('padmin') }).lean())) as { name?: string } | null;
    const inExisting = await seed(() => UserE.countDocuments({ email: email('padmin') }));
    t.check(
      'a platform write lands in the platform database',
      pRenamed.status === 200 && pAfter?.name === 'Realm Platform Admin Renamed' && inExisting === 0,
      brief(pRenamed),
    );

    /* ── E / CASE 4 ────────────────────────────────────────────────────── */
    t.section('E / CASE 4 — platform account without an organization → rejected');
    const noOrgLogin = await loginAt('/platform-api', 'pnoorg', PW_PLATFORM);
    const noOrgMe = await request(port, 'GET', '/platform-api/auth/me', { token: String(noOrgLogin.json?.token ?? '') });
    t.check('GET /platform-api/auth/me → 403 TENANT_REQUIRED', noOrgMe.status === 403 && codeOf(noOrgMe) === 'TENANT_REQUIRED', brief(noOrgMe));

    /* ── F / CASE 5 ────────────────────────────────────────────────────── */
    t.section('F / CASE 5 — platform account reaching another organization → rejected');
    const foreign = await request(port, 'GET', `/platform-api/users/${String(userY._id)}`, { token: pToken });
    t.check("another organization's user by id → not served", foreign.status === 404 || foreign.status === 403, brief(foreign));
    const hinted = await request(port, 'GET', '/platform-api/users', { token: pToken, headers: { 'X-Org-Id': String(orgY._id) } });
    t.check('naming another organization in X-Org-Id → rejected (TENANT_MISMATCH)', (hinted.status === 400 || hinted.status === 403) && codeOf(hinted) === 'TENANT_MISMATCH', brief(hinted));

    /* ── G ─────────────────────────────────────────────────────────────── */
    t.section('G — the existing admin gains nothing on /platform-api/*');
    const gToken = await request(port, 'GET', '/platform-api/auth/me', { token: adminToken });
    t.check('its session is not a platform session (401)', gToken.status === 401, brief(gToken));
    const gOld = await request(port, 'GET', '/platform-api/auth/me', { token: oldToken });
    t.check('nor is an old existing-system token (401)', gOld.status === 401, brief(gOld));
    const gLogin = await loginAt('/platform-api', 'admin', PW_EXISTING);
    // The sign-in contract answers 400 for a wrong password and 404 for an
    // unknown account; what matters is that no session is issued.
    const refusedSignIn = (res: Res) => [400, 401, 404].includes(res.status) && !res.json?.token;
    t.check('its credentials do not sign in there, even with a same-email account present', refusedSignIn(gLogin), brief(gLogin));

    /* ── H ─────────────────────────────────────────────────────────────── */
    t.section('H — a platform account gains nothing on /api/*');
    const hToken = await request(port, 'GET', '/api/auth/me', { token: pToken });
    t.check('its session is not an existing-system session (401)', hToken.status === 401, brief(hToken));
    const hLogin = await loginAt('/api', 'padmin', PW_PLATFORM);
    t.check('its credentials do not sign in there (no such account in the existing database)', refusedSignIn(hLogin), brief(hLogin));
    const hTwin = await loginAt('/api', 'admin', PW_TWIN);
    t.check("the platform twin's password does not open the existing account", refusedSignIn(hTwin), brief(hTwin));

    /* ── I / CASE 9 ────────────────────────────────────────────────────── */
    t.section('I / CASE 9 — sign out, sign in again: no stale realm or organization');
    const alternating = [
      await request(port, 'GET', '/platform-api/me/context', { token: pToken }),
      await request(port, 'GET', '/api/me/context', { token: adminToken }),
      await request(port, 'GET', '/platform-api/me/context', { token: pToken }),
      await request(port, 'GET', '/api/me/context', { token: adminToken }),
    ];
    t.check(
      'alternating requests each get their own realm and organization',
      alternating[0].json?.dataSource === 'platform' && alternating[1].json?.dataSource === 'legacy' && alternating[1].json?.organization === null &&
        alternating[2].json?.dataSource === 'platform' && alternating[3].json?.organization === null,
      alternating.map(brief).join(' | '),
    );
    const out = await request(port, 'POST', '/api/auth/logout-all', { token: adminToken });
    const stale = await request(port, 'GET', '/api/auth/me', { token: adminToken });
    t.check('existing: sign out everywhere → the old session is refused (401)', out.status === 200 && stale.status === 401, `${brief(out)} | ${brief(stale)}`);
    const again = await loginAt('/api', 'admin', PW_EXISTING);
    adminToken = String(again.json?.token ?? '');
    const againCtx = await request(port, 'GET', '/api/me/context', { token: adminToken });
    t.check('existing: signed in again → served, no organization attached', again.status === 200 && againCtx.status === 200 && againCtx.json?.organization === null, brief(againCtx));
    const pOut = await request(port, 'POST', '/platform-api/auth/logout-all', { token: pToken });
    const pStale = await request(port, 'GET', '/platform-api/auth/me', { token: pToken });
    t.check('platform: sign out everywhere → the old session is refused (401)', pOut.status === 200 && pStale.status === 401, `${brief(pOut)} | ${brief(pStale)}`);
    const pAgain = await loginAt('/platform-api', 'padmin', PW_PLATFORM);
    pToken = String(pAgain.json?.token ?? '');
    const pAgainCtx = await request(port, 'GET', '/platform-api/me/context', { token: pToken });
    const againOrg = String((pAgainCtx.json?.organization as Record<string, unknown> | null)?.id ?? (pAgainCtx.json?.organization as Record<string, unknown> | null)?._id ?? '');
    t.check('platform: signed in again → its own organization', pAgainCtx.status === 200 && againOrg === String(orgX._id), brief(pAgainCtx));

    /* ── 6 ─────────────────────────────────────────────────────────────── */
    t.section('CASE 6 — every authenticated GET on /api/* for the existing admin');
    const baseline = fs.readFileSync(path.join(ROOT, 'docs', 'baselines', 'api-contract-2026-09-28.txt'), 'utf8').split(/\r?\n/);
    const fakeId = new mongoose.Types.ObjectId().toString();
    const statuses: Record<string, number> = {};
    const orgAnswers: string[] = [];
    const unauthorized: string[] = [];
    let swept = 0;
    let skipped = 0;
    // Routes that reach an EXTERNAL live system (Firestore, the AI provider,
    // the automation folder, YouTube, file storage, queue metrics): their
    // authorization is the same middleware as every other route, and calling
    // them from a test would read production systems. Not swept.
    const EXTERNAL = /^\/api\/(admin\/firebase|ai\/|automation|playlist|uploads|metrics|doubts\/[^/]+\/files|doubts\/files)/;
    for (const line of baseline) {
      const m = line.match(/^GET\s+(\S+)\s+\[(.*)\]$/);
      if (!m || !/authMiddleware/.test(m[2])) continue;
      if (EXTERNAL.test(m[1])) {
        skipped++;
        continue;
      }
      const route = m[1].replace(/:[A-Za-z]*Id\b|:id\b/g, fakeId).replace(/:[A-Za-z]+/g, '1');
      const res = await request(port, 'GET', route, { token: adminToken });
      swept++;
      statuses[res.status] = (statuses[res.status] || 0) + 1;
      if (ORG_SYSTEM_CODES.has(codeOf(res))) orgAnswers.push(`${m[1]} → ${res.status} ${codeOf(res)}`);
      if (res.status === 401) unauthorized.push(`${m[1]} → 401`);
      if (m[1].startsWith('/api/org-admin') && res.status !== 404) orgAnswers.push(`${m[1]} → ${res.status} (expected 404)`);
    }
    console.log(`      swept ${swept} routes (${skipped} external-system routes not called); statuses ${JSON.stringify(statuses)}`);
    t.check('no route answers with an organization-system refusal', orgAnswers.length === 0, orgAnswers.slice(0, 12).join('\n      '));
    t.check('no route answers 401 to a valid session', unauthorized.length === 0, unauthorized.slice(0, 12).join('\n      '));

    /* ── Platform not configured ───────────────────────────────────────── */
    killTree(server.child);
    t.section('without PLATFORM_MONGODB_URI: /platform-api/* is 503, /api/* unaffected');
    const plain = await boot({ ...common, PLATFORM_MONGODB_URI: '' });
    booted.push(plain);
    const notConfigured = await request(plain.port, 'GET', '/platform-api/health');
    t.check('/platform-api/* → 503 PLATFORM_NOT_CONFIGURED', notConfigured.status === 503 && codeOf(notConfigured) === 'PLATFORM_NOT_CONFIGURED', brief(notConfigured));
    const plainLogin = await request(plain.port, 'POST', '/api/auth/login', { body: { email: email('admin'), password: PW_EXISTING } });
    const plainMe = await request(plain.port, 'GET', '/api/auth/me', { token: String(plainLogin.json?.token ?? '') });
    t.check('/api/* serves the existing admin', plainLogin.status === 200 && plainMe.status === 200, `${brief(plainLogin)} | ${brief(plainMe)}`);

    /* ── Nothing created by starting up ────────────────────────────────── */
    t.section('starting up created nothing');
    t.check(`existing database: ${beforeE} collections before, ${await collectionCount(connE)} after`, (await collectionCount(connE)) === beforeE);
    t.check(`platform database: ${beforeP} collections before, ${await collectionCount(connP)} after`, (await collectionCount(connP)) === beforeP);
  } finally {
    for (const b of booted) killTree(b.child);
    await cleanup().catch((e: Error) => console.error('cleanup failed:', e.message));
    await connE.close();
    await connP.close();
  }
  t.report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
