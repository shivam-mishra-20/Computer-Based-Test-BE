/**
 * Onboard ABC Coaching entirely through the platform API.
 *
 * ── What this proves ────────────────────────────────────────────────────────
 * Completion criteria 9, 10 and 11: an organization can be created and fully
 * configured through real HTTP calls to /api/platform/*, with NO direct
 * database manipulation, and the resulting configuration is then consumed
 * correctly by a tenant client through /api/me/context.
 *
 * Every write below goes through the API. The only direct database access is
 * reading back to verify, and cleanup.
 *
 * Also verifies capability separation is real: a `support` token can read but
 * cannot change a subscription, and a tenant token cannot get in at all.
 *
 *   npx ts-node --transpile-only scripts/safety/platform-onboarding.e2e.test.ts \
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

const SLUG = 'abc-coaching-p5';
const MARKER = 'zz-p5';
const PASSWORD = 'AbcCoaching!P5-Passw0rd';

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

interface Res { status: number; json: any; raw: string }

function request(port: number, method: string, path: string, token?: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1', port, method, path, timeout: 30000,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed: any = null;
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

/** ABC Coaching — deliberately different from Abhigyan in every dimension. */
const ABC = {
  organization: { name: 'ABC Coaching Institute', slug: SLUG, status: 'trialing' },
  branding: {
    appName: 'ABC Coaching',
    primaryColor: '#E8590C',
    secondaryColor: '#1B3A5C',
    accentColor: '#FFB020',
    documentHeader: 'ABC Coaching Institute',
  },
  locale: { timezone: 'Asia/Kolkata', currency: 'INR', language: 'English' },
  configuration: {
    // Class 9-12 plus a NON-NUMERIC label, the case the old regex rejected.
    classLevels: [
      { key: '9', label: 'Class 9', aliases: ['9', 'Class 9'] },
      { key: '10', label: 'Class 10', aliases: ['10', 'Class 10'] },
      { key: '11', label: 'Class 11', aliases: ['11', 'Class 11'] },
      { key: '12', label: 'Class 12', aliases: ['12', 'Class 12'] },
      { key: 'dropper', label: 'Dropper', aliases: ['Dropper', 'Repeater'] },
    ],
    subjects: [
      { name: 'Physics' }, { name: 'Chemistry' },
      { name: 'Mathematics' }, { name: 'Biology' },
    ],
    rooms: [
      { name: 'Hall A', capacity: 60 }, { name: 'Hall B', capacity: 45 },
      { name: 'Lab 1', capacity: 24 }, { name: 'Lab 2', capacity: 24 },
    ],
    batches: [
      { name: 'JEE Main', classLevels: ['11', '12'] },
      { name: 'JEE Advanced', classLevels: ['11', '12'] },
      { name: 'NEET', classLevels: ['11', '12'] },
      { name: 'Foundation', classLevels: ['9', '10'] },
    ],
  },
  policy: {
    // +4 / -1 — JEE marking, deliberately unlike Abhigyan's +1 / 0.
    exam: { markingScheme: { correct: 4, incorrect: -1, unattempted: 0 }, submitLockPercent: 75 },
  },
  subscription: {
    addOns: ['exams', 'questionBank', 'questionImport', 'results', 'rankings', 'homework', 'doubts'],
    status: 'trialing',
  },
  customRoles: [
    {
      key: 'centre_manager', name: 'Centre Manager',
      permissions: ['students.read', 'students.create', 'students.update', 'schedule.read', 'schedule.manage'],
    },
    { key: 'counsellor', name: 'Counsellor', permissions: ['students.read'] },
  ],
  admin: { name: 'ABC Admin', email: `${MARKER}-admin@abc-coaching.test`, password: PASSWORD },
};

async function main() {
  const productionUri = requireEnv('MONGO_URI');
  const suffix = arg('--scratch-suffix');
  if (!suffix) {
    console.error('Usage: platform-onboarding.e2e.test.ts --scratch-suffix <suffix>');
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
  const { withoutTenantScope } = require('../../src/core/tenancy/context');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { signPlatformToken, signTenantToken } = require('../../src/core/auth/tokens');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const PlatformUser = require('../../src/models/PlatformUser').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Org = require('../../src/models/Org').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const User = require('../../src/models/User').default;

  console.log(`[p5-e2e] target: ${redactUri(uri)}\n`);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const app = require('../../src/app').default;
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  let orgId: string | null = null;
  let ownerId: string | null = null;
  let supportId: string | null = null;

  try {
    // Only direct writes in this test: the two staff accounts that will make
    // every subsequent call. Everything else goes through the API.
    const [owner, support] = await withoutTenantScope('p5:seed-staff', async () => {
      await PlatformUser.deleteMany({ email: new RegExp(MARKER) });
      return Promise.all([
        PlatformUser.create({ name: 'P5 Owner', email: `${MARKER}-owner@platform.test`, password: PASSWORD, role: 'owner' }),
        PlatformUser.create({ name: 'P5 Support', email: `${MARKER}-support@platform.test`, password: PASSWORD, role: 'support' }),
      ]);
    });
    ownerId = String(owner._id);
    supportId = String(support._id);

    const ownerToken = signPlatformToken({ id: ownerId, role: 'owner', tokenVersion: 0 });
    const supportToken = signPlatformToken({ id: supportId, role: 'support', tokenVersion: 0 });

    // ── Authentication and capability separation ──────────────────────────
    console.log('platform authentication and capabilities');
    check('owner can read the dashboard', (await request(port, 'GET', '/api/platform/dashboard', ownerToken)).status === 200);
    check('support can read the dashboard', (await request(port, 'GET', '/api/platform/dashboard', supportToken)).status === 200);

    const staffList = await request(port, 'GET', '/api/platform/staff', supportToken);
    check(
      'support CANNOT list platform staff (needs staff.manage)',
      staffList.status === 403 && staffList.json?.code === 'PLATFORM_CAPABILITY_DENIED',
      `got ${staffList.status}`,
    );

    // ── Onboarding, entirely through the API ──────────────────────────────
    console.log('\norganization onboarding through /api/platform/orgs/onboard');
    const onboard = await request(port, 'POST', '/api/platform/orgs/onboard', ownerToken, ABC);
    check(
      `onboarding returned ${onboard.status} (201 = every step succeeded)`,
      onboard.status === 201,
      JSON.stringify(onboard.json?.steps ?? onboard.raw).slice(0, 400),
    );
    orgId = onboard.json?.orgId ?? null;
    check('an orgId was returned', Boolean(orgId));
    check('every onboarding step succeeded', onboard.json?.complete === true,
      JSON.stringify((onboard.json?.steps ?? []).filter((s: any) => !s.ok)));
    check('an initial admin was created', Boolean(onboard.json?.adminUserId));
    check('both custom roles were created',
      Boolean(onboard.json?.roleIds?.centre_manager && onboard.json?.roleIds?.counsellor));

    if (!orgId) throw new Error('onboarding did not return an orgId — cannot continue');

    // ── Read the org back through the API ─────────────────────────────────
    console.log('\norganization detail via the API');
    const detail = await request(port, 'GET', `/api/platform/orgs/${orgId}`, ownerToken);
    check('detail returns 200', detail.status === 200, `got ${detail.status}`);

    const d = detail.json ?? {};
    check('name is ABC Coaching Institute', d.organization?.name === 'ABC Coaching Institute');
    check('branding primary colour is orange', d.organization?.branding?.primaryColor === '#E8590C');
    check('5 class levels including Dropper',
      d.configuration?.classLevels?.length === 5 &&
      d.configuration.classLevels.some((c: any) => c.key === 'dropper'),
      JSON.stringify(d.configuration?.classLevels?.map((c: any) => c.key)));
    check('4 subjects (PCM + Biology)', d.configuration?.subjects?.length === 4,
      JSON.stringify(d.configuration?.subjects));
    check('4 rooms named Hall/Lab, not Room N',
      d.configuration?.rooms?.length === 4 && d.configuration.rooms[0].name === 'Hall A',
      JSON.stringify(d.configuration?.rooms?.map((r: any) => r.name)));
    check('Hall A capacity is 60, unlike any Abhigyan room',
      d.configuration?.rooms?.find((r: any) => r.name === 'Hall A')?.capacity === 60);
    check('marking scheme is +4 / -1', d.policy?.exam?.markingScheme?.correct === 4 &&
      d.policy.exam.markingScheme.incorrect === -1,
      JSON.stringify(d.policy?.exam?.markingScheme));
    check('submit lock is 75%, not the default 50', d.policy?.exam?.submitLockPercent === 75);
    check('config reports it is NOT using defaults',
      d.configuration?.usingDefaults?.classLevels === false &&
      d.configuration?.usingDefaults?.rooms === false);
    check('7 custom + system roles exist', (d.roles?.length ?? 0) >= 7, `${d.roles?.length} roles`);
    check('entitlement includes exams', d.entitlement?.modules?.includes('exams'));
    check('entitlement does NOT include ai', !d.entitlement?.modules?.includes('ai'),
      'ABC did not buy AI');
    check('entitlement includes attendance dependency-free absence',
      !d.entitlement?.modules?.includes('attendance'), 'ABC did not buy attendance');

    // ── Capability separation on a real mutation ──────────────────────────
    console.log('\ncapability separation on subscription changes');
    const supportSub = await request(port, 'PUT', `/api/platform/orgs/${orgId}/subscription`, supportToken, { status: 'active' });
    check(
      'support CANNOT change a subscription',
      supportSub.status === 403,
      `got ${supportSub.status} — support may configure, not sell`,
    );
    const ownerSub = await request(port, 'PUT', `/api/platform/orgs/${orgId}/subscription`, ownerToken, { status: 'active' });
    check('owner CAN change a subscription', ownerSub.status === 200, `got ${ownerSub.status}`);

    // ── Lifecycle ─────────────────────────────────────────────────────────
    console.log('\norganization lifecycle');
    const suspend = await request(port, 'POST', `/api/platform/orgs/${orgId}/status`, ownerToken, { status: 'suspended' });
    check('org can be suspended', suspend.status === 200);
    const afterSuspend = await request(port, 'GET', `/api/platform/orgs/${orgId}/entitlement`, ownerToken);
    check(
      'suspension makes the entitlement NOT writable',
      afterSuspend.json?.entitlement?.writable === false,
      JSON.stringify(afterSuspend.json?.entitlement?.status),
    );
    const reactivate = await request(port, 'POST', `/api/platform/orgs/${orgId}/status`, ownerToken, { status: 'active' });
    check('org can be reactivated', reactivate.status === 200);
    check('reactivation restores writability',
      (await request(port, 'GET', `/api/platform/orgs/${orgId}/entitlement`, ownerToken)).json?.entitlement?.writable === true);

    const badStatus = await request(port, 'POST', `/api/platform/orgs/${orgId}/status`, ownerToken, { status: 'banana' });
    check('an invalid status is rejected', badStatus.status === 400);

    // ── Search ────────────────────────────────────────────────────────────
    console.log('\nsearch and listing');
    const search = await request(port, 'GET', `/api/platform/orgs?search=ABC`, ownerToken);
    check('search finds ABC Coaching', (search.json?.items ?? []).some((o: any) => o.slug === SLUG));
    const regexSafe = await request(port, 'GET', `/api/platform/orgs?search=${encodeURIComponent('a(b')}`, ownerToken);
    check('a regex metacharacter in search does not error', regexSafe.status === 200);

    // ── Audit ─────────────────────────────────────────────────────────────
    console.log('\naudit trail');
    const audit = await request(port, 'GET', `/api/platform/audit?orgId=${orgId}`, ownerToken);
    check('audit returns entries for this org', (audit.json?.entries ?? []).length > 0,
      `${audit.json?.entries?.length ?? 0} entries`);
    const actions = (audit.json?.entries ?? []).map((e: any) => e.action);
    check('the onboarding was recorded', actions.includes('org.onboard'), actions.join(','));
    check('the suspension was recorded', actions.includes('org.status.suspended'), actions.join(','));
    check('audit records who acted', (audit.json?.entries ?? [])[0]?.actorEmail?.includes(MARKER));

    // ── CLIENT PROPAGATION: /api/me/context for an ABC user ──────────────
    console.log('\nclient-platform consumption via /api/me/context');
    const adminUser = await withoutTenantScope('p5:find-admin', () =>
      User.findOne({ email: ABC.admin.email }).lean());
    check('the onboarded admin exists', Boolean(adminUser));

    const tenantToken = signTenantToken({
      id: String((adminUser as any)._id), orgId, role: 'admin', tokenVersion: 0,
    });
    const ctx = await request(port, 'GET', '/api/me/context', tenantToken);
    check('context returns 200 for an ABC user', ctx.status === 200, `got ${ctx.status}`);
    check('  organization is ABC Coaching Institute', ctx.json?.organization?.name === 'ABC Coaching Institute');
    check('  branding is orange', ctx.json?.organization?.branding?.primaryColor === '#E8590C');
    check('  modules include exams', (ctx.json?.modules ?? []).includes('exams'));
    check('  modules EXCLUDE ai', !(ctx.json?.modules ?? []).includes('ai'));
    check('  classLevels include Dropper',
      (ctx.json?.configuration?.classLevels ?? []).some((c: any) => c.key === 'dropper'));
    check('  subjects are the 4 ABC ones',
      (ctx.json?.configuration?.subjects ?? []).length === 4);
    check('  rooms are Hall A / Hall B / Lab 1 / Lab 2',
      (ctx.json?.configuration?.rooms ?? []).map((r: any) => r.name).join(',') === 'Hall A,Hall B,Lab 1,Lab 2');
    check('  policy marking scheme is +4 / -1',
      ctx.json?.configuration?.policy?.exam?.markingScheme?.correct === 4);

    // ── Org 001 is unaffected ─────────────────────────────────────────────
    console.log('\nOrg 001 remains unaffected');
    const org001 = await withoutTenantScope('p5:find-001', () => Org.findOne({ slug: 'abhigyan' }).lean());
    if (org001) {
      const d001 = await request(port, 'GET', `/api/platform/orgs/${String((org001 as any)._id)}`, ownerToken);
      check('Abhigyan still resolves', d001.status === 200);
      check('  Abhigyan still has 6 class levels (7-12)',
        d001.json?.configuration?.classLevels?.length === 6,
        JSON.stringify(d001.json?.configuration?.classLevels?.map((c: any) => c.key)));
      check('  Abhigyan still has 11 rooms', d001.json?.configuration?.rooms?.length === 11);
      check('  Abhigyan marking scheme is still +1 / 0',
        d001.json?.policy?.exam?.markingScheme?.correct === 1 &&
        d001.json?.policy?.exam?.markingScheme?.incorrect === 0);
      check('  the two orgs have DIFFERENT configurations',
        d001.json?.configuration?.rooms?.length !== d.configuration?.rooms?.length);
    } else {
      console.log('  – Org 001 not present in this database, skipped');
    }

    // ── Tenant token still cannot reach platform ──────────────────────────
    console.log('\nplatform surface remains closed to tenants');
    const intrusion = await request(port, 'GET', '/api/platform/orgs', tenantToken);
    check('an ABC admin token is DENIED by /api/platform/orgs',
      intrusion.status === 403 && intrusion.json?.code === 'TOKEN_AUDIENCE_MISMATCH',
      `got ${intrusion.status}`);
  } finally {
    try {
      await withoutTenantScope('p5:cleanup', async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Role = require('../../src/models/Role').default;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const ClassLevel = require('../../src/models/ClassLevel').default;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Subject = require('../../src/models/Subject').default;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const OrgRoom = require('../../src/models/OrgRoom').default;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const OrgPolicy = require('../../src/models/OrgPolicy').default;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Batch = require('../../src/models/Batch').default;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Subscription = require('../../src/models/Subscription').default;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Entitlement = require('../../src/models/Entitlement').default;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const PlatformAudit = require('../../src/models/PlatformAudit').default;

        if (orgId) {
          await Promise.all([
            Role.deleteMany({ orgId }), ClassLevel.deleteMany({ orgId }),
            Subject.deleteMany({ orgId }), OrgRoom.deleteMany({ orgId }),
            OrgPolicy.deleteMany({ orgId }), Batch.deleteMany({ orgId }),
            Subscription.deleteMany({ orgId }), Entitlement.deleteMany({ orgId }),
            PlatformAudit.deleteMany({ orgId }), User.deleteMany({ orgId }),
          ]);
          await Org.deleteOne({ _id: orgId });
        }
        await PlatformUser.deleteMany({ email: new RegExp(MARKER) });
        await PlatformAudit.deleteMany({ actorEmail: new RegExp(MARKER) });
        console.log('\n  fixture removed');
      });
    } catch (error) {
      console.error('  cleanup failed:', (error as Error).message);
    }
    await new Promise<void>((r) => server.close(() => r()));
    await mongoose.connection.close();
  }

  console.log('');
  if (failures) {
    console.error(`P5 ONBOARDING E2E FAILED — ${failures} of ${checks}.`);
    process.exit(1);
  }
  console.log(`All ${checks} platform onboarding checks passed.`);
  process.exit(0);
}

main().catch((error) => {
  console.error('[p5-e2e] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
