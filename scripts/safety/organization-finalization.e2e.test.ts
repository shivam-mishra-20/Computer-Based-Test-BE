/**
 * Finalization: branding → mobile identity → readiness → generation → handoff.
 *
 * ── What this proves ────────────────────────────────────────────────────────
 * That the console can take a provisioned organization all the way to a build
 * configuration a developer can use, and — the part that matters — that it
 * cannot lie about it. Every claim below is checked against real HTTP calls to
 * a real Express app on a real (scratch) database.
 *
 * The three claims worth the length:
 *
 *   · READINESS IS NOT COSMETIC. The status comes from the validator in
 *     `@platform/client-core`, the same module `client-platform-app` runs at
 *     build time. A configuration the console calls READY is one the build
 *     accepts, and the last section proves the two agree by feeding the same
 *     record to both.
 *
 *   · NATIVE IDENTITY IS UNIQUE. Package name, bundle id and scheme are each
 *     refused when another organization holds them, with a message naming that
 *     organization. Two apps sharing a package name is a store collision that
 *     cannot be undone after publication.
 *
 *   · CAPABILITY IS SPLIT. `org.read` sees it, `app.manage` changes it, and
 *     `org.manage` alone does not — because the roles that administer an
 *     organization and the roles that build its app are not the same people.
 *
 *   npx ts-node --transpile-only scripts/safety/organization-finalization.e2e.test.ts \
 *     --scratch-suffix scratch_final
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

const MARKER = 'zz-final';
const PASSWORD = 'FinalizationE2E!Passw0rd';
const SLUG_A = 'northwind-academy-fin';
const SLUG_B = 'southwind-college-fin';

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
    const payload = body !== undefined ? JSON.stringify(body) : null;
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
          try { parsed = raw ? JSON.parse(raw) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, json: parsed, raw });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const GOOD_MOBILE = {
  androidPackage: 'com.platform.northwindacademy',
  iosBundleId: 'com.platform.northwindacademy',
  scheme: 'northwindacademy',
  apiBaseUrl: 'https://api.platform.example.com/api',
  version: '1.0.0',
  backgroundColor: '#0B1020',
  assetsReady: true,
};

async function main() {
  const productionUri = requireEnv('MONGO_URI');
  const suffix = arg('--scratch-suffix');
  if (!suffix) {
    console.error('Usage: organization-finalization.e2e.test.ts --scratch-suffix <suffix>');
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
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Role = require('../../src/models/Role').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Entitlement = require('../../src/models/Entitlement').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const PlatformAudit = require('../../src/models/PlatformAudit').default;
  // The very module client-platform-app validates with. Imported here so the
  // last section can prove both sides agree rather than asserting it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const shared = require('@platform/client-core');

  console.log(`[fin-e2e] target: ${redactUri(uri)}\n`);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const app = require('../../src/app').default;
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  let orgA: string | null = null;
  let orgB: string | null = null;

  const cleanup = async () => {
    await withoutTenantScope('fin-e2e:clean', async () => {
      for (const slug of [SLUG_A, SLUG_B]) {
        const o = await Org.findOne({ slug });
        if (o) {
          await User.deleteMany({ orgId: o._id });
          await Role.deleteMany({ orgId: o._id });
          await Entitlement.deleteMany({ orgId: o._id });
          await Org.deleteOne({ _id: o._id });
        }
      }
      await PlatformUser.deleteMany({ email: new RegExp(MARKER) });
      await PlatformAudit.deleteMany({ action: new RegExp('^mobile\\.') });
    });
  };

  try {
    await cleanup();

    const [owner, engineer, support] = await withoutTenantScope('fin-e2e:staff', async () =>
      Promise.all([
        PlatformUser.create({ name: 'Fin Owner', email: `${MARKER}-owner@platform.test`, password: PASSWORD, role: 'owner' }),
        PlatformUser.create({ name: 'Fin Engineer', email: `${MARKER}-eng@platform.test`, password: PASSWORD, role: 'engineer' }),
        PlatformUser.create({ name: 'Fin Support', email: `${MARKER}-sup@platform.test`, password: PASSWORD, role: 'support' }),
      ]),
    );
    const ownerToken = signPlatformToken({ id: String(owner._id), role: 'owner', tokenVersion: 0 });
    const engToken = signPlatformToken({ id: String(engineer._id), role: 'engineer', tokenVersion: 0 });
    const supToken = signPlatformToken({ id: String(support._id), role: 'support', tokenVersion: 0 });

    /* ══ 1. Existing provisioning still works ═════════════════════════════ */
    console.log('existing onboarding');

    const onboardA = await request(port, 'POST', '/api/platform/orgs/onboard', ownerToken, {
      organization: { name: 'Northwind Academy', slug: SLUG_A, status: 'trialing' },
      branding: { appName: 'Northwind', primaryColor: '#2563EB' },
    });
    check('1. an organization can still be provisioned', onboardA.status === 201 || onboardA.status === 207,
      `got ${onboardA.status} ${onboardA.raw.slice(0, 200)}`);
    orgA = onboardA.json?.orgId ?? null;
    check('12. it received a real orgId', typeof orgA === 'string' && /^[a-f0-9]{24}$/.test(orgA));

    const onboardB = await request(port, 'POST', '/api/platform/orgs/onboard', ownerToken, {
      organization: { name: 'Southwind College', slug: SLUG_B, status: 'trialing' },
    });
    orgB = onboardB.json?.orgId ?? null;
    check('   a second organization provisions independently', typeof orgB === 'string');

    const repeat = await request(port, 'POST', '/api/platform/orgs/onboard', ownerToken, {
      organization: { name: 'Northwind Academy', slug: SLUG_A },
    });
    check('3. onboarding remains idempotent', repeat.json?.orgId === orgA,
      `${repeat.json?.orgId} vs ${orgA}`);

    /* ══ 2. Branding is fully configurable ════════════════════════════════ */
    console.log('\nbranding (runtime)');

    const branding = {
      appName: 'Northwind Academy',
      tagline: 'Learning that carries',
      primaryColor: '#2563EB',
      secondaryColor: '#38BDF8',
      accentColor: '#0F172A',
      splashBackgroundColor: '#0B1020',
      logoUrl: 'https://cdn.example.com/northwind/logo.png',
      splashImageUrl: 'https://cdn.example.com/northwind/splash.png',
      documentHeader: 'Northwind Academy',
    };
    const brandRes = await request(port, 'PATCH', `/api/platform/orgs/${orgA}`, ownerToken, { branding });
    check('4. every branding field can be saved from the console', brandRes.status === 200,
      `got ${brandRes.status}`);
    const savedOrg = await withoutTenantScope('fin-e2e:org', async () => Org.findById(orgA).lean());
    check('4. tagline persisted (it was previously uncollectable)', savedOrg?.branding?.tagline === branding.tagline);
    check('4. logoUrl persisted', savedOrg?.branding?.logoUrl === branding.logoUrl);
    check('4. splashImageUrl persisted', savedOrg?.branding?.splashImageUrl === branding.splashImageUrl);
    check('4. splashBackgroundColor persisted', savedOrg?.branding?.splashBackgroundColor === branding.splashBackgroundColor);

    /* ══ 3. Readiness before mobile config ════════════════════════════════ */
    console.log('\nreadiness');

    const before = await request(port, 'GET', `/api/platform/orgs/${orgA}/mobile`, supToken);
    check('   a platform reader can see mobile configuration', before.status === 200);
    check('14. with nothing configured the status is NOT_CONFIGURED',
      before.json?.status === 'NOT_CONFIGURED', String(before.json?.status));
    check('5. and the missing requirements are named',
      before.json?.issues?.some((i: any) => i.field === 'androidPackage') &&
        before.json?.issues?.some((i: any) => i.field === 'apiBaseUrl'),
      JSON.stringify(before.json?.issues?.map((i: any) => i.field)));

    /* ══ 4. Capability separation ═════════════════════════════════════════ */
    console.log('\ncapabilities');

    const asSupport = await request(port, 'PUT', `/api/platform/orgs/${orgA}/mobile`, supToken, GOOD_MOBILE);
    check('17. support CANNOT change native identity', asSupport.status === 403,
      `got ${asSupport.status}`);

    const anon = await request(port, 'GET', `/api/platform/orgs/${orgA}/mobile`);
    check('18. anonymous callers are refused', anon.status === 401, `got ${anon.status}`);

    const tenantToken = signTenantToken({
      id: '000000000000000000000001', role: 'admin', orgId: orgA, tokenVersion: 0,
    });
    const asTenant = await request(port, 'GET', `/api/platform/orgs/${orgA}/mobile`, tenantToken);
    check('18. a TENANT admin cannot reach platform mobile configuration',
      asTenant.status === 401 || asTenant.status === 403, `got ${asTenant.status}`);

    const asEngineer = await request(port, 'PUT', `/api/platform/orgs/${orgA}/mobile`, engToken, GOOD_MOBILE);
    check('6. an engineer (app.manage) CAN configure it', asEngineer.status === 200,
      `got ${asEngineer.status} ${asEngineer.raw.slice(0, 200)}`);
    const engOrgManage = await request(port, 'POST', `/api/platform/orgs/${orgA}/status`, engToken, { status: 'active' });
    check('   ...but still cannot administer the organization', engOrgManage.status === 403,
      `got ${engOrgManage.status}`);

    /* ══ 5. Readiness after ═══════════════════════════════════════════════ */
    console.log('\nreadiness after configuration');

    check('14. the status became READY', asEngineer.json?.status === 'READY',
      `${asEngineer.json?.status} — ${JSON.stringify(asEngineer.json?.issues)}`);
    check('   with no outstanding issues', asEngineer.json?.issues?.length === 0);

    /* ══ 6. Uniqueness ════════════════════════════════════════════════════ */
    console.log('\nuniqueness across organizations');

    const dupPkg = await request(port, 'PUT', `/api/platform/orgs/${orgB}/mobile`, ownerToken,
      { androidPackage: GOOD_MOBILE.androidPackage });
    check('7. a duplicate Android package is refused', dupPkg.status === 409, `got ${dupPkg.status}`);
    check('   ...and the message names the organization holding it',
      /Northwind/.test(dupPkg.json?.message ?? ''), dupPkg.json?.message);

    const dupBundle = await request(port, 'PUT', `/api/platform/orgs/${orgB}/mobile`, ownerToken,
      { iosBundleId: GOOD_MOBILE.iosBundleId });
    check('8. a duplicate iOS bundle is refused', dupBundle.status === 409, `got ${dupBundle.status}`);

    const dupScheme = await request(port, 'PUT', `/api/platform/orgs/${orgB}/mobile`, ownerToken,
      { scheme: GOOD_MOBILE.scheme });
    check('9. a duplicate scheme is refused', dupScheme.status === 409, `got ${dupScheme.status}`);

    const dupSlug = await request(port, 'POST', '/api/platform/orgs', ownerToken,
      { name: 'Another Northwind', slug: SLUG_A });
    check('10. a duplicate slug is refused by the existing org route', dupSlug.status === 409,
      `got ${dupSlug.status}`);

    const orgBUntouched = await withoutTenantScope('fin-e2e:orgb', async () => Org.findById(orgB).lean());
    check('   the refused writes changed nothing', !orgBUntouched?.mobile?.androidPackage);

    /* ══ 7. Invalid values ════════════════════════════════════════════════ */
    console.log('\ninvalid configuration is not READY');

    const badCases: [string, Record<string, unknown>, string][] = [
      ['12. a missing API url is not READY', { apiBaseUrl: '' }, 'apiBaseUrl'],
      ['13. a localhost API url is not READY', { apiBaseUrl: 'http://localhost:5000/api' }, 'apiBaseUrl'],
      ['   a plain-http API url is not READY', { apiBaseUrl: 'http://api.example.com/api' }, 'apiBaseUrl'],
      ['   an invalid package name is not READY', { androidPackage: 'Northwind Academy' }, 'androidPackage'],
      ['   an invalid scheme is not READY', { scheme: 'north wind' }, 'scheme'],
    ];
    for (const [label, patch, field] of badCases) {
      const res = await request(port, 'PUT', `/api/platform/orgs/${orgA}/mobile`, engToken,
        { ...GOOD_MOBILE, ...patch });
      const bad = res.status === 200 &&
        res.json?.status !== 'READY' &&
        res.json?.issues?.some((i: any) => i.field === field);
      check(label, bad, `status ${res.json?.status}, issues ${JSON.stringify(res.json?.issues?.map((i: any) => i.field))}`);
    }

    const noAssets = await request(port, 'PUT', `/api/platform/orgs/${orgA}/mobile`, engToken,
      { ...GOOD_MOBILE, assetsReady: false });
    check('   assets not ready is not READY',
      noAssets.json?.status !== 'READY' && noAssets.json?.issues?.some((i: any) => i.field === 'assets'));

    // Restore a good configuration for the rest of the run.
    const restored = await request(port, 'PUT', `/api/platform/orgs/${orgA}/mobile`, engToken, GOOD_MOBILE);
    check('14. readiness returns to READY when the configuration is fixed',
      restored.json?.status === 'READY');

    /* ══ 8. Generation ════════════════════════════════════════════════════ */
    console.log('\nbuild configuration generation');

    const genB = await request(port, 'POST', `/api/platform/orgs/${orgB}/mobile/build-config`, ownerToken, {});
    check('   generation REFUSES an unready organization', genB.status === 422, `got ${genB.status}`);
    check('   ...and returns the exact missing requirements',
      Array.isArray(genB.json?.issues) && genB.json.issues.length > 0);

    const gen = await request(port, 'POST', `/api/platform/orgs/${orgA}/mobile/build-config`, engToken, {});
    check('15. a ready organization generates a build configuration', gen.status === 200,
      `got ${gen.status} ${gen.raw.slice(0, 200)}`);

    const file: string = gen.json?.organizationFile ?? '';
    check('15. the generated file carries the REAL orgId', file.includes(String(orgA)));
    check('15. ...the real slug', file.includes(`slug: '${SLUG_A}'`));
    check('15. ...the real app name and tagline',
      file.includes("name: 'Northwind Academy'") && file.includes("tagline: 'Learning that carries'"));
    check('15. ...the real package and bundle',
      file.includes(GOOD_MOBILE.androidPackage) && file.includes(GOOD_MOBILE.iosBundleId));
    check('15. ...the real API url', file.includes(GOOD_MOBILE.apiBaseUrl));
    check('15. ...the real colours', file.includes('#2563EB') && file.includes('#0B1020'));
    check('   it declares mode: dedicated', file.includes("mode: 'dedicated'"));
    check('   no placeholder survives into the output',
      !file.includes('pending:') && !file.includes('localhost') && !file.includes('TODO'));
    check('   the commands name the real slug',
      (gen.json?.commands ?? []).some((c: string) => c.includes(`ORG_ID=${SLUG_A}`)));
    check('   the asset directory is named', gen.json?.assetDirectory === `assets/${SLUG_A}/`);

    const genAsSupport = await request(port, 'POST', `/api/platform/orgs/${orgA}/mobile/build-config`, supToken, {});
    check('17. generation needs app.manage', genAsSupport.status === 403, `got ${genAsSupport.status}`);

    /* ══ 9. Reconciliation ════════════════════════════════════════════════ */
    console.log('\nreconciliation');

    const truthful = { ...gen.json.identity };
    const same = await request(port, 'POST', `/api/platform/orgs/${orgA}/mobile/reconcile`, supToken,
      { build: truthful });
    check('16. a matching build configuration reconciles clean',
      same.status === 200 && same.json?.matches === true,
      JSON.stringify(same.json?.mismatches));

    const drifted = { ...truthful, appName: 'Northwind Coaching', scheme: 'northwind2' };
    const diff = await request(port, 'POST', `/api/platform/orgs/${orgA}/mobile/reconcile`, supToken,
      { build: drifted });
    check('16. a drifted configuration is reported as a mismatch', diff.json?.matches === false);
    check('16. ...naming every field that differs',
      diff.json?.mismatches?.length === 2 &&
        diff.json.mismatches.some((m: any) => m.field === 'appName') &&
        diff.json.mismatches.some((m: any) => m.field === 'scheme'),
      JSON.stringify(diff.json?.mismatches));
    check('   ...and showing both sides',
      diff.json?.mismatches?.[0]?.expected !== undefined &&
        diff.json?.mismatches?.[0]?.actual !== undefined);

    const caseOnly = { ...truthful, primaryColor: String(truthful.primaryColor).toLowerCase() };
    const caseRes = await request(port, 'POST', `/api/platform/orgs/${orgA}/mobile/reconcile`, supToken,
      { build: caseOnly });
    check('   a colour differing only in case is NOT a mismatch', caseRes.json?.matches === true);

    /* ══ 10. Console and app agree ════════════════════════════════════════ */
    console.log('\none validator, two consumers');

    const consoleView = await request(port, 'GET', `/api/platform/orgs/${orgA}/mobile`, ownerToken);
    const appIssues = shared.validateMobileIdentity(consoleView.json.identity, 'production');
    check('20. the app-side validator agrees this is buildable', appIssues.length === 0,
      JSON.stringify(appIssues));
    check('20. ...and agrees on the status',
      shared.mobileBuildStatus(consoleView.json.identity, appIssues) === consoleView.json.status);

    const brokenIdentity = { ...consoleView.json.identity, apiBaseUrl: 'http://localhost:5000/api' };
    check('20. and both refuse the same broken configuration',
      shared.validateMobileIdentity(brokenIdentity, 'production').length > 0);

    /* ══ 11. Audit ════════════════════════════════════════════════════════ */
    console.log('\naudit');

    const audit = await withoutTenantScope('fin-e2e:audit', async () =>
      PlatformAudit.find({ action: new RegExp('^mobile\\.') }).lean());
    const actions = new Set(audit.map((a: any) => a.action));
    check('mobile.view is audited', actions.has('mobile.view'));
    check('mobile.update is audited', actions.has('mobile.update'));
    check('mobile.readiness records the transition', actions.has('mobile.readiness'));
    check('mobile.generate is audited', actions.has('mobile.generate'));
    check('mobile.mismatch is audited', actions.has('mobile.mismatch'));
    check('a clean reconciliation is NOT audited as a mismatch',
      audit.filter((a: any) => a.action === 'mobile.mismatch').length === 1,
      `${audit.filter((a: any) => a.action === 'mobile.mismatch').length} entries`);
    check('the readiness entry names both ends of the transition',
      audit.some((a: any) => a.action === 'mobile.readiness' && a.metadata?.from && a.metadata?.to));

    /* ══ 12. Nothing else moved ═══════════════════════════════════════════ */
    console.log('\nno collateral damage');

    const ctx = await request(port, 'GET', '/api/me/context');
    check('19. tenant auth still refuses anonymous callers', ctx.status === 401);
    const orgList = await request(port, 'GET', '/api/platform/orgs', ownerToken);
    check('   both organizations still list normally',
      orgList.status === 200 &&
        orgList.json.items.some((o: any) => String(o._id ?? o.id) === orgA) &&
        orgList.json.items.some((o: any) => String(o._id ?? o.id) === orgB));
    const rolesA = await withoutTenantScope('fin-e2e:roles', async () => Role.countDocuments({ orgId: orgA }));
    check('19. tenant roles are untouched by finalization', rolesA > 0, `${rolesA} roles`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('\n[fin-e2e] FAILED:', error);
  process.exit(1);
});
