/**
 * Public (pre-authentication) routes on the platform runtime, with two
 * organizations — what each one returns, and what it changes, with and without
 * an organization hint.
 *
 * The allowlisted public routes (core/tenancy/publicRoutes) run UNSCOPED when
 * no organization can be resolved from the request. On the platform runtime
 * that means across every organization. This suite seeds two organizations
 * with distinct marker values and asserts what must hold for a multi-tenant
 * rollout:
 *
 *   - with a hint, a route answers for that organization only;
 *   - without one, no route reveals one organization's data next to another's;
 *   - no public read changes another organization's data.
 *
 * Run under either mode (E2E_TENANT_ENFORCEMENT=warn|enforce). Loopback
 * MongoDB only — it writes its fixture:
 *
 *   SCRATCH_DB_NAME=iso_platform_scratch_public SCRATCH_ALLOW_NEW_DB=true \
 *   E2E_TENANT_ENFORCEMENT=enforce \
 *     npx ts-node --transpile-only scripts/safety/public-routes-tenancy.e2e.test.ts
 */

import { Checks, bootScratchApp, request, scratchUriFor } from './e2eHarness';
import { requireEnv } from './lib';

const c = new Checks();

function loopbackOnly(uri: string) {
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/);
  const hosts = (m?.[1] ?? '').toLowerCase().split(',');
  if (
    !hosts.every((h) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h))
  ) {
    throw new Error(
      `Refusing to run: loopback MongoDB only (got ${hosts.join(',')}).`,
    );
  }
}

async function main() {
  loopbackOnly(scratchUriFor(requireEnv('MONGO_URI')));
  const mode = process.env.E2E_TENANT_ENFORCEMENT || 'warn';
  const app = await bootScratchApp();
  const mongoose = app.mongoose;
  const col = (model: string) => mongoose.model(model).collection;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../../src/models/ScholarshipTest');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../../src/models/StudyResource');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../../src/models/Batch');

  const stamp = Date.now().toString(36);
  const A = new mongoose.Types.ObjectId();
  const B = new mongoose.Types.ObjectId();
  // Tenant rows carry orgId as a STRING — the tenancy plugin's field type.
  const a = String(A);
  const b = String(B);
  const now = new Date();
  try {
    // ── Fixture: written directly, so nothing the app does decides its orgId ──
    await col('Org').insertMany([
      {
        _id: A,
        name: `Probe A ${stamp}`,
        slug: `probe-a-${stamp}`,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        _id: B,
        name: `Probe B ${stamp}`,
        slug: `probe-b-${stamp}`,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await col('Batch').insertMany([
      { name: 'Advanced', classLevels: ['11'], orgId: a, isDefault: false },
      { name: 'Basic', classLevels: ['11'], orgId: a, isDefault: false },
      {
        name: 'Basic',
        classLevels: ['12'],
        orgId: b,
        isDefault: false,
        marker: `b-basic-${stamp}`,
      },
      {
        name: `Morning-${stamp}`,
        classLevels: ['12'],
        orgId: b,
        isDefault: false,
      },
    ]);
    await col('User').insertMany([
      {
        name: 'Probe A student',
        email: `pa-${stamp}@iso.test`,
        role: 'student',
        batch: 'Advanced',
        orgId: a,
        classLevel: '11',
      },
      {
        name: 'Probe B student',
        email: `pb-${stamp}@iso.test`,
        role: 'student',
        batch: 'Basic',
        orgId: b,
        classLevel: '12',
      },
    ]);
    await col('ScholarshipTest').insertMany([
      {
        title: `PROBE_A_TEST_${stamp}`,
        isActive: true,
        orgId: a,
        createdAt: now,
      },
      {
        title: `PROBE_B_TEST_${stamp}`,
        isActive: true,
        orgId: b,
        createdAt: now,
      },
    ]);
    await col('StudyResource').insertMany([
      {
        title: 'a',
        subject: `ProbeSubjA${stamp}`,
        status: 'published',
        orgId: a,
      },
      {
        title: 'b',
        subject: `ProbeSubjB${stamp}`,
        status: 'published',
        orgId: b,
      },
    ]);

    const get = (path: string, hint?: string) =>
      request(app.port, 'GET', path, {
        headers: hint ? { 'X-Org-Id': hint } : {},
      });
    const has = (raw: string, marker: string) => raw.includes(marker);
    const bState = async () => ({
      basic: await col('Batch').countDocuments({ orgId: b, name: 'Basic' }),
      merged: await col('Batch').countDocuments({
        orgId: b,
        name: 'Advanced/Basic',
      }),
      user: (await col('User').findOne({ email: `pb-${stamp}@iso.test` }))
        ?.batch,
    });

    c.section(
      `Public reads with an organization hint (TENANT_ENFORCEMENT=${mode})`,
    );
    let r = await get('/api/scholarship/tests', String(A));
    c.check(
      'scholarship tests, hint A → A only',
      r.status === 200 &&
        has(r.raw, `PROBE_A_TEST_${stamp}`) &&
        !has(r.raw, `PROBE_B_TEST_${stamp}`),
      `${r.status} ${r.raw.slice(0, 160)}`,
    );
    r = await get('/api/scholarship/tests', `probe-b-${stamp}`);
    c.check(
      '…hint B (by slug) → B only',
      r.status === 200 &&
        has(r.raw, `PROBE_B_TEST_${stamp}`) &&
        !has(r.raw, `PROBE_A_TEST_${stamp}`),
      `${r.status}`,
    );

    const before = await bState();
    r = await get('/api/auth/public-student-batch-config', String(A));
    const afterHintA = await bState();
    c.check(
      'batch config, hint A → answers',
      r.status === 200,
      `${r.status} ${r.raw.slice(0, 160)}`,
    );
    c.check(
      "…and leaves organization B's batches and students untouched",
      JSON.stringify(before) === JSON.stringify(afterHintA),
      `${JSON.stringify(before)} → ${JSON.stringify(afterHintA)}`,
    );
    c.check("…and never shows B's batches", !has(r.raw, `Morning-${stamp}`));

    r = await get('/api/class-requests/options', String(A));
    c.check(
      "class-request options, hint A → A's subjects, not B's",
      r.status === 200 &&
        has(r.raw, `ProbeSubjA${stamp}`) &&
        !has(r.raw, `ProbeSubjB${stamp}`),
      `${r.status}`,
    );

    const unattributedMerged = () =>
      col('Batch').countDocuments({
        name: 'Advanced/Basic',
        $or: [{ orgId: { $exists: false } }, { orgId: null }],
      });
    const orphanBefore = await unattributedMerged();

    c.section(`Public reads WITHOUT a hint (TENANT_ENFORCEMENT=${mode})`);
    r = await get('/api/scholarship/tests');
    const bothTests =
      has(r.raw, `PROBE_A_TEST_${stamp}`) &&
      has(r.raw, `PROBE_B_TEST_${stamp}`);
    c.check(
      "scholarship tests: never A's and B's side by side",
      !bothTests,
      `status ${r.status}; both organizations' tests returned together`,
    );

    r = await get('/api/class-requests/options');
    const bothSubjects =
      has(r.raw, `ProbeSubjA${stamp}`) && has(r.raw, `ProbeSubjB${stamp}`);
    c.check(
      "class-request options: never A's and B's subjects together",
      !bothSubjects,
      `status ${r.status}; both organizations' subjects returned together`,
    );
    const afterOptions = await bState();
    c.check(
      "class-request options (no hint) changes nothing of B's",
      JSON.stringify(afterHintA) === JSON.stringify(afterOptions),
      `${JSON.stringify(afterHintA)} → ${JSON.stringify(afterOptions)}`,
    );

    r = await get('/api/auth/public-student-batch-config');
    const afterNoHint = await bState();
    c.check(
      "batch config (no hint): never shows B's batches",
      !has(r.raw, `Morning-${stamp}`),
      `status ${r.status}`,
    );
    c.check(
      "batch config (no hint) changes nothing of B's — no cross-organization merge, delete or rename",
      JSON.stringify(afterOptions) === JSON.stringify(afterNoHint),
      `${JSON.stringify(afterOptions)} → ${JSON.stringify(afterNoHint)}`,
    );
    const orphanAfter = await unattributedMerged();
    c.check(
      '…and creates no batch without an organization',
      orphanAfter === orphanBefore,
      `${orphanAfter - orphanBefore} new unattributed "Advanced/Basic" batch(es)`,
    );

    for (const path of [
      '/api/scholarship/tests',
      '/api/class-requests/options',
      '/api/auth/public-student-batch-config',
      '/api/agts/tests',
    ]) {
      r = await get(path);
      c.check(
        `${path} (no hint) is refused: 400 ORG_REQUIRED`,
        r.status === 400 && r.json?.code === 'ORG_REQUIRED',
        `${r.status} ${r.raw.slice(0, 120)}`,
      );
    }
    r = await request(app.port, 'POST', '/api/agts/register', {
      body: { name: 'probe' },
    });
    c.check(
      'POST /api/agts/register (no hint) is refused: 400 ORG_REQUIRED',
      r.status === 400 && r.json?.code === 'ORG_REQUIRED',
      `${r.status}`,
    );

    r = await get('/api/health');
    c.check('health answers without a hint', r.status === 200);

    c.section('Public writes without a hint');
    r = await request(app.port, 'POST', '/api/class-requests', {
      body: {
        name: 'Probe guest',
        classValue: '11',
        subject: 'Physics',
        reason: 'probe',
        preferredTiming: 'evening',
      },
    });
    const unattributed = await mongoose.connection.db
      .collection('classrequests')
      .countDocuments({
        name: 'Probe guest',
        $or: [{ orgId: { $exists: false } }, { orgId: null }],
      });
    c.check(
      'a guest class request with no organization is refused, never stored unattributed',
      r.status >= 400 && unattributed === 0,
      `status ${r.status}; ${unattributed} unattributed row(s); ${r.raw.slice(0, 160)}`,
    );
  } finally {
    await app.close();
  }
  c.report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
