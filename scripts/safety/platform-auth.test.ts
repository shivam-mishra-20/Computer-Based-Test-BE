/**
 * Platform login and owner bootstrap, against the REAL app and a real database.
 *
 * ── Why this boots the actual Express app ───────────────────────────────────
 * The two things being tested are both about the DOOR: which credentials get
 * in, and which are turned away. A unit test of the handler would pass with the
 * route mounted in the wrong place — below `router.use(platformAuthMiddleware)`
 * instead of above it — which would make login itself require a login. Only the
 * assembled app can catch that, so the app is what runs.
 *
 * Scratch database only. `assertNotProduction` refuses anything else.
 *
 *   P10A_MONGO_URI=<scratch> node -r ./scripts/safety/dns-preload.js \
 *     -r ts-node/register/transpile-only scripts/safety/platform-auth.test.ts
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { execFileSync } from 'child_process';
import 'dotenv/config';
import mongoose from 'mongoose';

process.env.ENABLE_CRON = 'false';
process.env.PPT_WORKER_EMBEDDED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.TENANT_MODE = 'claim';
process.env.TENANT_ENFORCEMENT = 'warn';

import { registerTenancy, withoutTenantScope } from '../../src/core/tenancy';
import { assertNotProduction } from './lib';
import { signPlatformToken, signLegacyToken } from '../../src/core/auth/tokens';

process.on('unhandledRejection', (reason) => {
  console.warn('  ⚠ unhandled rejection:', reason instanceof Error ? reason.message : reason);
});

const MARKER = 'p10a';
const OWNER = {
  email: `${MARKER}-owner@platform.test`,
  name: 'P10A Owner',
  password: 'a-long-enough-bootstrap-password',
};
const SUPPORT = { email: `${MARKER}-support@platform.test`, password: 'support-password-long' };

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

function eq<T>(label: string, actual: T, expected: T) {
  check(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

function request(
  port: number,
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? null : JSON.stringify(options.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        timeout: 15000,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(raw);
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode ?? 0, body, raw });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Run the bootstrap script as a real subprocess, as an operator would. */
function runBootstrap(
  env: Record<string, string>,
  args: string[],
): { ok: boolean; output: string } {
  try {
    const output = execFileSync(
      'npx',
      ['ts-node', '--transpile-only', 'scripts/bootstrap-platform-owner.ts', ...args],
      {
        env: { ...process.env, ...env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      },
    );
    return { ok: true, output };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

async function main() {
  const uri = process.env.P10A_MONGO_URI;
  if (!uri) throw new Error('P10A_MONGO_URI must name a scratch database.');
  assertNotProduction(uri, process.env.MONGO_URI as string);

  const suffix = uri.split('/').pop()!.split('?')[0].replace(/^[^_]*_/, '');

  registerTenancy();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const PlatformUser = require('../../src/models/PlatformUser').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const PlatformAudit = require('../../src/models/PlatformAudit').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Org = require('../../src/models/Org').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const User = require('../../src/models/User').default;

  /**
   * Clears EVERY platform account, not just this suite's.
   *
   * The bootstrap's central refusal is "an owner already exists, use the
   * console" — so testing that it creates the first one requires there to be
   * no owner at all. A marker-scoped delete leaves P5's test accounts behind
   * and the suite then tests only the refusal, never the creation.
   *
   * Safe because `assertNotProduction` has already refused anything that is not
   * a dedicated scratch database, and this suite expects its own — see the
   * usage note in the header.
   */
  const cleanup = async () => {
    await withoutTenantScope('p10a:cleanup', async () => {
      await PlatformUser.deleteMany({});
      await PlatformAudit.deleteMany({ actorEmail: new RegExp(`^${MARKER}-`) });
    });
  };

  // The app must be required AFTER registerTenancy so models compile with the
  // plugin — the same ordering `verify-tenant-coverage` enforces.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const app = require('../../src/app').default;
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    await cleanup();

    // ══════════════════════════════════════════════════════════════════════
    console.log('\nBOOTSTRAP — the deadlock breaker');
    // ══════════════════════════════════════════════════════════════════════

    const orgsBefore = await withoutTenantScope('p10a:count', () => Org.countDocuments());
    const usersBefore = await withoutTenantScope('p10a:count', () => User.countDocuments());

    // ── Refusals, before anything is created ──────────────────────────────
    const noTarget = runBootstrap({}, []);
    check('refuses with no target', !noTarget.ok && /Refusing to guess a target/.test(noTarget.output));

    const noAck = runBootstrap(
      { PLATFORM_OWNER_EMAIL: OWNER.email, PLATFORM_OWNER_NAME: OWNER.name },
      ['--production'],
    );
    check(
      'refuses production without the typed acknowledgement',
      !noAck.ok && /explicit acknowledgement/.test(noAck.output),
      noAck.output.slice(0, 120),
    );

    const noCreds = runBootstrap({}, ['--scratch-suffix', suffix]);
    check(
      'refuses without an email',
      !noCreds.ok && /PLATFORM_OWNER_EMAIL/.test(noCreds.output),
      noCreds.output.slice(0, 120),
    );

    const shortPassword = runBootstrap(
      {
        PLATFORM_OWNER_EMAIL: OWNER.email,
        PLATFORM_OWNER_NAME: OWNER.name,
        PLATFORM_OWNER_PASSWORD: 'short',
      },
      ['--scratch-suffix', suffix],
    );
    check(
      'refuses a password below the minimum length',
      !shortPassword.ok && /at least 12 characters/.test(shortPassword.output),
      shortPassword.output.slice(0, 140),
    );

    // ── The real bootstrap ────────────────────────────────────────────────
    const created = runBootstrap(
      {
        PLATFORM_OWNER_EMAIL: OWNER.email,
        PLATFORM_OWNER_NAME: OWNER.name,
        PLATFORM_OWNER_PASSWORD: OWNER.password,
      },
      ['--scratch-suffix', suffix],
    );
    check('creates the first owner', created.ok && /created platform owner/.test(created.output), created.output.slice(0, 200));
    check(
      'and NEVER prints the password',
      !created.output.includes(OWNER.password),
      'the password appeared in the script output',
    );

    const owner = await withoutTenantScope('p10a:find', () =>
      PlatformUser.findOne({ email: OWNER.email }).lean(),
    );
    check('the account exists', Boolean(owner));
    eq('with the owner role', owner?.role, 'owner');
    check('and is active', owner?.isActive === true);
    check(
      'the password is stored HASHED, never in clear',
      typeof owner?.password === 'string' &&
        owner.password !== OWNER.password &&
        owner.password.startsWith('$2'),
      String(owner?.password).slice(0, 12),
    );
    eq('tokenVersion starts at 0', owner?.tokenVersion, 0);

    // ── What it must NOT have touched ─────────────────────────────────────
    const orgsAfter = await withoutTenantScope('p10a:count', () => Org.countDocuments());
    const usersAfter = await withoutTenantScope('p10a:count', () => User.countDocuments());
    eq('no organization was created', orgsAfter, orgsBefore);
    eq('no tenant user was created', usersAfter, usersBefore);
    check(
      'the platform account has no orgId — staff belong to no organization',
      !(owner as Record<string, unknown>)?.orgId,
      String((owner as Record<string, unknown>)?.orgId),
    );

    const auditRow = await withoutTenantScope('p10a:audit', () =>
      PlatformAudit.findOne({ action: 'platform.owner.bootstrap', actorEmail: OWNER.email }).lean(),
    );
    check('the bootstrap is recorded in the platform audit trail', Boolean(auditRow));

    // ── Idempotence, and the refusal to mint a second owner ───────────────
    const again = runBootstrap(
      {
        PLATFORM_OWNER_EMAIL: OWNER.email,
        PLATFORM_OWNER_NAME: OWNER.name,
        PLATFORM_OWNER_PASSWORD: OWNER.password,
      },
      ['--scratch-suffix', suffix],
    );
    check('running it twice reports "already exists"', again.ok && /already exists/.test(again.output));
    eq(
      'and creates no second account',
      await withoutTenantScope('p10a:count', () => PlatformUser.countDocuments({ email: OWNER.email })),
      1,
    );

    const secondOwner = runBootstrap(
      {
        PLATFORM_OWNER_EMAIL: `${MARKER}-other@platform.test`,
        PLATFORM_OWNER_NAME: 'Other',
        PLATFORM_OWNER_PASSWORD: 'another-long-password',
      },
      ['--scratch-suffix', suffix],
    );
    check(
      'refuses a DIFFERENT owner once one exists — use the console instead',
      !secondOwner.ok && /already exists|deadlock is/.test(secondOwner.output),
      secondOwner.output.slice(0, 160),
    );

    // ══════════════════════════════════════════════════════════════════════
    console.log('\nLOGIN — valid credentials');
    // ══════════════════════════════════════════════════════════════════════

    const ok = await request(port, 'POST', '/api/platform/login', {
      body: { email: OWNER.email, password: OWNER.password },
    });
    eq('200', ok.status, 200);
    check('returns a token', typeof ok.body.token === 'string' && (ok.body.token as string).length > 40);
    const token = ok.body.token as string;

    const user = ok.body.user as Record<string, unknown>;
    eq('returns the role', user?.role, 'owner');
    eq('returns the email', user?.email, OWNER.email);
    check('returns capabilities', Array.isArray(user?.capabilities) && (user.capabilities as unknown[]).length > 0);
    check(
      'owner receives every platform capability',
      (user.capabilities as string[]).includes('staff.manage') &&
        (user.capabilities as string[]).includes('org.manage') &&
        (user.capabilities as string[]).includes('org.read'),
      (user.capabilities as string[]).join(','),
    );

    // ── The thing that must never leak ────────────────────────────────────
    check('the response contains NO password field', !('password' in (user ?? {})));
    check(
      'and no password hash anywhere in the raw body',
      !ok.raw.includes('$2b$') && !ok.raw.includes('$2a$'),
      ok.raw.slice(0, 160),
    );
    check('no tokenVersion is exposed', !('tokenVersion' in (user ?? {})));

    // ── The audience is what makes the boundary structural ────────────────
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    eq('the token audience is `platform`', payload.aud, 'platform');
    check('it carries no orgId — platform staff belong to no organization', !('orgId' in payload));
    eq('it carries tokenVersion for revocation', payload.tokenVersion, 0);

    // ══════════════════════════════════════════════════════════════════════
    console.log('\nLOGIN — refusals');
    // ══════════════════════════════════════════════════════════════════════

    const wrongPassword = await request(port, 'POST', '/api/platform/login', {
      body: { email: OWNER.email, password: 'not-the-password' },
    });
    eq('wrong password -> 401', wrongPassword.status, 401);

    const unknown = await request(port, 'POST', '/api/platform/login', {
      body: { email: `${MARKER}-nobody@platform.test`, password: OWNER.password },
    });
    eq('unknown user -> 401', unknown.status, 401);

    // ── No account oracle ─────────────────────────────────────────────────
    eq(
      'an unknown account and a wrong password are INDISTINGUISHABLE',
      unknown.body.message,
      wrongPassword.body.message,
    );

    for (const [label, body] of [
      ['no body', undefined],
      ['empty object', {}],
      ['missing password', { email: OWNER.email }],
      ['missing email', { password: OWNER.password }],
      ['non-string email', { email: 12345, password: OWNER.password }],
      ['object injection', { email: { $ne: null }, password: { $ne: null } }],
    ] as [string, unknown][]) {
      const reply = await request(port, 'POST', '/api/platform/login', { body });
      check(`malformed (${label}) -> 400, not a crash`, reply.status === 400, `got ${reply.status}`);
    }

    const longPassword = await request(port, 'POST', '/api/platform/login', {
      body: { email: OWNER.email, password: 'x'.repeat(5000) },
    });
    eq('an oversized password is rejected before bcrypt runs', longPassword.status, 400);

    // ── Inactive accounts ─────────────────────────────────────────────────
    await withoutTenantScope('p10a:disable', () =>
      PlatformUser.updateOne({ email: OWNER.email }, { $set: { isActive: false } }),
    );
    const disabled = await request(port, 'POST', '/api/platform/login', {
      body: { email: OWNER.email, password: OWNER.password },
    });
    eq('a disabled account cannot log in', disabled.status, 401);
    eq(
      'and is indistinguishable from a wrong password',
      disabled.body.message,
      wrongPassword.body.message,
    );
    await withoutTenantScope('p10a:enable', () =>
      PlatformUser.updateOne({ email: OWNER.email }, { $set: { isActive: true } }),
    );

    // ══════════════════════════════════════════════════════════════════════
    console.log('\nTHE TOKEN OPENS THE PLATFORM, AND ONLY THE PLATFORM');
    // ══════════════════════════════════════════════════════════════════════

    const me = await request(port, 'GET', '/api/platform/me', { token });
    eq('the issued token authenticates a platform route', me.status, 200);

    const noToken = await request(port, 'GET', '/api/platform/me');
    eq('no token -> 401', noToken.status, 401);

    const garbage = await request(port, 'GET', '/api/platform/me', { token: 'x'.repeat(60) });
    eq('a garbage token -> 401', garbage.status, 401);

    // ── A tenant token must not open the console ──────────────────────────
    const tenantToken = signLegacyToken({ id: String(new mongoose.Types.ObjectId()), role: 'admin' });
    const tenantAtPlatform = await request(port, 'GET', '/api/platform/me', { token: tenantToken });
    check(
      'a TENANT token is refused at the platform door',
      tenantAtPlatform.status === 403 || tenantAtPlatform.status === 401,
      `got ${tenantAtPlatform.status}`,
    );

    // ── And a platform token must not open a tenant route ─────────────────
    const tenantRoute = await request(port, 'GET', '/api/me/context', { token });
    eq('a PLATFORM token is refused on a tenant route', tenantRoute.status, 403);
    eq('with the audience code', tenantRoute.body.code, 'TOKEN_AUDIENCE_MISMATCH');

    // ── Login itself must not require a login ─────────────────────────────
    // The route is declared ABOVE `router.use(platformAuthMiddleware)`. If it
    // were moved below, this returns 401 and the console can never be used.
    const loginUnauthenticated = await request(port, 'POST', '/api/platform/login', {
      body: { email: OWNER.email, password: OWNER.password },
    });
    eq('POST /platform/login needs no credential of its own', loginUnauthenticated.status, 200);

    // ══════════════════════════════════════════════════════════════════════
    console.log('\nREVOCATION');
    // ══════════════════════════════════════════════════════════════════════

    await withoutTenantScope('p10a:revoke', () =>
      PlatformUser.updateOne({ email: OWNER.email }, { $inc: { tokenVersion: 1 } }),
    );
    const revoked = await request(port, 'GET', '/api/platform/me', { token });
    eq('bumping tokenVersion revokes an outstanding token immediately', revoked.status, 401);
    eq('and says why', revoked.body.code, 'TOKEN_REVOKED');

    const reissued = await request(port, 'POST', '/api/platform/login', {
      body: { email: OWNER.email, password: OWNER.password },
    });
    eq('logging in again issues a token that works', reissued.status, 200);
    const freshMe = await request(port, 'GET', '/api/platform/me', {
      token: reissued.body.token as string,
    });
    eq('the reissued token authenticates', freshMe.status, 200);

    // ══════════════════════════════════════════════════════════════════════
    console.log('\nCAPABILITY FILTERING — a support account is not an owner');
    // ══════════════════════════════════════════════════════════════════════

    await withoutTenantScope('p10a:support', async () => {
      const existing = await PlatformUser.findOne({ email: SUPPORT.email });
      if (!existing) {
        const account = new PlatformUser({
          name: 'P10A Support',
          email: SUPPORT.email,
          password: SUPPORT.password,
          role: 'support',
          isActive: true,
        });
        await account.save();
      }
    });

    const supportLogin = await request(port, 'POST', '/api/platform/login', {
      body: { email: SUPPORT.email, password: SUPPORT.password },
    });
    eq('support can log in', supportLogin.status, 200);
    const supportCaps = (supportLogin.body.user as Record<string, unknown>).capabilities as string[];
    check('support holds org.read', supportCaps.includes('org.read'));
    check('support does NOT hold staff.manage', !supportCaps.includes('staff.manage'), supportCaps.join(','));
    check('support does NOT hold plan.manage', !supportCaps.includes('plan.manage'));

    const supportToken = supportLogin.body.token as string;
    const supportStaff = await request(port, 'GET', '/api/platform/staff', { token: supportToken });
    eq('and the SERVER refuses staff management, not just the UI', supportStaff.status, 403);
    eq('with the capability code', supportStaff.body.code, 'PLATFORM_CAPABILITY_DENIED');

    const supportOrgs = await request(port, 'GET', '/api/platform/orgs', { token: supportToken });
    eq('while a capability it does hold still works', supportOrgs.status, 200);

    // ══════════════════════════════════════════════════════════════════════
    console.log('\nREMOVAL (scratch only)');
    // ══════════════════════════════════════════════════════════════════════

    const removeProd = runBootstrap({ PLATFORM_OWNER_EMAIL: OWNER.email }, ['--production', '--remove']);
    check(
      '--remove refuses --production outright',
      !removeProd.ok && /refuses --production/.test(removeProd.output),
      removeProd.output.slice(0, 140),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
    await mongoose.disconnect();
  }

  console.log('');
  if (failures) {
    console.error(`PLATFORM AUTH TESTS FAILED — ${failures} of ${checks}.`);
    process.exit(1);
  }
  console.log(`All ${checks} platform auth checks passed.`);
  process.exit(0);
}

main().catch((error) => {
  console.error('platform-auth.test.ts crashed:', error);
  process.exit(1);
});
