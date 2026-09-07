/**
 * Org 002 custom roles, end to end against real data.
 *
 * The unit suite proves the permission ALGEBRA. This proves the whole chain:
 * real Role documents in Mongo, a real Express app, real HTTP requests, real
 * middleware ordering, and a real platform route rejecting a tenant token.
 *
 * Creates ABC Coaching with a Centre Manager and a Counsellor, exercises what
 * each may and may not do, and removes the fixture.
 *
 * Scratch database only — the same guard every write tool here uses.
 *
 *   npx ts-node --transpile-only scripts/safety/custom-roles.e2e.test.ts \
 *     --scratch-suffix restore_2026_08_17
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { config } from 'dotenv';
import { assertNotProduction, configureDnsForSrv, redactUri, requireEnv } from './lib';

config();

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] ?? null : null;
}

function deriveScratchUri(productionUri: string, suffix: string): string {
  const m = productionUri.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/);
  if (!m) throw new Error('MONGO_URI could not be parsed.');
  return `${m[1]}${m[2]}_${suffix}${m[3] ?? ''}`;
}

const MARKER = 'zz-rbac-e2e';
const PASSWORD = 'Rbac!E2E-Passw0rd';

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

interface Res { status: number; json: unknown; raw: string }

function request(port: number, method: string, path: string, token?: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1', port, method, path, timeout: 20000,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed: unknown = null;
          try { parsed = JSON.parse(raw); } catch { /* status is what matters */ }
          resolve({ status: res.statusCode ?? 0, json: parsed, raw });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`timeout ${method} ${path}`)); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const productionUri = requireEnv('MONGO_URI');
  const suffix = arg('--scratch-suffix');
  if (!suffix) {
    console.error('Usage: custom-roles.e2e.test.ts --scratch-suffix <suffix>');
    process.exit(2);
  }
  const uri = deriveScratchUri(productionUri, suffix);
  assertNotProduction(uri, productionUri);

  configureDnsForSrv();
  process.env.MONGO_URI = uri;
  process.env.TENANT_MODE = 'claim';
  process.env.TENANT_ENFORCEMENT = 'warn';
  process.env.ENABLE_CRON = 'false';
  process.env.PPT_WORKER_EMBEDDED = 'false';
  process.env.REDIS_ENABLED = 'false';
  process.on('unhandledRejection', () => { /* mirrors server.ts tolerance */ });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registerTenancy } = require('../../src/core/tenancy');
  registerTenancy();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mongoose = require('mongoose');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { withoutTenantScope, runWithTenant } = require('../../src/core/tenancy/context');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Org = require('../../src/models/Org').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const User = require('../../src/models/User').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Role = require('../../src/models/Role').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const PlatformUser = require('../../src/models/PlatformUser').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { provisionSystemRoles, createCustomRole, assignRoles } = require('../../src/core/rbac/provisionRoles');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { signTenantToken, signPlatformToken } = require('../../src/core/auth/tokens');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolveUserPermissions } = require('../../src/core/rbac/resolve');

  console.log(`[rbac-e2e] target: ${redactUri(uri)}\n`);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const app = require('../../src/app').default;
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  let orgId: string | null = null;
  let platformId: string | null = null;

  try {
    // ── Fixture ───────────────────────────────────────────────────────────
    const org = await withoutTenantScope('e2e:create-org', async () => {
      const found = await Org.findOne({ slug: 'abc-rbac' });
      if (found) return found;
      return Org.create({ name: 'ABC Coaching Institute', slug: 'abc-rbac', status: 'active' });
    });
    orgId = String(org._id);

    const provisioned = await provisionSystemRoles(orgId);
    check(
      `system roles provisioned (${provisioned.created.length + provisioned.existing.length} of 5)`,
      provisioned.created.length + provisioned.existing.length === 5,
    );

    const cmRole = await createCustomRole(orgId, {
      key: 'centre_manager',
      name: 'Centre Manager',
      permissions: ['students.read', 'students.create', 'students.update', 'schedule.read', 'schedule.manage'],
    });
    const coRole = await createCustomRole(orgId, {
      key: 'counsellor',
      name: 'Counsellor',
      permissions: ['students.read'],
    });
    check('Centre Manager role created with 5 permissions', cmRole.granted.length === 5);
    check('Counsellor role created with 1 permission', coRole.granted.length === 1);

    // A tenant cannot mint authority that does not exist in the vocabulary.
    const sneaky = await createCustomRole(orgId, {
      key: 'sneaky',
      name: 'Sneaky',
      permissions: ['platform.manage', 'billing.manage', 'students.read'],
    });
    check(
      'invented permissions are REJECTED at role creation',
      sneaky.granted.length === 1 && sneaky.rejected.length === 2,
      `granted=${sneaky.granted.join(',')} rejected=${sneaky.rejected.join(',')}`,
    );

    // Users
    const [cmUser, coUser] = await runWithTenant({ orgId, source: 'test' }, async () => {
      await User.deleteMany({ email: new RegExp(MARKER) });
      return Promise.all([
        User.create({ name: 'CM', email: `${MARKER}-cm@abc.test`, password: PASSWORD, role: 'teacher', status: 'approved' }),
        User.create({ name: 'CO', email: `${MARKER}-co@abc.test`, password: PASSWORD, role: 'teacher', status: 'approved' }),
      ]);
    });
    await assignRoles(String(cmUser._id), [cmRole.id]);
    await assignRoles(String(coUser._id), [coRole.id]);

    // ── Resolution from real documents ────────────────────────────────────
    console.log('\npermission resolution from real Role documents');
    const cmFresh = await withoutTenantScope('e2e:read-cm', () => User.findById(cmUser._id).lean());
    const coFresh = await withoutTenantScope('e2e:read-co', () => User.findById(coUser._id).lean());

    const cmAccess = await resolveUserPermissions({ ...cmFresh, orgId });
    const coAccess = await resolveUserPermissions({ ...coFresh, orgId });

    check('Centre Manager resolves from roles', cmAccess.source === 'roles');
    check('  can update students', cmAccess.permissions.has('students.update'));
    check('  can manage schedule', cmAccess.permissions.has('schedule.manage'));
    check('  CANNOT publish exams', !cmAccess.permissions.has('exams.publish'));
    check(
      '  narrow role REVOKES the broad legacy teacher grant',
      !cmAccess.permissions.has('exams.create'),
    );

    check('Counsellor resolves from roles', coAccess.source === 'roles');
    check('  can read students', coAccess.permissions.has('students.read'));
    check('  CANNOT update students', !coAccess.permissions.has('students.update'));
    check('  holds exactly one permission', coAccess.permissions.size === 1);

    // A legacy Abhigyan user with no roles keeps their existing access.
    const legacyAccess = await resolveUserPermissions({ role: 'teacher', roleIds: [], orgId });
    check(
      'a user with NO roles still gets the legacy teacher grant',
      legacyAccess.source === 'legacy-role' && legacyAccess.permissions.has('exams.create'),
      'this is what keeps every existing Abhigyan account working',
    );

    // ── Platform route rejection over real HTTP ───────────────────────────
    console.log('\nplatform routes reject tenant tokens (over HTTP)');
    const cmToken = signTenantToken({ id: String(cmUser._id), orgId, role: 'teacher', tokenVersion: 0 });

    const platformMe = await request(port, 'GET', '/api/platform/me', cmToken);
    check(
      'tenant token -> /api/platform/me is DENIED',
      platformMe.status === 403,
      `got ${platformMe.status} — expected 403 TOKEN_AUDIENCE_MISMATCH`,
    );
    check(
      '  and the reason is the audience, not a permission',
      (platformMe.json as { code?: string })?.code === 'TOKEN_AUDIENCE_MISMATCH',
      JSON.stringify(platformMe.json).slice(0, 120),
    );

    const platformOrgs = await request(port, 'GET', '/api/platform/orgs', cmToken);
    check('tenant token -> /api/platform/orgs is DENIED', platformOrgs.status === 403);

    const noToken = await request(port, 'GET', '/api/platform/orgs');
    check('no token -> /api/platform/orgs is DENIED', noToken.status === 401);

    // ── A real platform token works, and respects capabilities ───────────
    console.log('\nplatform token behaviour');
    const staff = await withoutTenantScope('e2e:create-staff', async () => {
      await PlatformUser.deleteMany({ email: `${MARKER}-staff@platform.test` });
      return PlatformUser.create({
        name: 'Support Staff', email: `${MARKER}-staff@platform.test`,
        password: PASSWORD, role: 'support', isActive: true,
      });
    });
    platformId = String(staff._id);

    const staffToken = signPlatformToken({ id: platformId, role: 'support', tokenVersion: 0 });
    const meOk = await request(port, 'GET', '/api/platform/me', staffToken);
    check('platform token -> /api/platform/me succeeds', meOk.status === 200, `got ${meOk.status}`);

    const orgsOk = await request(port, 'GET', '/api/platform/orgs', staffToken);
    check('support can READ organizations', orgsOk.status === 200, `got ${orgsOk.status}`);

    // support has org.read + impersonate + audit.read, but NOT subscription.manage
    const billingToken = signPlatformToken({ id: platformId, role: 'support', tokenVersion: 0 });
    void billingToken;
    check(
      'support role does NOT carry subscription.manage',
      !(meOk.json as { platformUser?: { capabilities: string[] } })?.platformUser?.capabilities.includes('subscription.manage'),
      JSON.stringify((meOk.json as { platformUser?: unknown })?.platformUser),
    );

    // Revocation
    await withoutTenantScope('e2e:revoke', () =>
      PlatformUser.updateOne({ _id: platformId }, { $set: { tokenVersion: 1 } }),
    );
    const revoked = await request(port, 'GET', '/api/platform/me', staffToken);
    check(
      'bumping tokenVersion REVOKES an outstanding platform token',
      revoked.status === 401 && (revoked.json as { code?: string })?.code === 'TOKEN_REVOKED',
      `got ${revoked.status} ${JSON.stringify(revoked.json).slice(0, 80)}`,
    );
  } finally {
    try {
      await withoutTenantScope('e2e:cleanup', async () => {
        const u = await User.deleteMany({ email: new RegExp(MARKER) });
        await Role.deleteMany({ orgId });
        await PlatformUser.deleteMany({ email: new RegExp(MARKER) });
        if (orgId) await Org.deleteOne({ _id: orgId });
        console.log(`\n  cleaned up ${u.deletedCount} user(s), roles, staff and the org`);
      });
    } catch (error) {
      console.error('  cleanup failed:', (error as Error).message);
    }
    await new Promise<void>((r) => server.close(() => r()));
    await mongoose.connection.close();
  }

  console.log('');
  if (failures) {
    console.error(`CUSTOM-ROLE E2E FAILED — ${failures} of ${checks}.`);
    process.exit(1);
  }
  console.log(`All ${checks} custom-role e2e checks passed.`);
  process.exit(0);
}

main().catch((error) => {
  console.error('[rbac-e2e] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
