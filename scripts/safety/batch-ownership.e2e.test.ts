/**
 * Batches belong to their organization — and are optional.
 *
 * Business rule: each organization owns and manages its own batches. Batch
 * configuration is optional and organization-specific, and the platform never
 * merges Abhigyan's default batches (or anything else) into an organization's
 * data on its own.
 *
 * Platform runtime (default): organizations A and B have OVERLAPPING batch
 * names (both have Advanced, Basic and Morning); C has none. Checks that
 *   - reading batches never merges, renames, deletes or creates anything;
 *   - A cannot read, update, rename, delete, re-home or create B's batches;
 *   - public routes that expose batch options require an organization, and
 *     without one fail before touching any data;
 *   - C works with no batches until it creates one.
 *
 * Existing system (`--existing`): Abhigyan's historical Advanced+Basic merge
 * still happens there, exactly as before.
 *
 * Loopback MongoDB only — it writes fixtures:
 *   SCRATCH_DB_NAME=iso_platform_scratch_batches SCRATCH_ALLOW_NEW_DB=true \
 *   E2E_TENANT_ENFORCEMENT=warn|enforce \
 *     npx ts-node --transpile-only scripts/safety/batch-ownership.e2e.test.ts [--existing]
 */

import {
  Checks,
  bootScratchApp,
  request,
  scratchUriFor,
  type Res,
} from './e2eHarness';
import { requireEnv } from './lib';

const c = new Checks();
const EXISTING = process.argv.includes('--existing');

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

const brief = (r: Res) => `${r.status} ${r.raw.slice(0, 200)}`;
const names = (rows: Array<Record<string, unknown>>) =>
  rows.map((b) => String(b.name)).sort();

async function platformRun() {
  const mode = process.env.E2E_TENANT_ENFORCEMENT || 'warn';
  const app = await bootScratchApp();
  const mongoose = app.mongoose;
  const db = mongoose.connection.db;
  const col = (name: string) => db.collection(name);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { withoutTenantScope } = require('../../src/core/tenancy/context');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const User = require('../../src/models/User').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    clearHostResolutionCache,
  } = require('../../src/core/tenancy/hostResolution');
  const unscoped = <T>(fn: () => Promise<T>) =>
    withoutTenantScope('e2e:batch-ownership', fn) as Promise<T>;

  const RUN = `zz-batch-${Date.now().toString(36)}`;
  const PASSWORD = `Batch-${process.pid}-Pass!`;
  const call = (
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; org?: string } = {},
  ) =>
    request(app.port, method, path, {
      token: opts.token,
      body: opts.body,
      headers: opts.org ? { 'X-Org-Id': opts.org } : undefined,
    });

  try {
    console.log(
      `\nBATCH OWNERSHIP — platform runtime, TENANT_ENFORCEMENT=${mode} (db: ${app.dbName})`,
    );
    c.section('fixtures');
    const now = new Date();
    const orgIds: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' };
    for (const key of ['A', 'B', 'C'] as const) {
      const _id = new mongoose.Types.ObjectId();
      await col('orgs').insertOne({
        _id,
        name: `${RUN}-${key}`,
        slug: `${RUN}-${key.toLowerCase()}`,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      orgIds[key] = String(_id);
    }
    clearHostResolutionCache?.();
    const { A, B, C } = orgIds;

    // Index builds run in the background after boot; wait for Batch's, as a
    // database that has had its indexes synced would already have them.
    await mongoose.model('Batch').init();
    const batchIndexes = (await col('batches').indexes()).map(
      (i: { name?: string; unique?: boolean }) =>
        `${i.name}${i.unique ? ' (unique)' : ''}`,
    );
    c.check(
      'batch names are unique per organization (orgId_1_name_1), not globally (no name_1)',
      batchIndexes.includes('orgId_1_name_1 (unique)') &&
        !batchIndexes.some((n) => n.startsWith('name_1')),
      batchIndexes.join(', '),
    );

    for (const key of ['A', 'B', 'C'] as const) {
      await unscoped(() =>
        User.create({
          name: `${RUN}-${key}-admin`,
          email: `${RUN}-${key.toLowerCase()}-admin@example.test`,
          password: PASSWORD,
          role: 'admin',
          status: 'approved',
          orgId: orgIds[key],
        }),
      );
    }
    // Overlapping names in A and B; nothing in C. Written directly so nothing
    // the app does decides where they land.
    const B_ONLY = `${RUN}-BOnly`;
    const seedBatch = (org: string, name: string, classLevels: string[]) =>
      col('batches').insertOne({
        name,
        classLevels,
        isDefault: false,
        orgId: org,
        createdAt: now,
        updatedAt: now,
      });
    for (const org of [A, B]) {
      await seedBatch(org, 'Advanced', ['11']);
      await seedBatch(org, 'Basic', ['11']);
      await seedBatch(org, 'Morning', ['12']);
    }
    await seedBatch(B, B_ONLY, ['12']);
    await col('users').insertMany([
      {
        name: `${RUN}-A-s1`,
        email: `${RUN}-a-s1@example.test`,
        role: 'student',
        status: 'approved',
        classLevel: 'Class 11',
        batch: 'Basic',
        orgId: A,
      },
      {
        name: `${RUN}-B-s1`,
        email: `${RUN}-b-s1@example.test`,
        role: 'student',
        status: 'approved',
        classLevel: 'Class 11',
        batch: 'Basic',
        orgId: B,
      },
      {
        name: `${RUN}-B-s2`,
        email: `${RUN}-b-s2@example.test`,
        role: 'student',
        status: 'approved',
        classLevel: 'Class 11',
        batch: 'Advanced',
        orgId: B,
      },
    ]);
    // Teacher-picker fixtures. Picker names come from three places: exams the
    // teacher created, approved students' batch fields, and the teacher's own
    // batch. Each source gets a name only one organization uses.
    const A_ONLY = `${RUN}-AOnly`;
    const B_TEACHER_ONLY = `${RUN}-BTeacherOnly`;
    const B_EXAM_ONLY = `${RUN}-BExamOnly`;
    const B_CROSS_EXAM = `${RUN}-BCrossExam`;
    const teacher = (key: 'A' | 'B' | 'C', batch?: string) =>
      unscoped<{ _id: unknown }>(() =>
        User.create({
          name: `${RUN}-${key}-teacher`,
          email: `${RUN}-${key.toLowerCase()}-teacher@example.test`,
          password: PASSWORD,
          role: 'teacher',
          status: 'approved',
          empCode: `${RUN}-${key}-T1`,
          orgId: orgIds[key],
          ...(batch ? { batch } : {}),
        }),
      );
    const tA = await teacher('A', 'Morning');
    const tB = await teacher('B', B_TEACHER_ONLY);
    await teacher('C');
    await col('users').insertMany([
      {
        name: `${RUN}-A-s2`,
        email: `${RUN}-a-s2@example.test`,
        role: 'student',
        status: 'approved',
        classLevel: 'Class 12',
        batch: 'Morning',
        orgId: A,
      },
      {
        name: `${RUN}-A-s3`,
        email: `${RUN}-a-s3@example.test`,
        role: 'student',
        status: 'approved',
        classLevel: 'Class 12',
        batch: A_ONLY,
        orgId: A,
      },
      {
        name: `${RUN}-B-s3`,
        email: `${RUN}-b-s3@example.test`,
        role: 'student',
        status: 'approved',
        classLevel: 'Class 12',
        batch: B_ONLY,
        orgId: B,
      },
      {
        name: `${RUN}-B-s4`,
        email: `${RUN}-b-s4@example.test`,
        role: 'student',
        status: 'approved',
        classLevel: 'Class 12',
        batch: 'Morning',
        orgId: B,
      },
    ]);
    await col('exams').insertMany([
      {
        title: `${RUN}-A-exam`,
        batch: 'Advanced',
        createdBy: tA._id,
        orgId: A,
        createdAt: now,
      },
      {
        title: `${RUN}-B-exam`,
        batch: B_EXAM_ONLY,
        createdBy: tB._id,
        orgId: B,
        createdAt: now,
      },
      // B's exam carrying A's teacher as creator: a picker filtered by
      // creator alone would show it to A's teacher.
      {
        title: `${RUN}-B-cross`,
        batch: B_CROSS_EXAM,
        createdBy: tA._id,
        orgId: B,
        createdAt: now,
      },
      {
        title: `${RUN}-B-cross2`,
        batch: 'Advanced',
        createdBy: tA._id,
        orgId: B,
        createdAt: now,
      },
    ]);

    const batchesOf = (org: string) =>
      col('batches').find({ orgId: org }).sort({ name: 1 }).toArray();
    const snapshotB = async () =>
      JSON.stringify({
        batches: (await batchesOf(B)).map((b) => ({
          id: String(b._id),
          name: b.name,
          classLevels: b.classLevels,
          orgId: b.orgId,
        })),
        users: (
          await col('users').find({ orgId: B }).sort({ email: 1 }).toArray()
        ).map((u) => ({ e: u.email, batch: u.batch })),
      });
    const unattributedBatches = () =>
      col('batches').countDocuments({
        $or: [{ orgId: { $exists: false } }, { orgId: null }],
      });
    const B_BEFORE = await snapshotB();
    const orphansBefore = await unattributedBatches();
    const bBasic = (await col('batches').findOne({ orgId: B, name: 'Basic' }))!;
    const bMorning = (await col('batches').findOne({
      orgId: B,
      name: 'Morning',
    }))!;
    const aBasic = (await col('batches').findOne({ orgId: A, name: 'Basic' }))!;

    const login = async (key: 'A' | 'B' | 'C') => {
      const r = await call('POST', '/api/auth/login', {
        body: {
          email: `${RUN}-${key.toLowerCase()}-admin@example.test`,
          password: PASSWORD,
        },
        org: orgIds[key],
      });
      if (!r.json?.token) throw new Error(`login ${key} failed: ${brief(r)}`);
      return r.json.token as string;
    };
    const tokA = await login('A');
    const tokC = await login('C');
    c.check(
      'three organizations; A and B share batch names (Advanced, Basic, Morning); C has none',
      true,
    );

    // ── 1. Reading batches never changes them ──────────────────────────────
    c.section('no automatic merge: reading batches changes nothing');
    let r = await call('GET', '/api/auth/public-student-batch-config', {
      org: A,
    });
    const class11 = (r.json?.classes ?? []).find(
      (x: { classValue: string }) => x.classValue === '11',
    );
    c.check(
      "public batch config (A) lists A's Advanced and Basic separately — nothing merged",
      r.status === 200 &&
        JSON.stringify(class11?.batches) ===
          JSON.stringify(['Advanced', 'Basic']),
      brief(r),
    );
    r = await call('GET', '/api/schedule/batches', { token: tokA });
    c.check(
      "GET /api/schedule/batches (A admin) → exactly A's three batches",
      r.status === 200 &&
        JSON.stringify(names(r.json)) ===
          JSON.stringify(['Advanced', 'Basic', 'Morning']) &&
        (r.json as Array<{ orgId: string }>).every(
          (b) => String(b.orgId) === A,
        ),
      brief(r),
    );
    r = await call('GET', '/api/schedule/firebase/batches', { token: tokA });
    c.check(
      "GET /api/schedule/firebase/batches (A admin) → A's three, unmerged",
      r.status === 200 && names(r.json).length === 3,
      brief(r),
    );
    r = await call('GET', '/api/class-requests/options', { org: A });
    c.check(
      "class-request options (A) → A's batches only",
      r.status === 200 && !r.raw.includes(B_ONLY),
      brief(r),
    );
    c.check(
      'after all those reads A still has Advanced, Basic and Morning, and no "Advanced/Basic"',
      JSON.stringify(names(await batchesOf(A))) ===
        JSON.stringify(['Advanced', 'Basic', 'Morning']),
      JSON.stringify(names(await batchesOf(A))),
    );
    c.check(
      '…and A\'s student is still in "Basic"',
      (await col('users').findOne({ email: `${RUN}-a-s1@example.test` }))
        ?.batch === 'Basic',
    );

    // ── Teacher batch pickers ──────────────────────────────────────────────
    c.section("teacher batch pickers stay inside the teacher's organization");
    const loginAs = async (email: string, org: string) => {
      const r = await call('POST', '/api/auth/login', {
        body: { email, password: PASSWORD },
        org,
      });
      if (!r.json?.token) throw new Error(`login ${email} failed: ${brief(r)}`);
      return r.json.token as string;
    };
    const tokTA = await loginAs(`${RUN}-a-teacher@example.test`, A);
    const tokTB = await loginAs(`${RUN}-b-teacher@example.test`, B);
    const tokTC = await loginAs(`${RUN}-c-teacher@example.test`, C);
    const B_NAMES = [B_ONLY, B_TEACHER_ONLY, B_EXAM_ONLY, B_CROSS_EXAM];
    const leaksB = (raw: string) => B_NAMES.filter((n) => raw.includes(n));

    r = await call('GET', '/api/teacher/batches', { token: tokTA });
    const pickA = (r.json?.batches ?? []) as Array<{
      name: string;
      studentCount: number;
      examCount: number;
    }>;
    const byName = Object.fromEntries(pickA.map((x) => [x.name, x]));
    c.check(
      'GET /api/teacher/batches (A teacher) → A\'s names only: exam "Advanced", students "Basic", "Morning", A-only, and the teacher\'s own',
      r.status === 200 &&
        JSON.stringify(Object.keys(byName).sort()) ===
          JSON.stringify(['Advanced', 'Basic', 'Morning', A_ONLY].sort()),
      brief(r),
    );
    c.check(
      "…nothing from B — not B's students, teacher, exams, nor B's exam created by A's teacher",
      leaksB(r.raw).length === 0,
      leaksB(r.raw).join(', '),
    );
    c.check(
      '…student counts for a name both organizations use count A\'s students only ("Basic" 1, "Morning" 1)',
      byName.Basic?.studentCount === 1 && byName.Morning?.studentCount === 1,
      JSON.stringify(byName),
    );
    c.check(
      '…exam counts ignore B\'s exam that names A\'s teacher as creator ("Advanced" 1, not 2)',
      byName.Advanced?.examCount === 1,
      JSON.stringify(byName.Advanced),
    );
    r = await call('GET', '/api/teacher/batches', { token: tokTB });
    c.check(
      "GET /api/teacher/batches (B teacher) → B's names, never A's only name",
      r.status === 200 &&
        r.raw.includes(B_ONLY) &&
        r.raw.includes(B_EXAM_ONLY) &&
        r.raw.includes(B_TEACHER_ONLY) &&
        !r.raw.includes(A_ONLY),
      brief(r),
    );
    r = await call('GET', '/api/syllabus/metadata', { token: tokTA });
    c.check(
      "GET /api/syllabus/metadata (A teacher) → A's student batches only",
      r.status === 200 &&
        (r.json?.batches ?? []).includes(A_ONLY) &&
        (r.json?.batches ?? []).includes('Basic') &&
        leaksB(r.raw).length === 0,
      brief(r),
    );
    r = await call('GET', '/api/schedule/batches', { token: tokTA });
    c.check(
      "GET /api/schedule/batches (A teacher) → A's batch documents only",
      r.status === 200 &&
        Array.isArray(r.json) &&
        (r.json as Array<{ orgId: string }>).every(
          (x) => String(x.orgId) === A,
        ) &&
        leaksB(r.raw).length === 0,
      brief(r),
    );
    r = await call('GET', '/api/me/context', { token: tokTA });
    const ctxBatches = (
      (r.json?.configuration?.batches ?? []) as Array<{ name: string }>
    )
      .map((x) => x.name)
      .sort();
    c.check(
      "GET /api/me/context (A teacher) → configuration batches are A's",
      r.status === 200 &&
        JSON.stringify(ctxBatches) ===
          JSON.stringify(['Advanced', 'Basic', 'Morning']),
      `${r.status} ${JSON.stringify(ctxBatches)}`,
    );
    r = await call('GET', '/api/users/student-batch-config', { token: tokTA });
    c.check(
      "GET /api/users/student-batch-config (A teacher) → A's batches only",
      r.status === 200 &&
        r.raw.includes('Morning') &&
        leaksB(r.raw).length === 0,
      brief(r),
    );
    r = await call('GET', '/api/teacher/batches', { token: tokTC });
    c.check(
      'GET /api/teacher/batches (C teacher, no batches anywhere) → empty',
      r.status === 200 && (r.json?.batches ?? []).length === 0,
      brief(r),
    );
    r = await call('GET', '/api/syllabus/metadata', { token: tokTC });
    console.log(
      `      observation — /api/syllabus/metadata for C (no batches) returns batches ${JSON.stringify(r.json?.batches)}`,
    );

    // ── 2. A cannot touch B ────────────────────────────────────────────────
    c.section(
      "organization A cannot read, update, rename, delete, re-home or create B's batches",
    );
    r = await call('GET', '/api/schedule/batches', { token: tokA });
    c.check(
      "A's list never contains a B batch",
      !r.raw.includes(String(bBasic._id)) && !r.raw.includes(B_ONLY),
    );
    r = await call('PUT', `/api/schedule/batches/${String(bBasic._id)}`, {
      token: tokA,
      body: { name: 'Renamed by A' },
    });
    c.check('A renaming B\'s "Basic" by id → 404', r.status === 404, brief(r));
    r = await call('PUT', `/api/schedule/batches/${String(bBasic._id)}`, {
      token: tokA,
      body: { classLevels: ['7'] },
    });
    c.check(
      "A changing B's batch classes by id → 404",
      r.status === 404,
      brief(r),
    );
    r = await call('DELETE', `/api/schedule/batches/${String(bMorning._id)}`, {
      token: tokA,
    });
    c.check(
      'A deleting B\'s "Morning" by id → 404',
      r.status === 404,
      brief(r),
    );
    const evening = `${RUN}-Evening`;
    r = await call('POST', '/api/schedule/batches', {
      token: tokA,
      body: { name: evening, classLevels: ['12'], orgId: B },
    });
    const created = await col('batches').findOne({ name: evening });
    c.check(
      'A creating a batch with orgId: B in the body → created in A, never in B',
      r.status === 201 && !!created && String(created.orgId) === A,
      `${brief(r)} → stored orgId ${created?.orgId}`,
    );
    r = await call('POST', '/api/schedule/batches', {
      token: tokA,
      body: { name: 'Morning', classLevels: ['12'] },
    });
    c.check(
      'A creating a second "Morning" → 409 (unique within A; B\'s "Morning" is irrelevant)',
      r.status === 409,
      brief(r),
    );
    r = await call('PUT', `/api/schedule/batches/${String(aBasic._id)}`, {
      token: tokA,
      body: { name: 'Basic Plus', orgId: B },
    });
    const aBasicAfter = await col('batches').findOne({ _id: aBasic._id });
    c.check(
      'A renaming its own "Basic" with orgId: B in the body → renamed, still A\'s',
      r.status === 200 &&
        aBasicAfter?.name === 'Basic Plus' &&
        String(aBasicAfter?.orgId) === A,
      `${brief(r)} → ${JSON.stringify({ name: aBasicAfter?.name, orgId: aBasicAfter?.orgId })}`,
    );
    c.check(
      'B still has its own "Basic" and its students in it',
      (await col('batches').countDocuments({ orgId: B, name: 'Basic' })) === 1,
    );

    // ── 3. Public routes need an organization ──────────────────────────────
    c.section(
      'public batch options without an organization fail before touching data',
    );
    const everything = async () =>
      JSON.stringify({
        batches: (await col('batches').find({}).sort({ _id: 1 }).toArray()).map(
          (b) => [String(b._id), b.name, b.orgId],
        ),
        users: await col('users').countDocuments({}),
      });
    const beforePublic = await everything();
    for (const path of [
      '/api/auth/public-student-batch-config',
      '/api/class-requests/options',
    ]) {
      r = await call('GET', path);
      c.check(
        `${path} (no organization) → 400 ORG_REQUIRED`,
        r.status === 400 && r.json?.code === 'ORG_REQUIRED',
        brief(r),
      );
    }
    let phoneSeq = 0;
    const registration = (extra: Record<string, unknown>) => ({
      name: `${RUN} applicant`,
      password: PASSWORD,
      phone: `93${String(Date.now() % 1e6).padStart(6, '0')}${String(++phoneSeq).padStart(2, '0')}`,
      board: 'CBSE',
      targetExams: ['JEE Main'],
      profileImage: 'https://example.test/p.png',
      ...extra,
    });
    r = await call('POST', '/api/auth/public-register', {
      body: registration({
        email: `${RUN}-noorg@example.test`,
        classLevel: '12',
        batch: 'Morning',
      }),
    });
    c.check(
      'public registration (no organization) → 400 ORG_REQUIRED',
      r.status === 400 && r.json?.code === 'ORG_REQUIRED',
      brief(r),
    );
    c.check(
      '…and none of them read-modified or created anything',
      (await everything()) === beforePublic,
    );

    r = await call('POST', '/api/auth/public-register', {
      org: A,
      body: registration({
        email: `${RUN}-a-wrong@example.test`,
        classLevel: '12',
        batch: B_ONLY,
      }),
    });
    c.check(
      "registering into A with a batch only B has → refused, and the message names only A's batches",
      r.status === 400 && /Morning/.test(r.raw) && !r.raw.includes(B_ONLY),
      brief(r),
    );
    r = await call('POST', '/api/auth/public-register', {
      org: A,
      body: registration({
        email: `${RUN}-a-ok@example.test`,
        classLevel: '12',
        batch: 'Morning',
      }),
    });
    const regA = await col('users').findOne({
      email: `${RUN}-a-ok@example.test`,
    });
    c.check(
      'registering into A with "Morning" (a name B also has) → A\'s student',
      r.status === 201 &&
        String(regA?.orgId) === A &&
        regA?.batch === 'Morning',
      brief(r),
    );

    // ── 4. Batches are optional ────────────────────────────────────────────
    c.section('organization C has no batches and works until it creates one');
    r = await call('GET', '/api/auth/public-student-batch-config', { org: C });
    c.check(
      'public batch config (C) → every class with no batches and none required',
      r.status === 200 &&
        (r.json?.classes ?? []).length > 0 &&
        (
          r.json.classes as Array<{ batches: string[]; requiresBatch: boolean }>
        ).every((x) => x.batches.length === 0 && !x.requiresBatch),
      brief(r),
    );
    r = await call('GET', '/api/schedule/batches', { token: tokC });
    c.check(
      'GET /api/schedule/batches (C admin) → []',
      r.status === 200 && Array.isArray(r.json) && r.json.length === 0,
      brief(r),
    );
    r = await call('GET', '/api/class-requests/options', { org: C });
    c.check(
      'class-request options (C) → classes with no batches',
      r.status === 200 && !r.raw.includes('Morning'),
      brief(r),
    );
    r = await call('POST', '/api/auth/public-register', {
      org: C,
      body: registration({
        email: `${RUN}-c-reg@example.test`,
        classLevel: '12',
      }),
    });
    const regC = await col('users').findOne({
      email: `${RUN}-c-reg@example.test`,
    });
    c.check(
      'public registration into C without a batch → accepted, no batch',
      r.status === 201 && String(regC?.orgId) === C && regC?.batch === '',
      brief(r),
    );
    r = await call('POST', '/api/users', {
      token: tokC,
      body: {
        name: `${RUN} c student`,
        email: `${RUN}-c-s1@example.test`,
        password: PASSWORD,
        role: 'student',
        empCode: `${RUN}-C1`,
        classLevel: '11',
      },
    });
    c.check(
      'C admin creates a student without a batch → 201',
      r.status === 201,
      brief(r),
    );
    c.check(
      'C still has no batches — nothing was created for it',
      (await col('batches').countDocuments({ orgId: C })) === 0,
    );
    r = await call('POST', '/api/schedule/batches', {
      token: tokC,
      body: { name: 'Morning', classLevels: ['12'] },
    });
    c.check(
      'C creates its first batch, "Morning" (a name A and B also use) → 201',
      r.status === 201,
      brief(r),
    );
    r = await call('GET', '/api/auth/public-student-batch-config', { org: C });
    const c12 = (r.json?.classes ?? []).find(
      (x: { classValue: string }) => x.classValue === '12',
    );
    c.check(
      "…and it now appears in C's batch options, alone",
      JSON.stringify(c12?.batches) === JSON.stringify(['Morning']),
      brief(r),
    );

    // ── 5. Invariants across the whole run ─────────────────────────────────
    c.section('invariants');
    c.check(
      "B's batches and B's students' batches are exactly as seeded",
      (await snapshotB()) === B_BEFORE,
    );
    c.check(
      'no batch without an organization was created',
      (await unattributedBatches()) === orphansBefore,
    );
  } finally {
    await app.close();
  }
}

async function existingRun() {
  // Exactly the existing system's configuration in production: no organization
  // system settings at all (core/tenancy/dataSource blanks them for /api/*).
  const app = await bootScratchApp({
    SERVICE_REALM: 'existing',
    TENANT_MODE: '',
    TENANT_ENFORCEMENT: '',
    ORG_ID: '',
  });
  const col = (name: string) => app.mongoose.connection.db.collection(name);
  const RUN = `zz-batchx-${Date.now().toString(36)}`;
  try {
    console.log(
      `\nBATCH OWNERSHIP — existing system (Abhigyan) (db: ${app.dbName})`,
    );
    c.section("Abhigyan's historical merge is unchanged on /api/*");
    // The existing database has no organizations: rows carry no orgId.
    await col('batches').deleteMany({
      name: { $in: ['Advanced', 'Basic', 'Advanced/Basic', 'Morning'] },
    });
    const now = new Date();
    await col('batches').insertMany([
      {
        name: 'Advanced',
        classLevels: ['11'],
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        name: 'Basic',
        classLevels: ['12'],
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        name: 'Morning',
        classLevels: ['12'],
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await col('users').insertOne({
      name: `${RUN}-s`,
      email: `${RUN}-s@example.test`,
      role: 'student',
      status: 'approved',
      classLevel: 'Class 11',
      batch: 'Basic',
    });
    await col('schedules').insertOne({
      title: `${RUN}-sched`,
      batch: 'Advanced',
      createdAt: now,
    });

    const r = await request(
      app.port,
      'GET',
      '/api/auth/public-student-batch-config',
    );
    const byClass = Object.fromEntries(
      (r.json?.classes ?? []).map(
        (x: { classValue: string; batches: string[] }) => [
          x.classValue,
          x.batches,
        ],
      ),
    );
    c.check(
      'public batch config answers with no organization (as always on /api/*)',
      r.status === 200,
      brief(r),
    );
    c.check(
      'Advanced + Basic were merged into "Advanced/Basic" (classes 11 and 12)',
      JSON.stringify(byClass['11']) === JSON.stringify(['Advanced/Basic']) &&
        (byClass['12'] ?? []).includes('Advanced/Basic'),
      JSON.stringify(byClass),
    );
    const merged = await col('batches').findOne({ name: 'Advanced/Basic' });
    c.check(
      'the merged batch carries both classes and the default flag, as before',
      JSON.stringify(merged?.classLevels) === JSON.stringify(['11', '12']) &&
        merged?.isDefault === true,
      JSON.stringify(merged),
    );
    c.check(
      '"Advanced" and "Basic" were removed, "Morning" untouched',
      (await col('batches').countDocuments({
        name: { $in: ['Advanced', 'Basic'] },
      })) === 0 &&
        (await col('batches').countDocuments({ name: 'Morning' })) === 1,
    );
    c.check(
      'students and schedules moved onto "Advanced/Basic"',
      (await col('users').findOne({ email: `${RUN}-s@example.test` }))
        ?.batch === 'Advanced/Basic' &&
        (await col('schedules').findOne({ title: `${RUN}-sched` }))?.batch ===
          'Advanced/Basic',
    );

    await col('users').deleteMany({ email: { $regex: `^${RUN}` } });
    await col('schedules').deleteMany({ title: { $regex: `^${RUN}` } });
    await col('batches').deleteMany({
      name: { $in: ['Advanced/Basic', 'Morning'] },
    });
  } finally {
    await app.close();
  }
}

async function main() {
  loopbackOnly(scratchUriFor(requireEnv('MONGO_URI')));
  if (EXISTING) await existingRun();
  else await platformRun();
  c.report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
