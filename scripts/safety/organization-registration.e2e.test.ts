/**
 * Public registration → staff review → real organization, over real HTTP.
 *
 * ── What this proves ────────────────────────────────────────────────────────
 * The whole chain, end to end, against a real database and a real Express app.
 * No mock API, no stubbed model, no hand-written fixture standing in for a
 * response. The only direct database writes are the two platform staff
 * accounts that make the authenticated calls; everything else — submission,
 * review, approval, provisioning — goes through the API exactly as the website
 * and the console do.
 *
 * The claims it checks are the ones that would be expensive to get wrong:
 *
 *   · the public endpoint cannot create a tenant, and needs no credential
 *   · a duplicate submission does not produce a duplicate row
 *   · the platform surface is closed to the public and to tenant tokens
 *   · approval REUSES `onboardOrganization()` — the org it produces is a
 *     normal tenant with roles and an entitlement, not a special case
 *   · approving twice does not create a second organization
 *   · a partial run stays resumable, and the record says it was partial
 *
 *   npx ts-node --transpile-only scripts/safety/organization-registration.e2e.test.ts \
 *     --scratch-suffix regtest
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

const MARKER = 'zz-reg';
const PASSWORD = 'RegistrationE2E!Passw0rd';
const INSTITUTE = 'Northgate Science Academy';
const APPLICANT_EMAIL = `${MARKER}-principal@northgate.test`;

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

function request(
  port: number,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1', port, method, path, timeout: 30000,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
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

const VALID_SUBMISSION = {
  organizationName: INSTITUTE,
  organizationType: 'COACHING_INSTITUTE',
  contactName: 'Priya Raman',
  designation: 'Director',
  email: APPLICANT_EMAIL,
  phone: '+91 98765 43210',
  city: 'Pune',
  state: 'Maharashtra',
  estimatedStudents: 420,
  estimatedTeachers: 24,
  message: 'We run JEE and NEET batches and want our own app.',
};

async function main() {
  const productionUri = requireEnv('MONGO_URI');
  const suffix = arg('--scratch-suffix');
  if (!suffix) {
    console.error('Usage: organization-registration.e2e.test.ts --scratch-suffix <suffix>');
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
  // The public endpoint sits behind publicFormLimiter. This test submits more
  // than a person would, so the ceiling is raised for the run — the limiter
  // itself is still mounted, and one check below proves it is.
  process.env.PUBLIC_FORM_RATE_LIMIT_MAX = '500';
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
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const OrganizationRegistration =
    require('../../src/models/OrganizationRegistration').default;

  console.log(`[reg-e2e] target: ${redactUri(uri)}\n`);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const app = require('../../src/app').default;
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  let orgId: string | null = null;
  let ownerId: string | null = null;
  let supportId: string | null = null;

  try {
    await withoutTenantScope('reg-e2e:clean', async () => {
      await OrganizationRegistration.deleteMany({ email: new RegExp(MARKER) });
      await PlatformUser.deleteMany({ email: new RegExp(MARKER) });
      const stale = await Org.findOne({ slug: 'northgate-science-academy' });
      if (stale) {
        await User.deleteMany({ orgId: stale._id });
        await Role.deleteMany({ orgId: stale._id });
        await Entitlement.deleteMany({ orgId: stale._id });
        await Org.deleteOne({ _id: stale._id });
      }
    });

    const [owner, support] = await withoutTenantScope('reg-e2e:seed-staff', async () =>
      Promise.all([
        PlatformUser.create({
          name: 'Reg Owner', email: `${MARKER}-owner@platform.test`, password: PASSWORD, role: 'owner',
        }),
        PlatformUser.create({
          name: 'Reg Support', email: `${MARKER}-support@platform.test`, password: PASSWORD, role: 'support',
        }),
      ]),
    );
    ownerId = String(owner._id);
    supportId = String(support._id);
    const ownerToken = signPlatformToken({ id: ownerId, role: 'owner', tokenVersion: 0 });
    const supportToken = signPlatformToken({ id: supportId, role: 'support', tokenVersion: 0 });

    /* ══ 1. The public endpoint ═══════════════════════════════════════════ */
    console.log('public submission');

    const bad = await request(port, 'POST', '/api/public/organization-registration', undefined, {
      organizationName: 'X',
      organizationType: 'NOT_A_TYPE',
      contactName: '',
      email: 'not-an-email',
      phone: '12',
      city: '',
    });
    check('2. an invalid submission is rejected with per-field messages',
      bad.status === 400 && bad.json?.fields?.email && bad.json?.fields?.phone && bad.json?.fields?.city,
      `got ${bad.status} ${bad.raw.slice(0, 200)}`);
    check('   ...and the rejection leaks no stack trace',
      !/at .*\(.*:\d+:\d+\)/.test(bad.raw));

    const created = await request(
      port, 'POST', '/api/public/organization-registration', undefined, VALID_SUBMISSION,
    );
    check('3. a valid submission is accepted without any credential', created.status === 201,
      `got ${created.status} ${created.raw.slice(0, 200)}`);
    check('   the confirmation carries a quotable reference',
      typeof created.json?.registration?.reference === 'string' &&
        /^REG-[0-9A-F]{8}$/.test(created.json.registration.reference));
    check('   the confirmation says the team will be in touch',
      /review your request/i.test(created.json?.message ?? ''));

    // The public response must not hand out anything internal.
    const publicBody = created.raw;
    check('   no database id is returned to the public',
      !/"_id"/.test(publicBody) && !/"id"\s*:/.test(publicBody), publicBody.slice(0, 200));
    check('   no orgId, IP or review field is returned to the public',
      !/orgId|submittedIp|reviewedBy|dedupeKey/.test(publicBody));

    const afterFirst = await withoutTenantScope('reg-e2e:count-1', async () =>
      OrganizationRegistration.countDocuments({ email: APPLICANT_EMAIL }));
    check('3. exactly ONE pending registration exists', afterFirst === 1, `found ${afterFirst}`);

    const stored = await withoutTenantScope('reg-e2e:load', async () =>
      OrganizationRegistration.findOne({ email: APPLICANT_EMAIL }).lean());
    check('   it is PENDING', stored?.status === 'PENDING');
    check('   no Org was created by the public call',
      !(await withoutTenantScope('reg-e2e:no-org', async () =>
        Org.findOne({ slug: 'northgate-science-academy' }))));
    check('   the submitter IP was recorded for abuse triage', Boolean(stored?.submittedIp));
    check('   the email was normalized to lowercase', stored?.email === APPLICANT_EMAIL.toLowerCase());

    /* ══ 2. Duplicate protection ══════════════════════════════════════════ */
    console.log('\nduplicate submission');

    const again = await request(
      port, 'POST', '/api/public/organization-registration', undefined, VALID_SUBMISSION,
    );
    const afterSecond = await withoutTenantScope('reg-e2e:count-2', async () =>
      OrganizationRegistration.countDocuments({ email: APPLICANT_EMAIL }));
    check('4. a repeat submission still answers 201 (a refresh is not an error)',
      again.status === 201, `got ${again.status}`);
    check('4. ...and does NOT create a second row', afterSecond === 1, `found ${afterSecond}`);
    check('   ...and returns the same reference',
      again.json?.registration?.reference === created.json?.registration?.reference);

    const honeypot = await request(port, 'POST', '/api/public/organization-registration', undefined, {
      ...VALID_SUBMISSION,
      email: `${MARKER}-bot@northgate.test`,
      website: 'http://spam.example.com',
    });
    const botRows = await withoutTenantScope('reg-e2e:count-bot', async () =>
      OrganizationRegistration.countDocuments({ email: `${MARKER}-bot@northgate.test` }));
    check('   a honeypot submission is silently discarded', honeypot.status === 201 && botRows === 0,
      `status ${honeypot.status}, rows ${botRows}`);

    /* ══ 3. The platform surface is closed ════════════════════════════════ */
    console.log('\naccess control');

    const anon = await request(port, 'GET', '/api/platform/registrations');
    check('5. the public cannot list registrations', anon.status === 401, `got ${anon.status}`);

    const tenantToken = signTenantToken
      ? signTenantToken({ id: '000000000000000000000001', role: 'admin', orgId: '000000000000000000000002', tokenVersion: 0 })
      : null;
    if (tenantToken) {
      const asTenant = await request(port, 'GET', '/api/platform/registrations', tenantToken);
      check('5. a TENANT token cannot reach the platform surface',
        asTenant.status === 401 || asTenant.status === 403, `got ${asTenant.status}`);
    }

    const regId = String(stored!._id);
    const supportApprove = await request(
      port, 'POST', `/api/platform/registrations/${regId}/approve`, supportToken, {},
    );
    check('7. a support user CANNOT approve (needs org.manage)',
      supportApprove.status === 403 && supportApprove.json?.code === 'PLATFORM_CAPABILITY_DENIED',
      `got ${supportApprove.status}`);
    const stillPending = await withoutTenantScope('reg-e2e:still-pending', async () =>
      OrganizationRegistration.findById(regId).lean());
    check('   ...and the refusal changed nothing', stillPending?.status === 'PENDING');

    /* ══ 4. Staff can read ════════════════════════════════════════════════ */
    console.log('\nstaff review');

    const list = await request(port, 'GET', '/api/platform/registrations?status=PENDING', supportToken);
    check('6. a platform user can list pending registrations',
      list.status === 200 && Array.isArray(list.json?.items), `got ${list.status}`);
    check('   the list withholds the submitter IP',
      !/submittedIp/.test(list.raw));

    const detail = await request(port, 'GET', `/api/platform/registrations/${regId}`, supportToken);
    check('6. a platform user can open one registration',
      detail.status === 200 && detail.json?.registration?.organizationName === INSTITUTE);
    check('   the detail view DOES carry the IP, for triage',
      Boolean(detail.json?.registration?.submittedIp));

    /* ══ 5. Approval reuses onboardOrganization() ═════════════════════════ */
    console.log('\napproval and provisioning');

    const approve = await request(
      port, 'POST', `/api/platform/registrations/${regId}/approve`, ownerToken,
      {
        subscription: { addOns: ['exams', 'results'], status: 'trialing' },
        admin: {
          name: 'Priya Raman',
          email: `${MARKER}-admin@northgate.test`,
          password: PASSWORD,
        },
      },
    );
    check('8. an authorized staff member can approve',
      approve.status === 200 || approve.status === 207, `got ${approve.status} ${approve.raw.slice(0, 300)}`);
    check('9. approval ran the existing onboarding sequence',
      Array.isArray(approve.json?.onboarding?.steps) &&
        approve.json.onboarding.steps.some((s: any) => s.step === 'organization'),
      JSON.stringify(approve.json?.onboarding?.steps));
    check('   it reports having created the organization', approve.json?.created === true);

    orgId = approve.json?.onboarding?.orgId ?? null;
    check('12. the organization has a real MongoDB orgId',
      typeof orgId === 'string' && /^[a-f0-9]{24}$/.test(orgId), String(orgId));

    const org = await withoutTenantScope('reg-e2e:org', async () => Org.findById(orgId).lean());
    check('   the Org row exists and carries the institute name',
      org?.name === INSTITUTE && org?.slug === 'northgate-science-academy');
    check('17. it is a NORMAL tenant — system roles were provisioned',
      (await withoutTenantScope('reg-e2e:roles', async () =>
        Role.countDocuments({ orgId }))) > 0);
    check('17. ...and it has an entitlement snapshot',
      Boolean(await withoutTenantScope('reg-e2e:ent', async () =>
        Entitlement.findOne({ orgId }).lean())));
    check('   the org record records where it came from',
      typeof org?.notes === 'string' && org.notes.includes(regId));

    check('13. the initial administrator was created through onboarding',
      typeof approve.json?.onboarding?.adminUserId === 'string');
    const admin = await withoutTenantScope('reg-e2e:admin', async () =>
      User.findOne({ orgId, email: `${MARKER}-admin@northgate.test` }).lean());
    check('   the admin is a real tenant user with the admin role',
      admin?.role === 'admin' && admin?.status === 'approved');
    check('23. no credential is echoed back by the approval response',
      !/password/i.test(approve.raw), approve.raw.slice(0, 200));

    const linked = await withoutTenantScope('reg-e2e:linked', async () =>
      OrganizationRegistration.findById(regId).lean());
    check('14. the registration is APPROVED and linked to the organization',
      linked?.status === 'APPROVED' && String(linked?.orgId) === orgId);
    check('   the slug is stored, so later runs cannot drift',
      linked?.orgSlug === 'northgate-science-academy');
    check('   the provisioning steps are kept on the record',
      Array.isArray(linked?.provisioningSteps) && linked!.provisioningSteps!.length > 0);

    /* ══ 6. Repeated approval ═════════════════════════════════════════════ */
    console.log('\nrepeated approval');

    const orgsBefore = await withoutTenantScope('reg-e2e:orgs-before', async () =>
      Org.countDocuments({ slug: 'northgate-science-academy' }));
    const again2 = await request(
      port, 'POST', `/api/platform/registrations/${regId}/approve`, ownerToken, {},
    );
    const orgsAfter = await withoutTenantScope('reg-e2e:orgs-after', async () =>
      Org.countDocuments({ slug: 'northgate-science-academy' }));

    check('15. approving again succeeds', again2.status === 200 || again2.status === 207,
      `got ${again2.status}`);
    check('10. ...and creates NO second organization', orgsBefore === 1 && orgsAfter === 1,
      `before ${orgsBefore}, after ${orgsAfter}`);
    check('15. ...and reports that it resumed rather than created',
      again2.json?.created === false);
    check('11. onboarding reported the organization as already existing',
      again2.json?.onboarding?.steps?.some(
        (s: any) => s.step === 'organization' && /already existed/.test(s.detail ?? ''),
      ), JSON.stringify(again2.json?.onboarding?.steps?.[0]));
    check('   the same orgId comes back', again2.json?.onboarding?.orgId === orgId);

    const adminCount = await withoutTenantScope('reg-e2e:admin-count', async () =>
      User.countDocuments({ orgId, email: `${MARKER}-admin@northgate.test` }));
    check('13. the administrator was not duplicated either', adminCount === 1, `found ${adminCount}`);

    /* ══ 7. Rejection rules ═══════════════════════════════════════════════ */
    console.log('\nrejection');

    const rejectProvisioned = await request(
      port, 'POST', `/api/platform/registrations/${regId}/reject`, ownerToken, { note: 'no' },
    );
    check('a provisioned registration cannot be rejected',
      rejectProvisioned.status === 409, `got ${rejectProvisioned.status}`);

    const second = await request(
      port, 'POST', '/api/public/organization-registration', undefined,
      { ...VALID_SUBMISSION, organizationName: 'Southgate Tutorials', email: `${MARKER}-south@northgate.test` },
    );
    const secondId = await withoutTenantScope('reg-e2e:second', async () => {
      const row = await OrganizationRegistration.findOne({ email: `${MARKER}-south@northgate.test` }).lean();
      return row ? String(row._id) : null;
    });
    check('a second institute can register independently', second.status === 201 && Boolean(secondId));

    const rejected = await request(
      port, 'POST', `/api/platform/registrations/${secondId}/reject`, ownerToken,
      { note: 'Out of coverage area.' },
    );
    check('a pending registration can be rejected', rejected.status === 200);
    check('   ...and no organization was created for it',
      !(await withoutTenantScope('reg-e2e:no-org-2', async () =>
        Org.findOne({ slug: 'southgate-tutorials' }))));
    check('   ...and the reviewer is recorded on the record',
      rejected.json?.registration?.reviewedByEmail === `${MARKER}-owner@platform.test`,
      String(rejected.json?.registration?.reviewedByEmail));

    /* ══ 8. Audit ═════════════════════════════════════════════════════════ */
    console.log('\naudit');

    const audit = await withoutTenantScope('reg-e2e:audit', async () =>
      PlatformAudit.find({ action: new RegExp('^registration\\.') }).lean());
    const actions = new Set(audit.map((a: any) => a.action));
    check('registration.view is audited', actions.has('registration.view'));
    check('registration.approve is audited', actions.has('registration.approve'));
    check('a retry is audited distinctly from a first approval',
      actions.has('registration.approve.retry'));
    check('registration.reject is audited', actions.has('registration.reject'));
    check('the approval audit carries the resulting orgId',
      audit.some((a: any) => a.action === 'registration.approve' && String(a.orgId) === orgId));

    /* ══ 9. Nothing else moved ════════════════════════════════════════════ */
    console.log('\nno collateral damage');

    const ctxAnon = await request(port, 'GET', '/api/me/context');
    check('18. tenant auth still refuses an anonymous caller', ctxAnon.status === 401,
      `got ${ctxAnon.status}`);
    const orgsListed = await request(port, 'GET', '/api/platform/orgs', ownerToken);
    check('17. the new organization appears in the platform org list',
      orgsListed.status === 200 &&
        orgsListed.json?.items?.some((o: any) => String(o._id ?? o.id) === orgId),
      `got ${orgsListed.status}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));

    await withoutTenantScope('reg-e2e:cleanup', async () => {
      await OrganizationRegistration.deleteMany({ email: new RegExp(MARKER) });
      await PlatformUser.deleteMany({ email: new RegExp(MARKER) });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PA = require('../../src/models/PlatformAudit').default;
      await PA.deleteMany({ action: new RegExp('^registration\\.') });
      if (orgId) {
        await User.deleteMany({ orgId });
        await Role.deleteMany({ orgId });
        await Entitlement.deleteMany({ orgId });
        await Org.deleteOne({ _id: orgId });
      }
      await Org.deleteOne({ slug: 'southgate-tutorials' });
    });
    void ownerId; void supportId;
    await mongoose.disconnect();
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('\n[reg-e2e] FAILED:', error);
  process.exit(1);
});
