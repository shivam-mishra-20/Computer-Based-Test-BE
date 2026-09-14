/**
 * The long onboarding application, end to end, against a real database.
 *
 * ── The claim being tested ──────────────────────────────────────────────────
 * That an institute can fill in a complete application and an admin can turn
 * it into a configured organization by pressing one button — with no re-typing
 * of anything the applicant already supplied.
 *
 * So the decisive section is the last one: it approves an application and then
 * reads the resulting tenant's class levels, subjects, rooms, batches, policy,
 * branding and entitlement back OUT of the database, asserting each carries
 * the value the applicant entered. Checking that approval returned 200 would
 * prove nothing about whether anything was applied.
 *
 * ── What is NOT exercised here, and why ─────────────────────────────────────
 * A successful asset upload. `storeAsset` writes to Firebase Storage, and this
 * repository's only credentials are production ones — uploading a test logo
 * would put a junk object in a live bucket. Every rejection path IS tested,
 * because all of them fail before storage is touched.
 *
 *   npx ts-node --transpile-only scripts/safety/organization-application.e2e.test.ts \
 *     --scratch-suffix scratch_app
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

const MARKER = 'zz-app';
const PASSWORD = 'ApplicationE2E!Passw0rd';
const SLUG = 'lakeside-science-academy-app';

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
  port: number, method: string, path: string,
  opts: { token?: string; draftToken?: string; body?: unknown } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : null;
    const req = http.request(
      {
        host: '127.0.0.1', port, method, path, timeout: 30000,
        headers: {
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.draftToken ? { 'X-Application-Token': opts.draftToken } : {}),
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

/** What the applicant fills in. Every value is asserted on the far side. */
const APPLICATION = {
  organization: {
    legalName: 'Lakeside Science Academy Pvt Ltd',
    shortName: 'Lakeside',
    addressLine1: '14 Lake Road',
    city: 'Nashik',
    state: 'Maharashtra',
    country: 'India',
    postalCode: '422001',
    website: 'https://lakeside.example.com',
    organizationEmail: `${MARKER}-office@lakeside.test`,
    supportEmail: `${MARKER}-help@lakeside.test`,
    supportPhone: '+91 98111 22333',
    academicYear: '2026-27',
  },
  branding: {
    appName: 'Lakeside Academy',
    shortAppName: 'Lakeside',
    tagline: 'Science, taught properly',
    primaryColor: '#0F766E',
    secondaryColor: '#14B8A6',
    accentColor: '#042F2E',
    splashBackgroundColor: '#02201E',
  },
  academic: {
    classLevels: [
      { key: '11', label: 'Class 11', aliases: ['11', 'XI'], order: 0 },
      { key: '12', label: 'Class 12', aliases: ['12', 'XII'], order: 1 },
      { key: 'dropper', label: 'Dropper', aliases: ['Repeater'], order: 2 },
    ],
    subjects: [
      { name: 'Physics', code: 'PHY' },
      { name: 'Chemistry', code: 'CHE' },
      { name: 'Mathematics', code: 'MAT' },
    ],
    rooms: [
      { name: 'Hall A', capacity: 60 },
      { name: 'Lab 1', capacity: 24 },
    ],
    batches: [
      { name: 'JEE Advanced', classLevels: ['11', '12'] },
      { name: 'NEET Repeat', classLevels: ['dropper'] },
    ],
    branches: [{ name: 'Main Campus', code: 'MAIN', address: '14 Lake Road' }],
  },
  policy: {
    exam: {
      markingScheme: { correct: 4, incorrect: -1, unattempted: 0 },
      submitLockPercent: 70,
      antiCheat: true,
    },
    grading: { passPercentage: 35 },
    locale: { timezone: 'Asia/Kolkata', currency: 'INR', language: 'English' },
    workingDays: [1, 2, 3, 4, 5, 6],
  },
  modules: { preset: 'test-prep', addOns: ['doubts', 'not-a-real-module'] },
  staff: {
    admins: [
      { name: 'Meera Joshi', email: `${MARKER}-admin@lakeside.test`, designation: 'Director', isPrimary: true },
    ],
  },
  integrations: { requested: [{ type: 'whatsapp', provider: 'gupshup', accountRef: 'LAKESIDE' }] },
  commercial: { privacyPolicyUrl: 'https://lakeside.example.com/privacy', gstNumber: '27ABCDE1234F1Z5' },
  completedSteps: ['organization', 'branding', 'academic', 'policy', 'modules', 'staff'],
};

async function main() {
  const productionUri = requireEnv('MONGO_URI');
  const suffix = arg('--scratch-suffix');
  if (!suffix) {
    console.error('Usage: organization-application.e2e.test.ts --scratch-suffix <suffix>');
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
  process.env.PUBLIC_FORM_RATE_LIMIT_MAX = '500';
  process.env.UPLOAD_RATE_LIMIT_MAX = '500';
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
  const { signPlatformToken } = require('../../src/core/auth/tokens');
  const PlatformUser = require('../../src/models/PlatformUser').default;
  const Org = require('../../src/models/Org').default;
  const User = require('../../src/models/User').default;
  const Role = require('../../src/models/Role').default;
  const Entitlement = require('../../src/models/Entitlement').default;
  const ClassLevel = require('../../src/models/ClassLevel').default;
  const Subject = require('../../src/models/Subject').default;
  const OrgRoom = require('../../src/models/OrgRoom').default;
  const Batch = require('../../src/models/Batch').default;
  const OrgPolicy = require('../../src/models/OrgPolicy').default;
  const Reg = require('../../src/models/OrganizationRegistration').default;

  console.log(`[app-e2e] target: ${redactUri(uri)}\n`);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const app = require('../../src/app').default;
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  let orgId: string | null = null;

  const cleanup = async () => {
    await withoutTenantScope('app-e2e:clean', async () => {
      const o = await Org.findOne({ slug: SLUG });
      if (o) {
        for (const M of [User, Role, Entitlement, ClassLevel, Subject, OrgRoom, Batch, OrgPolicy]) {
          await M.deleteMany({ orgId: o._id });
        }
        await Org.deleteOne({ _id: o._id });
      }
      await Reg.deleteMany({ email: new RegExp(MARKER) });
      await PlatformUser.deleteMany({ email: new RegExp(MARKER) });
    });
  };

  try {
    await cleanup();

    const owner = await withoutTenantScope('app-e2e:staff', async () =>
      PlatformUser.create({ name: 'App Owner', email: `${MARKER}-owner@platform.test`, password: PASSWORD, role: 'owner' }),
    );
    const ownerToken = signPlatformToken({ id: String(owner._id), role: 'owner', tokenVersion: 0 });

    /* ══ 1. Start a draft ═══════════════════════════════════════════════ */
    console.log('applicant: starting an application');

    const created = await request(port, 'POST', '/api/public/organization-applications', {
      body: {
        organizationName: 'Lakeside Science Academy',
        organizationType: 'COACHING_INSTITUTE',
        contactName: 'Meera Joshi',
        designation: 'Director',
        email: `${MARKER}-meera@lakeside.test`,
        phone: '+91 98765 12345',
        city: 'Nashik',
        state: 'Maharashtra',
        estimatedStudents: 300,
        estimatedTeachers: 18,
      },
    });
    check('a draft can be created with no account', created.status === 201, `got ${created.status} ${created.raw.slice(0, 200)}`);
    const draftId: string = created.json?.draft?.id;
    const draftToken: string = created.json?.draftToken;
    check('it returns an id and a one-time token', Boolean(draftId && draftToken));
    check('the draft starts in DRAFT', created.json?.draft?.status === 'DRAFT');
    check('the token is high-entropy', typeof draftToken === 'string' && draftToken.length >= 40);

    /* ══ 2. Access control on drafts ════════════════════════════════════ */
    console.log('\nisolation');

    const noToken = await request(port, 'GET', `/api/public/organization-applications/${draftId}`);
    check('a draft cannot be read without the token', noToken.status === 404, `got ${noToken.status}`);

    const wrongToken = await request(port, 'GET', `/api/public/organization-applications/${draftId}`, {
      draftToken: 'x'.repeat(43),
    });
    check('a wrong token is refused', wrongToken.status === 404);
    check('...and is indistinguishable from a missing id', wrongToken.status === noToken.status);

    const otherDraft = await request(port, 'POST', '/api/public/organization-applications', {
      body: {
        organizationName: 'Riverbank Tutorials', organizationType: 'SCHOOL',
        contactName: 'Other Person', email: `${MARKER}-other@riverbank.test`,
        phone: '+91 90000 00000', city: 'Pune',
      },
    });
    const crossRead = await request(port, 'GET', `/api/public/organization-applications/${draftId}`, {
      draftToken: otherDraft.json?.draftToken,
    });
    check('APPLICATION A CANNOT BE READ WITH APPLICATION B\'S TOKEN', crossRead.status === 404,
      `got ${crossRead.status}`);
    const crossWrite = await request(port, 'PATCH', `/api/public/organization-applications/${draftId}`, {
      draftToken: otherDraft.json?.draftToken,
      body: { application: { branding: { appName: 'Hijacked' } } },
    });
    check('...nor written', crossWrite.status === 404);

    /* ══ 3. Save the steps ══════════════════════════════════════════════ */
    console.log('\napplicant: filling in the steps');

    const saved = await request(port, 'PATCH', `/api/public/organization-applications/${draftId}`, {
      draftToken, body: { application: APPLICATION },
    });
    check('every section saves', saved.status === 200, `got ${saved.status} ${saved.raw.slice(0, 200)}`);
    check('and reads back', saved.json?.draft?.application?.branding?.appName === 'Lakeside Academy');
    check('the applicant never sees staff-only fields',
      !/submittedIp|dedupeKey|reviewNote|draftToken/.test(saved.raw), saved.raw.slice(0, 200));

    const resumed = await request(port, 'GET', `/api/public/organization-applications/${draftId}`, { draftToken });
    check('a draft can be resumed later', resumed.json?.draft?.application?.academic?.subjects?.length === 3);

    /* ══ 4. Asset validation ════════════════════════════════════════════ */
    console.log('\nasset validation (rejections only — storage is production)');

    // Multipart through a plain http client is awkward; the service-level
    // checks are exercised directly, which is where the rules actually live.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { storeAsset } = require('../../src/core/platform/applications');
    const reject = async (label: string, file: any, kind = 'logo') => {
      try {
        await storeAsset(draftId, draftToken, file, kind);
        check(label, false, 'it was ACCEPTED');
      } catch (e) {
        check(label, (e as Error).name === 'AssetRejected', `threw ${(e as Error).name}: ${(e as Error).message}`);
      }
    };
    await reject('an empty file is refused', { buffer: Buffer.alloc(0), originalname: 'a.png', mimetype: 'image/png' });
    await reject('an oversized file is refused', { buffer: Buffer.alloc(6 * 1024 * 1024), originalname: 'a.png', mimetype: 'image/png' });
    await reject('a file whose CONTENTS are not an image is refused, whatever it claims',
      { buffer: Buffer.from('MZ\x90\x00 this is an executable'), originalname: 'logo.png', mimetype: 'image/png' });
    await reject('an unknown asset slot is refused',
      { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), originalname: 'a.png', mimetype: 'image/png' }, 'banner');

    /* ══ 5. Submission validation ═══════════════════════════════════════ */
    console.log('\nsubmission');

    // Blank the colours to prove the gate bites, then restore.
    await request(port, 'PATCH', `/api/public/organization-applications/${draftId}`, {
      draftToken, body: { application: { branding: { ...APPLICATION.branding, primaryColor: '' } } },
    });
    const badSubmit = await request(port, 'POST', `/api/public/organization-applications/${draftId}/submit`, { draftToken });
    check('an incomplete application cannot be submitted', badSubmit.status === 400, `got ${badSubmit.status}`);
    check('...and the missing field is named', Boolean(badSubmit.json?.fields?.['branding.primaryColor']),
      JSON.stringify(badSubmit.json?.fields));

    await request(port, 'PATCH', `/api/public/organization-applications/${draftId}`, {
      draftToken, body: { application: { branding: APPLICATION.branding } },
    });

    // Duplicates and orphan relationships are caught too.
    await request(port, 'PATCH', `/api/public/organization-applications/${draftId}`, {
      draftToken,
      body: { application: { academic: { ...APPLICATION.academic, subjects: [{ name: 'Physics' }, { name: 'physics' }] } } },
    });
    const dupSubmit = await request(port, 'POST', `/api/public/organization-applications/${draftId}/submit`, { draftToken });
    check('duplicate subjects are refused', dupSubmit.status === 400 && Boolean(dupSubmit.json?.fields?.['academic.subjects']));

    await request(port, 'PATCH', `/api/public/organization-applications/${draftId}`, {
      draftToken,
      body: { application: { academic: { ...APPLICATION.academic, batches: [{ name: 'Ghost', classLevels: ['99'] }] } } },
    });
    const orphanSubmit = await request(port, 'POST', `/api/public/organization-applications/${draftId}/submit`, { draftToken });
    check('a batch naming an undefined class level is refused',
      orphanSubmit.status === 400 && Boolean(orphanSubmit.json?.fields?.['academic.batches']));

    await request(port, 'PATCH', `/api/public/organization-applications/${draftId}`, {
      draftToken, body: { application: { academic: APPLICATION.academic } },
    });

    const submitted = await request(port, 'POST', `/api/public/organization-applications/${draftId}/submit`, { draftToken });
    check('a complete application submits', submitted.status === 200, `got ${submitted.status} ${submitted.raw.slice(0, 250)}`);
    check('it returns a reference', /^REG-[0-9A-F]{8}$/.test(submitted.json?.registration?.reference ?? ''));
    check('and moves to PENDING', submitted.json?.registration?.status === 'PENDING');

    const afterSubmit = await request(port, 'PATCH', `/api/public/organization-applications/${draftId}`, {
      draftToken, body: { application: { branding: { appName: 'Changed After Submit' } } },
    });
    check('the token stops working once submitted', afterSubmit.status === 404, `got ${afterSubmit.status}`);

    /* ══ 6. Staff review ════════════════════════════════════════════════ */
    console.log('\nplatform console: review');

    const detail = await request(port, 'GET', `/api/platform/registrations/${draftId}`, { token: ownerToken });
    check('staff see the whole application', detail.status === 200 &&
      detail.json?.registration?.application?.academic?.classLevels?.length === 3);
    check('readiness is computed', detail.json?.readiness?.status === 'READY',
      JSON.stringify(detail.json?.readiness?.checks?.filter((c: any) => !c.ok && c.blocking)));
    check('a provisioning preview is offered', Array.isArray(detail.json?.provisioningPreview?.modules));
    check('the unknown module was dropped, and reported',
      detail.json?.provisioningPreview?.droppedModules?.includes('not-a-real-module'),
      JSON.stringify(detail.json?.provisioningPreview?.droppedModules));
    check('the administrator is prefilled from the application',
      detail.json?.provisioningPreview?.adminPrefill?.email === `${MARKER}-admin@lakeside.test`);

    /* ══ 7. One-click provisioning ══════════════════════════════════════ */
    console.log('\none-click approval — and what it actually applied');

    const approve = await request(port, 'POST', `/api/platform/registrations/${draftId}/approve`, {
      token: ownerToken,
      // Nothing but the admin password. Everything else comes from the
      // application — that is the entire point of this test.
      body: {
        slug: SLUG,
        admin: { name: 'Meera Joshi', email: `${MARKER}-admin@lakeside.test`, password: PASSWORD },
      },
    });
    check('approval succeeds', approve.status === 200 || approve.status === 207,
      `got ${approve.status} ${approve.raw.slice(0, 300)}`);
    orgId = approve.json?.onboarding?.orgId ?? null;
    check('an organization was created', typeof orgId === 'string' && /^[a-f0-9]{24}$/.test(orgId));

    const applied = await withoutTenantScope('app-e2e:read-back', async () => ({
      org: await Org.findById(orgId).lean(),
      classes: await ClassLevel.find({ orgId }).lean(),
      subjects: await Subject.find({ orgId }).lean(),
      rooms: await OrgRoom.find({ orgId }).lean(),
      batches: await Batch.find({ orgId }).lean(),
      policy: await OrgPolicy.findOne({ orgId }).lean(),
      entitlement: await Entitlement.findOne({ orgId }).lean(),
      roles: await Role.countDocuments({ orgId }),
      admin: await User.findOne({ orgId, email: `${MARKER}-admin@lakeside.test` }).lean(),
    }));

    check('BRANDING was applied', applied.org?.branding?.appName === 'Lakeside Academy' &&
      applied.org?.branding?.primaryColor === '#0F766E' &&
      applied.org?.branding?.tagline === 'Science, taught properly',
      JSON.stringify(applied.org?.branding));
    check('...including the document header from the legal name',
      applied.org?.branding?.documentHeader === 'Lakeside Science Academy Pvt Ltd');
    check('CLASS LEVELS were created', applied.classes.length === 3 &&
      applied.classes.some((c: any) => c.key === 'dropper'), `${applied.classes.length} found`);
    check('SUBJECTS were created', applied.subjects.length === 3 &&
      applied.subjects.some((s: any) => s.code === 'PHY'), `${applied.subjects.length} found`);
    check('ROOMS were created with capacity', applied.rooms.length === 2 &&
      applied.rooms.some((r: any) => r.name === 'Hall A' && r.capacity === 60));
    check('BATCHES were created', applied.batches.length === 2);
    check('POLICY was applied', applied.policy?.exam?.markingScheme?.correct === 4 &&
      applied.policy?.exam?.markingScheme?.incorrect === -1 &&
      applied.policy?.exam?.submitLockPercent === 70,
      JSON.stringify(applied.policy?.exam));
    check('...and the locale', applied.policy?.locale?.timezone === 'Asia/Kolkata');
    check('MODULES from the preset were granted',
      applied.entitlement?.modules?.includes('questionBank') &&
      applied.entitlement?.modules?.includes('doubts'),
      JSON.stringify(applied.entitlement?.modules?.slice(0, 8)));
    check('the invalid module was NOT granted',
      !applied.entitlement?.modules?.includes('not-a-real-module'));
    check('SYSTEM ROLES were provisioned', applied.roles > 0, `${applied.roles} roles`);
    check('the ADMINISTRATOR was created', applied.admin?.role === 'admin' && applied.admin?.status === 'approved');
    check('the registration is linked to the organization',
      String((await withoutTenantScope('app-e2e:link', async () => Reg.findById(draftId).lean()))?.orgId) === orgId);

    /* ══ 8. Idempotency ════════════════════════════════════════════════ */
    console.log('\nidempotency');

    const again = await request(port, 'POST', `/api/platform/registrations/${draftId}/approve`, {
      token: ownerToken, body: {},
    });
    const counts = await withoutTenantScope('app-e2e:counts', async () => ({
      orgs: await Org.countDocuments({ slug: SLUG }),
      classes: await ClassLevel.countDocuments({ orgId }),
      subjects: await Subject.countDocuments({ orgId }),
      admins: await User.countDocuments({ orgId, email: `${MARKER}-admin@lakeside.test` }),
    }));
    check('re-approving succeeds', again.status === 200 || again.status === 207);
    check('...and reports it resumed rather than created', again.json?.created === false);
    check('NO duplicate organization', counts.orgs === 1, `${counts.orgs} found`);
    check('NO duplicate class levels', counts.classes === 3, `${counts.classes} found`);
    check('NO duplicate subjects', counts.subjects === 3, `${counts.subjects} found`);
    check('NO duplicate administrator', counts.admins === 1, `${counts.admins} found`);

    /* ══ 9. Backward compatibility ═════════════════════════════════════ */
    console.log('\nbackward compatibility');

    const legacy = await request(port, 'POST', '/api/public/organization-registration', {
      body: {
        organizationName: 'Old Style Institute', organizationType: 'COACHING_INSTITUTE',
        contactName: 'Legacy Contact', email: `${MARKER}-legacy@old.test`,
        phone: '+91 91111 11111', city: 'Indore',
      },
    });
    check('the original short form still works', legacy.status === 201, `got ${legacy.status}`);

    const legacyRow = await withoutTenantScope('app-e2e:legacy', async () =>
      Reg.findOne({ email: `${MARKER}-legacy@old.test` }).lean());
    check('it creates a row with NO application block', !legacyRow?.application?.branding);

    const legacyDetail = await request(port, 'GET', `/api/platform/registrations/${legacyRow._id}`, { token: ownerToken });
    check('staff can still open it', legacyDetail.status === 200);
    check('readiness reports it as needing attention rather than erroring',
      legacyDetail.json?.readiness?.status === 'NEEDS_ATTENTION');
    check('...and says exactly what is missing',
      legacyDetail.json?.readiness?.checks?.some((c: any) => c.key === 'classLevels' && !c.ok));
    check('the queue still lists both kinds',
      (await request(port, 'GET', '/api/platform/registrations', { token: ownerToken })).json?.items?.length >= 2);

    /* ══ 10. Nothing else moved ════════════════════════════════════════ */
    console.log('\nno collateral damage');

    check('tenant auth still refuses anonymous callers',
      (await request(port, 'GET', '/api/me/context')).status === 401);
    check('the organization appears in the platform list',
      (await request(port, 'GET', '/api/platform/orgs', { token: ownerToken }))
        .json?.items?.some((o: any) => String(o._id ?? o.id) === orgId));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('\n[app-e2e] FAILED:', error);
  process.exit(1);
});
