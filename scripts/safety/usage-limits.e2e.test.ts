/**
 * Usage limits, end to end, through the real app on an isolated database.
 *
 * Platform runtime. Organizations:
 *   L       Professional trial (managed) with negotiated limits: 3 students,
 *           2 teachers, 2 admins, 2 AI generations a month, 1 app build.
 *   B       Starter trial — the other tenant; no AI module.
 *   REG     Starter, open public registration, 1 student.
 *   OWNED   platform-owned, with a 1-student override — never limited.
 *   NOSUB   platform-created, no subscription (core only) — no limits.
 *   LEGACY  a subscription written before the lifecycle: suspended, a past trial
 *           end and a 1-student plan — keeps exactly the access it had.
 *   SWEEP   for the concurrent-sweep check.
 *
 * AI runs against a fake model server on loopback (AI_PROVIDER=ollama), so a
 * generation can genuinely succeed or fail without any external service.
 *
 * Loopback MongoDB only, on a database this suite owns and drops at the end:
 *   SCRATCH_DB_NAME=iso_platform_scratch_usage SCRATCH_ALLOW_NEW_DB=true \
 *   E2E_TENANT_ENFORCEMENT=warn|enforce \
 *     npx ts-node --transpile-only scripts/safety/usage-limits.e2e.test.ts
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { Checks, bootScratchApp, request, type Res } from './e2eHarness';

const c = new Checks();
const brief = (r: Res) => `${r.status} ${r.raw.slice(0, 240)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loopbackOnly(uri: string) {
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)\/([^?]*)/);
  const hosts = (m?.[1] ?? '').toLowerCase().split(',');
  if (!hosts.every((h) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h))) {
    throw new Error(`Refusing to run: loopback MongoDB only (got ${hosts.join(',')}).`);
  }
}

/** A stand-in for an Ollama server: answers /api/chat, or fails on demand. */
function fakeModel() {
  const state = { mode: 'ok' as 'ok' | 'fail', calls: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      state.calls++;
      if (state.mode === 'fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'model unavailable' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'fake',
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content: JSON.stringify({ text: 'What is 2 + 2?', type: 'short', explanation: 'four' }) },
          done: true,
        }),
      );
    });
  });
  return { server, state };
}

/** multipart/form-data — the harness client speaks JSON only. */
function multipart(port: number, path: string, token: string, fields: Record<string, string>, file: { field: string; name: string; type: string; data: Buffer }): Promise<Res> {
  const boundary = `----usage${Date.now().toString(16)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path, headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } },
      (res) => {
        let raw = '';
        res.on('data', (d) => (raw += d));
        res.on('end', () => {
          let json: any = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, json, raw });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function main() {
  loopbackOnly(process.env.MONGO_URI || '');
  const explicit = (process.env.SCRATCH_DB_NAME || '').trim();
  if (!/^iso_[a-z0-9_]*_scratch_usage$/.test(explicit)) {
    throw new Error('Set SCRATCH_DB_NAME to an iso_*_scratch_usage database: this suite drops it when it finishes.');
  }

  const model = fakeModel();
  await new Promise<void>((r) => model.server.listen(0, '127.0.0.1', r));
  const modelPort = (model.server.address() as AddressInfo).port;

  const mode = process.env.E2E_TENANT_ENFORCEMENT || 'warn';
  const app = await bootScratchApp({
    AI_PROVIDER: 'ollama',
    OLLAMA_HOST: `http://127.0.0.1:${modelPort}`,
    OLLAMA_MODEL: 'fake',
    AI_RATE_LIMIT_MAX: '5000',
    ALLOW_PUBLIC_REGISTER: 'true',
    USAGE_LOCK_WAIT_MS: '3000',
  });
  const mongoose = app.mongoose;
  const db = mongoose.connection.db;
  const col = (name: string) => db.collection(name);
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { withoutTenantScope, runWithTenant } = require('../../src/core/tenancy/context');
  const { signPlatformToken } = require('../../src/core/auth/tokens');
  const PlatformUser = require('../../src/models/PlatformUser').default;
  const User = require('../../src/models/User').default;
  const Org = require('../../src/models/Org').default;
  const { setAppExperience } = require('../../src/core/platform/appExperience');
  const usage = require('../../src/core/subscriptions/usage');
  const { runLifecycleSweep } = require('../../src/core/subscriptions/service');
  const { clearHostResolutionCache } = require('../../src/core/tenancy/hostResolution');
  const { clearOrgStateCache } = require('../../src/core/tenancy/orgState');
  /* eslint-enable @typescript-eslint/no-var-requires */
  const unscoped = <T>(fn: () => Promise<T>) => withoutTenantScope('e2e:usage', fn) as Promise<T>;

  const RUN = `zz-use-${Date.now().toString(36)}`;
  const PASSWORD = `Use-${process.pid}-Pass!`;
  const call = (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    request(app.port, method, path, opts);
  const oid = (id: string) => new mongoose.Types.ObjectId(id);

  try {
    console.log(`\nUSAGE LIMITS — platform runtime, TENANT_ENFORCEMENT=${mode} (db: ${app.dbName})`);

    // ── Staff and catalogue ──────────────────────────────────────────────
    c.section('fixtures');
    const [owner, billing, support] = await unscoped(() =>
      Promise.all([
        PlatformUser.create({ name: 'U Owner', email: `${RUN}-owner@platform.test`, password: PASSWORD, role: 'owner' }),
        PlatformUser.create({ name: 'U Billing', email: `${RUN}-billing@platform.test`, password: PASSWORD, role: 'billing' }),
        PlatformUser.create({ name: 'U Support', email: `${RUN}-support@platform.test`, password: PASSWORD, role: 'support' }),
      ]),
    );
    const OWNER = signPlatformToken({ id: String(owner._id), role: 'owner', tokenVersion: 0 });
    const BILLING = signPlatformToken({ id: String(billing._id), role: 'billing', tokenVersion: 0 });
    const SUPPORT = signPlatformToken({ id: String(support._id), role: 'support', tokenVersion: 0 });
    await call('POST', '/api/platform/plans/seed-defaults', { token: BILLING });

    const config = { classLevels: [{ key: '11', label: 'Class 11', aliases: ['11', 'Class 11'] }] };
    const onboard = async (key: string, subscription?: Record<string, unknown>) => {
      const r = await call('POST', '/api/platform/orgs/onboard', {
        token: OWNER,
        body: {
          organization: { name: `${RUN} ${key}`, slug: `${RUN}-${key}`.toLowerCase() },
          configuration: config,
          admin: { name: `${key} Admin`, email: `${RUN}-${key}-admin@example.test`.toLowerCase(), password: PASSWORD },
          ...(subscription ? { subscription } : {}),
        },
      });
      if (!r.json?.orgId) throw new Error(`onboard ${key}: ${brief(r)}`);
      return r.json.orgId as string;
    };
    const L = await onboard('l', { planKey: 'professional' });
    const B = await onboard('b', { planKey: 'starter' });
    const REG = await onboard('reg', { planKey: 'starter' });
    const NOSUB = await onboard('nosub');
    const SWEEP = await onboard('sweep', { planKey: 'starter' });
    const setLimits = (orgId: string, limits: Record<string, number>) =>
      call('PUT', `/api/platform/orgs/${orgId}/subscription`, { token: BILLING, body: { overrides: { limits } } });
    await setLimits(L, { students: 3, teachers: 2, admins: 2, aiGenerationsMonthly: 2, appBuildsMonthly: 1 });
    await setLimits(REG, { students: 1 });

    const now = new Date();
    const insertOrg = async (key: string, extra: Record<string, unknown> = {}) => {
      const _id = new mongoose.Types.ObjectId();
      await col('orgs').insertOne({ _id, name: `${RUN} ${key}`, slug: `${RUN}-${key}`, status: 'active', createdAt: now, updatedAt: now, ...extra });
      return String(_id);
    };
    const OWNED = await insertOrg('owned', { isPlatformOwned: true });
    await col('subscriptions').insertOne({ orgId: oid(OWNED), status: 'active', managedSince: now, addOns: [], removals: [], overrides: { limits: { students: 1 } }, createdAt: now, updatedAt: now });
    const LEGACY = await insertOrg('legacy');
    const legacyPlan = await col('plans').insertOne({ key: `${RUN}-legacy`.toLowerCase(), name: 'Legacy', modules: ['students', 'homework'], limits: { students: 1 }, price: { monthly: 1, currency: 'INR' }, isPublic: true, sortOrder: 0, createdAt: now, updatedAt: now });
    await col('subscriptions').insertOne({
      orgId: oid(LEGACY), planId: legacyPlan.insertedId, status: 'suspended', trialEndsAt: new Date(Date.now() - 40 * 86400000),
      addOns: [], removals: [], createdAt: now, updatedAt: now,
    });
    clearHostResolutionCache?.();
    for (const [key, orgId] of [['owned', OWNED], ['legacy', LEGACY]] as const) {
      await unscoped(() => User.create({ name: `${key} Admin`, email: `${RUN}-${key}-admin@example.test`, password: PASSWORD, role: 'admin', status: 'approved', orgId }));
    }
    const login = async (email: string, orgId: string) => {
      const r = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: { 'X-Org-Id': orgId } });
      if (!r.json?.token) throw new Error(`login ${email}: ${brief(r)}`);
      return r.json.token as string;
    };
    const admin = {
      L: await login(`${RUN}-l-admin@example.test`, L),
      B: await login(`${RUN}-b-admin@example.test`, B),
      REG: await login(`${RUN}-reg-admin@example.test`, REG),
      NOSUB: await login(`${RUN}-nosub-admin@example.test`, NOSUB),
      OWNED: await login(`${RUN}-owned-admin@example.test`, OWNED),
      LEGACY: await login(`${RUN}-legacy-admin@example.test`, LEGACY),
    };
    c.check('fixtures: 8 organizations, their admins, staff, the catalogue and a fake model', true);

    let seq = 0;
    const person = (role: string, extra: Record<string, unknown> = {}) => {
      seq++;
      return { name: `${role} ${seq}`, email: `${RUN}-p${seq}@example.test`, password: PASSWORD, role, classLevel: '11', empCode: `${RUN}-E${seq}`, ...extra };
    };
    const create = (token: string, role = 'student', extra: Record<string, unknown> = {}) => call('POST', '/api/users', { token, body: person(role, extra) });
    const used = async (orgId: string, resource: string) => (await call('GET', `/api/platform/orgs/${orgId}/subscription`, { token: SUPPORT })).json?.usage?.[resource];
    const count = (orgId: string, role: string) => col('users').countDocuments({ orgId: { $in: [orgId, oid(orgId)] }, role, status: 'approved' });

    // ── Students at the limit ─────────────────────────────────────────────
    c.section('students: at the limit');
    const s1 = await create(admin.L);
    const s2 = await create(admin.L);
    const s3 = await create(admin.L);
    c.check('three students fit a 3-student limit', [s1, s2, s3].every((r) => r.status === 201), [s1, s2, s3].map(brief).join(' | '));
    const s4 = await create(admin.L);
    c.check('the fourth is refused: 402 PLAN_LIMIT_REACHED, students, limit 3, current 3',
      s4.status === 402 && s4.json?.code === 'PLAN_LIMIT_REACHED' && s4.json?.resource === 'students' && s4.json?.limit === 3 && s4.json?.current === 3, brief(s4));
    c.check('...and nothing was created', (await count(L, 'student')) === 3);
    const refusalAudit = await col('auditlogs').findOne({ action: 'plan.limit.refused', 'metadata.resource': 'students' });
    c.check('the refusal is in the organization\'s audit log', Boolean(refusalAudit));
    const u = await used(L, 'students');
    c.check('usage reads 3 of 3, enforced', u?.used === 3 && u?.limit === 3 && u?.enforced === true, JSON.stringify(u));
    const adminView = (await call('GET', '/api/org-admin/plan', { token: admin.L })).json;
    c.check('the organization\'s own admin sees the same usage', adminView?.usage?.tracked === true && adminView.usage.resources?.students?.used === 3 && adminView.limitsEnforced === true);

    c.section('students: the last slot, six at once');
    await call('DELETE', `/api/users/${s3.json.id}`, { token: admin.L });
    c.check('deleting a student frees its seat (2 of 3)', (await used(L, 'students'))?.used === 2);
    const burst = await Promise.all(Array.from({ length: 6 }, () => create(admin.L)));
    c.check('six simultaneous creations for one free seat: exactly one 201, five 402',
      burst.filter((r) => r.status === 201).length === 1 && burst.filter((r) => r.status === 402).length === 5, burst.map((r) => r.status).join(','));
    c.check('...and the organization ends at exactly 3', (await count(L, 'student')) === 3);

    c.section('deactivation and reactivation');
    await call('PUT', `/api/users/${s1.json.id}/reject`, { token: admin.L });
    c.check('rejecting a student frees its seat', (await count(L, 'student')) === 2);
    const pending = await runWithTenant({ orgId: L, source: 'script' }, () =>
      User.create({ name: 'Pending', email: `${RUN}-pending@example.test`, password: PASSWORD, role: 'student', status: 'pending', classLevel: 'Class 11' }),
    );
    const approvePending = await call('PUT', `/api/users/${pending._id}/approve`, { token: admin.L, body: { empCode: `${RUN}-PEND` } });
    c.check('approving a pending student takes the free seat', approvePending.status === 200 && (await count(L, 'student')) === 3, brief(approvePending));
    const reapprove = await call('PUT', `/api/users/${s1.json.id}/approve`, { token: admin.L, body: { empCode: `${RUN}-REAP` } });
    c.check('re-approving a rejected student at the limit is refused (402)', reapprove.status === 402 && reapprove.json?.code === 'PLAN_LIMIT_REACHED', brief(reapprove));
    c.check('...and it stays rejected', (await col('users').findOne({ _id: oid(s1.json.id) }))?.status === 'rejected');

    c.section('retries and duplicates');
    await call('PUT', `/api/users/${pending._id}/reject`, { token: admin.L });
    const twin = await runWithTenant({ orgId: L, source: 'script' }, () =>
      User.create({ name: 'Twin', email: `${RUN}-twin@example.test`, password: PASSWORD, role: 'student', status: 'pending', classLevel: 'Class 11' }),
    );
    const twice = await Promise.all([0, 1].map((i) => call('PUT', `/api/users/${twin._id}/approve`, { token: admin.L, body: { empCode: `${RUN}-TWIN${i}` } })));
    c.check('the same approval sent twice at once takes ONE seat', (await count(L, 'student')) === 3 && twice.some((r) => r.status === 200), twice.map(brief).join(' | '));
    c.check('...and never a server error', twice.every((r) => r.status < 500));
    const edit = await call('PUT', `/api/users/${twin._id}`, { token: admin.L, body: { name: 'Twin renamed' } });
    c.check('editing an existing student at the limit is allowed (no new seat)', edit.status === 200, brief(edit));
    const dupEmail = await create(admin.L, 'student', { email: `${RUN}-twin@example.test` });
    c.check('a failed creation (email in use) changes nothing', dupEmail.status === 400 && (await count(L, 'student')) === 3, brief(dupEmail));
    await call('PUT', `/api/users/${twin._id}/reject`, { token: admin.L });
    const noCode = await create(admin.L, 'student', { empCode: '' });
    c.check('a rejected creation (no code) below the limit consumes nothing', noCode.status === 400 && (await count(L, 'student')) === 2);

    // ── Staff ─────────────────────────────────────────────────────────────
    c.section('teachers and administrators');
    const t1 = await create(admin.L, 'teacher');
    const t2 = await create(admin.L, 'teacher');
    const t3 = await create(admin.L, 'teacher');
    c.check('2 teachers fit, the third is refused (teachers, limit 2)', t1.status === 201 && t2.status === 201 && t3.status === 402 && t3.json?.resource === 'teachers', brief(t3));
    const inviteAdmin = await call('POST', '/api/org-admin/invitations', { token: admin.L, body: { name: 'Second Admin', email: `${RUN}-admin2@example.test`, role: 'admin' } });
    c.check('an invited admin takes the second admin seat (the first is the onboarded admin)', inviteAdmin.status === 201, brief(inviteAdmin));
    const inviteAdmin3 = await call('POST', '/api/org-admin/invitations', { token: admin.L, body: { name: 'Third Admin', email: `${RUN}-admin3@example.test`, role: 'admin' } });
    c.check('a third admin invitation is refused (admins, limit 2)', inviteAdmin3.status === 402 && inviteAdmin3.json?.resource === 'admins', brief(inviteAdmin3));
    const inviteStudent = await call('POST', '/api/org-admin/invitations', { token: admin.L, body: { name: 'Invited', email: `${RUN}-inv@example.test`, role: 'student', empCode: `${RUN}-INV`, classLevel: '11' } });
    c.check('an invited student takes a seat too', inviteStudent.status === 201 && (await count(L, 'student')) === 3, brief(inviteStudent));
    const promote = await call('PUT', `/api/users/${inviteStudent.json?.user?.id}`, { token: admin.L, body: { role: 'teacher' } });
    c.check('making a student a teacher when teachers are full is refused', promote.status === 402 && promote.json?.resource === 'teachers', brief(promote));
    await call('DELETE', `/api/users/${t2.json.id}`, { token: admin.L });
    const promote2 = await call('PUT', `/api/users/${inviteStudent.json?.user?.id}`, { token: admin.L, body: { role: 'teacher' } });
    c.check('...and allowed once a teacher seat is free: the student seat is freed, a teacher seat taken',
      promote2.status === 200 && (await count(L, 'student')) === 2 && (await count(L, 'teacher')) === 2, brief(promote2));

    // ── Permissions ───────────────────────────────────────────────────────
    c.section('permissions come first');
    const studentOnlyTok = await login(s2.json.email, L);
    const byStudent = await create(studentOnlyTok);
    c.check('a student (no users.create) is refused 403 — before any usage check', byStudent.status === 403, brief(byStudent));
    const tenantUsage = await call('GET', `/api/platform/orgs/${L}/subscription`, { token: admin.L });
    c.check('an organization admin cannot read the platform usage view', tenantUsage.status === 401 || tenantUsage.status === 403, brief(tenantUsage));
    const tenantLimit = await call('PUT', `/api/platform/orgs/${L}/subscription`, { token: admin.L, body: { overrides: { limits: { students: 9999 } } } });
    c.check('...nor raise its own limit', tenantLimit.status === 401 || tenantLimit.status === 403, brief(tenantLimit));

    // ── Transfers ─────────────────────────────────────────────────────────
    c.section('a student moved between organizations');
    const mover = await create(admin.L);
    c.check('L back at 3 of 3', mover.status === 201 && (await count(L, 'student')) === 3, brief(mover));
    const bBefore = (await used(B, 'students'))?.used;
    await col('users').updateOne({ _id: oid(mover.json.id) }, { $set: { orgId: B } });
    c.check('moving a student to B frees L\'s seat and takes one of B\'s, immediately',
      (await used(L, 'students'))?.used === 2 && (await used(B, 'students'))?.used === bBefore + 1);
    c.check('L can now add a student', (await create(admin.L)).status === 201);
    await col('users').updateOne({ _id: oid(mover.json.id) }, { $set: { orgId: L } });
    c.check('moving it back leaves L over its limit (4 of 3) without deleting anyone', (await used(L, 'students'))?.used === 4 && (await used(L, 'students'))?.over === true);

    // ── Over the limit after a downgrade ──────────────────────────────────
    c.section('over the limit (downgrade)');
    await setLimits(L, { students: 2, teachers: 2, admins: 2, aiGenerationsMonthly: 2, appBuildsMonthly: 1 });
    c.check('lowering the limit to 2 leaves all 4 students in place', (await count(L, 'student')) === 4);
    const overCreate = await create(admin.L);
    c.check('a new student is refused while over (current 4, limit 2)', overCreate.status === 402 && overCreate.json?.current === 4 && overCreate.json?.limit === 2, brief(overCreate));
    const studentTok = await login(mover.json.email, L);
    c.check('an existing student still signs in', Boolean(studentTok));
    c.check('...and can still change their own profile', (await call('PATCH', '/api/auth/profile', { token: studentTok, body: { name: 'Still here' } })).status === 200);
    c.check('existing students can still be edited', (await call('PUT', `/api/users/${mover.json.id}`, { token: admin.L, body: { name: 'Edited' } })).status === 200);
    c.check('...and listed and read', (await call('GET', '/api/users?role=student', { token: admin.L })).status === 200);
    await call('DELETE', `/api/users/${mover.json.id}`, { token: admin.L });
    await call('DELETE', `/api/users/${s2.json.id}`, { token: admin.L });
    c.check('removing students brings it back to 2 of 2, still refusing a third', (await count(L, 'student')) === 2 && (await create(admin.L)).status === 402);
    await setLimits(L, { students: 3, teachers: 2, admins: 2, aiGenerationsMonthly: 2, appBuildsMonthly: 1 });
    c.check('raising the limit again lets one more in', (await create(admin.L)).status === 201);

    c.section('plan upgrade and downgrade');
    c.check('B on Starter: 100 students', (await used(B, 'students'))?.limit === 100);
    await call('POST', `/api/platform/orgs/${B}/subscription/plan`, { token: BILLING, body: { planKey: 'professional', reason: 'Upgrade' } });
    c.check('...upgraded to Professional: 1,500', (await used(B, 'students'))?.limit === 1500);
    await call('POST', `/api/platform/orgs/${B}/subscription/plan`, { token: BILLING, body: { planKey: 'starter', reason: 'Back down' } });
    c.check('...and back to Starter: 100, with every student kept', (await used(B, 'students'))?.limit === 100 && (await count(B, 'student')) === bBefore);

    // ── Exempt organizations ──────────────────────────────────────────────
    c.section('platform-owned and unsubscribed organizations');
    const owned = await Promise.all([1, 2, 3].map(() => create(admin.OWNED)));
    c.check('a platform-owned organization is never limited (3 students past a 1-student override)', owned.every((r) => r.status === 201), owned.map(brief).join(' | '));
    c.check('...and its usage says not enforced', (await used(OWNED, 'students'))?.enforced === false);
    const nosub = await Promise.all([1, 2].map(() => create(admin.NOSUB)));
    c.check('an organization without a subscription keeps core access: students can be added', nosub.every((r) => r.status === 201), nosub.map(brief).join(' | '));

    // ── A subscription from before the lifecycle ──────────────────────────
    c.section('a pre-lifecycle subscription keeps its access');
    const legacyWrite = await create(admin.LEGACY);
    const legacyWrite2 = await create(admin.LEGACY);
    c.check('"suspended", with a 1-student plan: still writable, and not limited (2 students)', legacyWrite.status === 201 && legacyWrite2.status === 201, brief(legacyWrite2));
    await runLifecycleSweep(new Date());
    await call('GET', '/api/auth/me', { token: admin.LEGACY });
    const legacySub = await col('subscriptions').findOne({ orgId: oid(LEGACY) });
    c.check('its trial end 40 days ago moves nothing — neither the sweep nor a request', legacySub?.status === 'suspended' && !legacySub?.managedSince);
    const legacyUsage = await used(LEGACY, 'students');
    c.check('its usage shows the limit, exceeded, but not enforced', legacyUsage?.limit === 1 && legacyUsage?.used === 2 && legacyUsage?.enforced === false, JSON.stringify(legacyUsage));
    const noReason = await call('POST', `/api/platform/orgs/${LEGACY}/subscription/manage`, { token: BILLING, body: {} });
    c.check('bringing it under the lifecycle needs a reason', noReason.status === 400 && noReason.json?.code === 'REASON_REQUIRED');
    const supportManage = await call('POST', `/api/platform/orgs/${LEGACY}/subscription/manage`, { token: SUPPORT, body: { reason: 'try' } });
    c.check('...and subscription.manage (support refused)', supportManage.status === 403);
    const managed = await call('POST', `/api/platform/orgs/${LEGACY}/subscription/manage`, { token: BILLING, body: { reason: 'Customer agreed to the new terms' } });
    c.check('managed: its suspension now applies (not writable) and its limits are enforced',
      managed.status === 200 && managed.json?.entitlement?.writable === false && managed.json?.usage?.students?.enforced === true, brief(managed));
    clearOrgStateCache?.();
    const legacyAfter = await create(admin.LEGACY);
    c.check('...so a write is now refused as read-only (423)', legacyAfter.status === 423 && legacyAfter.json?.code === 'SUBSCRIPTION_READ_ONLY', brief(legacyAfter));

    // ── Open public registration ──────────────────────────────────────────
    c.section('open registration at the student limit');
    const appId = `com.zzuse.reg.p${process.pid}`;
    await unscoped(() => Org.updateOne({ _id: REG }, { $set: { 'mobile.androidPackage': appId } }));
    await setAppExperience(REG, { registrationPolicy: 'open', roles: { student: true } });
    clearHostResolutionCache?.();
    const register = (tag: string) =>
      call('POST', '/api/auth/register', {
        headers: { 'X-Org-Id': REG, 'X-App-Id': appId },
        body: { name: `Reg ${tag}`, email: `${RUN}-reg-${tag}@example.test`, phone: '9876543210', password: PASSWORD, registrationSource: 'mobile' },
      });
    const r1 = await register('one');
    c.check('the first student under an open policy is approved (1 of 1)', r1.status === 201 && r1.json?.status === 'approved', brief(r1));
    const r2 = await register('two');
    c.check('the second is NOT refused: created as pending, with no numbers in the response',
      r2.status === 201 && r2.json?.status === 'pending' && !/limit|PLAN_LIMIT/i.test(r2.raw), brief(r2));
    c.check('...so the organization still has exactly 1 approved student', (await count(REG, 'student')) === 1);
    const heldUser = await col('users').findOne({ email: `${RUN}-reg-two@example.test` });
    const approveHeld = await call('PUT', `/api/users/${heldUser?._id}/approve`, { token: admin.REG, body: { empCode: `${RUN}-HELD` } });
    c.check('approving the held registration is refused while full (402)', approveHeld.status === 402, brief(approveHeld));

    // ── App builds ────────────────────────────────────────────────────────
    c.section('app builds per month (counting rules and the gate)');
    const build = (status: string, extra: Record<string, unknown> = {}) => ({
      orgId: oid(L), organizationSlug: `${RUN}-l`, platform: 'android', artifactType: 'aab', buildProfile: 'p', appProfile: 'production',
      buildNumber: Math.floor(Math.random() * 1e6), status, requestedBy: oid(String(owner._id)), queuedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), ...extra,
    });
    await col('appbuildjobs').insertMany([
      build('failed'), // failed before EAS: not counted
      build('cancelled'), // cancelled before EAS: not counted
      build('failed', { easBuildId: 'eas-1' }), // reached EAS: counted
      build('completed', { queuedAt: new Date(Date.now() - 45 * 86400000) }), // last month: not counted
    ]);
    c.check('only a build that reached EAS this month counts (1 of 4 rows)', (await usage.currentUsage(L, 'appBuildsMonthly')) === 1);
    let refused: unknown = null;
    try {
      await usage.withCapacity({ orgId: L, resource: 'appBuildsMonthly', run: async () => 'built' });
    } catch (e) {
      refused = e;
    }
    c.check('the next build is refused at a limit of 1 (PLAN_LIMIT_REACHED)', (refused as { code?: string })?.code === 'PLAN_LIMIT_REACHED');
    await setLimits(L, { students: 3, teachers: 2, admins: 2, aiGenerationsMonthly: 2, appBuildsMonthly: 2 });
    const racers = await Promise.allSettled(
      ['apk', 'aab', 'apk', 'aab'].map((artifactType, i) =>
        usage.withCapacity({ orgId: L, resource: 'appBuildsMonthly', run: async () => col('appbuildjobs').insertOne(build('completed', { artifactType, buildNumber: 9000 + i })) }),
      ),
    );
    c.check('four simultaneous builds for one remaining slot: exactly one created',
      racers.filter((r) => r.status === 'fulfilled').length === 1 && (await usage.currentUsage(L, 'appBuildsMonthly')) === 2, racers.map((r) => r.status).join(','));
    const ownedBuild = await usage.withCapacity({ orgId: OWNED, resource: 'appBuildsMonthly', run: async () => 'built' });
    c.check('a platform-owned organization\'s builds are not limited', ownedBuild === 'built');

    // ── AI generations ────────────────────────────────────────────────────
    c.section('AI generations per month');
    const refine = (token: string) => call('POST', '/api/ai/refine', { token, body: { question: { text: 'What is 2+2?', type: 'short' } } });
    model.state.mode = 'ok';
    const g1 = await refine(admin.L);
    c.check('a successful generation is counted (1 of 2)', g1.status === 200 && (await usage.currentUsage(L, 'aiGenerationsMonthly')) === 1, brief(g1));
    model.state.mode = 'fail';
    const gFail = await refine(admin.L);
    await sleep(150);
    c.check('a failed generation is refunded (still 1 of 2)', gFail.status >= 400 && (await usage.currentUsage(L, 'aiGenerationsMonthly')) === 1, brief(gFail));
    model.state.mode = 'ok';
    const g2 = await refine(admin.L);
    const g3 = await refine(admin.L);
    c.check('the second succeeds and the third is refused: 402, aiGenerationsMonthly',
      g2.status === 200 && g3.status === 402 && g3.json?.resource === 'aiGenerationsMonthly' && g3.json?.current === 2, `${brief(g2)} | ${brief(g3)}`);
    const callsBefore = model.state.calls;
    await refine(admin.L);
    c.check('a refused generation never reaches the model', model.state.calls === callsBefore);
    await setLimits(L, { students: 3, teachers: 2, admins: 2, aiGenerationsMonthly: 4, appBuildsMonthly: 2 });
    const aiBurst = await Promise.all(Array.from({ length: 5 }, () => refine(admin.L)));
    c.check('five simultaneous generations for two remaining: exactly two run, three refused',
      aiBurst.filter((r) => r.status === 200).length === 2 && aiBurst.filter((r) => r.status === 402).length === 3 && (await usage.currentUsage(L, 'aiGenerationsMonthly')) === 4,
      aiBurst.map((r) => r.status).join(','));

    await setLimits(L, { students: 3, teachers: 2, admins: 2, aiGenerationsMonthly: 10, appBuildsMonthly: 2 });
    const job = await multipart(app.port, '/api/ai/ai-generate/pdf', admin.L, { async: 'true', subject: 'Physics', class: '11', count: '2' }, { field: 'file', name: 'broken.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 not really a pdf') });
    let jobState: Res | null = null;
    for (let i = 0; i < 40 && job.json?.data?.jobId; i++) {
      await sleep(250);
      jobState = await call('GET', `/api/ai/ai-generate/jobs/${job.json.data.jobId}`, { token: admin.L });
      if (['failed', 'completed'].includes(String(jobState.json?.data?.status ?? jobState.json?.status))) break;
    }
    await sleep(300);
    c.check('an async job is accepted (202) and, when it fails, refunded (usage back to 4)',
      job.status === 202 && (await usage.currentUsage(L, 'aiGenerationsMonthly')) === 4, `${brief(job)} | ${jobState ? brief(jobState) : 'no state'}`);
    const ledger = await col('usagerecords').find({ orgId: oid(L), meter: 'aiGenerationsMonthly' }).toArray();
    const refunds = ledger.filter((r) => r.kind === 'refund');
    c.check('the ledger: every refund names a reservation, none twice',
      refunds.every((r) => ledger.some((x) => String(x._id) === String(r.refundOf))) && new Set(refunds.map((r) => String(r.refundOf))).size === refunds.length);
    c.check('...and the async job\'s reservation names the job', ledger.some((r) => r.kind === 'reservation' && r.subject?.type === 'ImportBatch' && r.subject?.id === job.json?.data?.jobId));
    const resv = ledger.find((r) => r.kind === 'reservation' && !refunds.some((x) => String(x.refundOf) === String(r._id)));
    const again1 = await usage.refundMetered(String(resv?._id), 'test');
    const again2 = await usage.refundMetered(String(resv?._id), 'test');
    c.check('refunding one reservation twice refunds it once', again1 === true && again2 === false);

    // Async race: a job that fails before its reservation is linked.
    const early = await usage.reserveMetered({ orgId: L, resource: 'aiGenerationsMonthly' });
    const failedJob = await col('importbatches').insertOne({ kind: 'ai-generate', status: 'failed', orgId: L, fileName: 'x', createdAt: new Date() });
    await usage.attachSubject(early.id, { type: 'ImportBatch', id: String(failedJob.insertedId) });
    c.check('a job that failed before it was linked is refunded when it is linked', (await col('usagerecords').countDocuments({ refundOf: oid(early.id) })) === 1);

    c.section('modules: generation needs AI, the question bank does not');
    const bAi = await refine(admin.B);
    c.check('Starter (no AI) is refused generation: 403 MODULE_NOT_ENABLED, and nothing is metered',
      bAi.status === 403 && bAi.json?.code === 'MODULE_NOT_ENABLED' && (await col('usagerecords').countDocuments({ orgId: oid(B) })) === 0, brief(bAi));
    const bBank = await call('GET', '/api/ai/questions/class/11', { token: admin.B });
    c.check('...but reaches its own class question bank (was refused when /api/ai was gated as a whole)', bBank.json?.code !== 'MODULE_NOT_ENABLED' && bBank.status < 500, brief(bBank));
    const bTeacherAi = await call('POST', '/api/teacher/ai/generate', { token: admin.B, body: { feature: 'question_paper', prompt: 'x' } });
    c.check('...and the AI content generator is gated too (it was not before)', bTeacherAi.status === 403 && bTeacherAi.json?.code === 'MODULE_NOT_ENABLED', brief(bTeacherAi));
    const bHistory = await call('GET', '/api/teacher/ai/history', { token: admin.B });
    c.check('...while reading previously generated content is not', bHistory.status === 200, brief(bHistory));

    // ── Isolation ─────────────────────────────────────────────────────────
    c.section('tenant isolation');
    const lStudents = (await used(L, 'students'))?.used;
    const bStudentsNow = (await used(B, 'students'))?.used;
    c.check('each organization counts only its own students', lStudents === (await count(L, 'student')) && bStudentsNow === (await count(B, 'student')));
    const hop = await call('GET', '/api/org-admin/plan', { token: admin.B, headers: { 'X-Org-Id': L } });
    c.check('naming another organization does not show its usage', hop.status >= 400 && hop.status < 500, brief(hop));
    const bRefusal = (await call('POST', '/api/users', { token: admin.L, body: person('student') })).json;
    c.check('a refusal carries only the caller\'s numbers', !JSON.stringify(bRefusal ?? {}).includes(B));

    // ── The lease ─────────────────────────────────────────────────────────
    c.section('the lease');
    await col('usagelocks').updateOne({ orgId: NOSUB, resource: 'students' }, { $set: { holder: 'stuck', expiresAt: new Date(Date.now() + 60000) } }, { upsert: true });
    await setLimits(NOSUB, { students: 50 });
    await call('POST', `/api/platform/orgs/${NOSUB}/subscription/trial`, { token: BILLING, body: { planKey: 'starter', reason: 'start' } });
    const busy = await create(admin.NOSUB);
    c.check('a held lease answers 503 USAGE_CHECK_BUSY and creates nothing', busy.status === 503 && busy.json?.code === 'USAGE_CHECK_BUSY', brief(busy));
    await col('usagelocks').updateOne({ orgId: NOSUB, resource: 'students' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    c.check('an expired lease is taken over: the next creation goes through', (await create(admin.NOSUB)).status === 201);

    // ── Phase 5: the sweep ────────────────────────────────────────────────
    c.section('the lifecycle sweep is safe to run twice at once');
    await col('subscriptions').updateOne({ orgId: oid(SWEEP) }, { $set: { trialEndsAt: new Date(Date.now() - 30 * 86400000) } });
    await Promise.all([runLifecycleSweep(new Date()), runLifecycleSweep(new Date())]);
    const sweepEvents = await col('subscriptionevents').find({ orgId: oid(SWEEP), 'actor.kind': 'system' }).toArray();
    c.check('two simultaneous sweeps: each step recorded exactly once',
      sweepEvents.map((e) => e.type).sort().join(',') === 'grace_ended,trial_ended', sweepEvents.map((e) => e.type).join(','));

    c.section('platform-owned organizations cannot be changed by accident');
    for (const [label, method, path, body] of [
      ['a trial', 'POST', `/api/platform/orgs/${OWNED}/subscription/trial`, { reason: 'oops', days: 3 }],
      ['a plan change', 'POST', `/api/platform/orgs/${OWNED}/subscription/plan`, { planKey: 'starter', reason: 'oops' }],
      ['a cancellation', 'POST', `/api/platform/orgs/${OWNED}/subscription/transition`, { event: 'cancel', reason: 'oops' }],
      ['an expiry', 'POST', `/api/platform/orgs/${OWNED}/subscription/transition`, { event: 'expire', reason: 'oops' }],
      ['a payment', 'POST', `/api/platform/orgs/${OWNED}/payments`, { amount: 1, method: 'cash', reference: `${RUN}-O1` }],
      ['a failed payment', 'POST', `/api/platform/orgs/${OWNED}/payments/failed`, { reference: `${RUN}-O2`, reason: 'oops' }],
      ['an editor status', 'PUT', `/api/platform/orgs/${OWNED}/subscription`, { status: 'suspended' }],
      ['bringing it under the lifecycle', 'POST', `/api/platform/orgs/${OWNED}/subscription/manage`, { reason: 'oops' }],
    ] as const) {
      const r = await call(method, path, { token: BILLING, body });
      c.check(`${label}: 409 PLATFORM_OWNED`, r.status === 409 && r.json?.code === 'PLATFORM_OWNED', brief(r));
    }
    const unflag = await call('PUT', `/api/platform/orgs/${OWNED}/subscription`, { token: BILLING, body: { isPlatformOwned: false } });
    c.check('clearing the subscription\'s flag does not unprotect an organization flagged on its record', unflag.status === 200 && (await call('GET', `/api/platform/orgs/${OWNED}/entitlement`, { token: SUPPORT })).json?.entitlement?.modules?.includes('ai'));
  } finally {
    try {
      model.server.close();
      clearOrgStateCache?.();
      const name = mongoose.connection.db.databaseName;
      if (/^iso_[a-z0-9_]*_scratch_usage$/.test(name)) await mongoose.connection.db.dropDatabase();
    } catch (error) {
      console.error('cleanup failed:', (error as Error).message);
    }
    await app.close();
  }
  c.report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
