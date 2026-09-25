/**
 * Tenant-admin isolation — proved over real HTTP, against a real (scratch)
 * database, in BOTH `TENANT_ENFORCEMENT=warn` and `=enforce`.
 *
 * What must hold, whatever the deployment's enforcement setting:
 *
 *   · Organization A's administrator reads Organization A and nothing else —
 *     users, pending registrations, exams, the question bank, courses, leave,
 *     batches, rosters, resources, EOD reports, holidays, guardian links and
 *     both audit trails;
 *   · they cannot approve, edit, delete, verify, invite, reset or sign out
 *     anything of B's, and the refusal is a 404 that reads exactly like an id
 *     that does not exist (no oracle for "B has a record with this id");
 *   · an `orgId` in a request body, or an `X-Org-Id` header naming B, changes
 *     nothing about whose data a request reaches or writes;
 *   · /api/org-admin changes the caller's own organization only — branding,
 *     profile, registration, academic configuration;
 *   · a custom role restricts what the API allows, not just what the UI shows,
 *     and a role borrowed from another organization grants nothing;
 *   · legacy integrations (Firestore, EPUB automation, queue metrics, biometric
 *     attendance) are unavailable to an organization that does not own them;
 *   · a suspended organization is read-only, one being deleted is closed, and a
 *     module the plan does not include is refused even without the header;
 *   · learners, unattached accounts, parents and platform staff each stay on
 *     their own surface;
 *   · sessions are revocable (sign out everywhere, reset, change password),
 *     refresh tokens rotate and die with a revocation, and invitations work
 *     once.
 *
 * Warn used to filter nothing, so every one of the read probes below leaked in
 * warn before this phase. They are run in warn FIRST for that reason.
 *
 *   npx ts-node --transpile-only scripts/safety/tenant-admin-isolation.e2e.test.ts --scratch-suffix scratch_app
 */

import jwt from 'jsonwebtoken';
import { bootScratchApp, Checks, request, type Res } from './e2eHarness';

const RUN = `zz-tai-${process.pid}`;
const PASSWORD = 'Isolate!E2E-Passw0rd';
// `TAI_MODES=off` is the negative control: with tenancy off the probe MUST
// fail, which is how we know it can see a leak at all.
const MODES = (process.env.TAI_MODES ? process.env.TAI_MODES.split(',') : ['warn', 'enforce']) as ('warn' | 'enforce' | 'off')[];

async function main() {
  const t = new Checks();
  const { port, dbName, mongoose, close } = await bootScratchApp({
    PASSWORD_RESET_RATE_LIMIT_MAX: '5000',
    TENANT_WEB_URL: 'https://tenant.example.test',
    LEGACY_DATA_ORG_ID: '',
  });

  /* eslint-disable @typescript-eslint/no-var-requires */
  const { withoutTenantScope } = require('../../src/core/tenancy/context');
  const { clearOrgStateCache } = require('../../src/core/tenancy/orgState');
  const { clearHostResolutionCache } = require('../../src/core/tenancy/hostResolution');
  const { signPlatformToken, signSessionToken } = require('../../src/core/auth/tokens');
  const { MODULES } = require('../../src/core/entitlements/moduleRegistry');
  const { socketPrincipal } = require('../../src/services/SocketService');
  const sockets = require('../../src/services/SocketService').default;
  const Org = require('../../src/models/Org').default;
  const User = require('../../src/models/User').default;
  const PlatformUser = require('../../src/models/PlatformUser').default;
  /* eslint-enable @typescript-eslint/no-var-requires */

  const { ObjectId } = mongoose.Types;
  const db = mongoose.connection.db!;
  const col = (name: string) => db.collection(name);
  const unscoped = <T>(fn: () => Promise<T>) => withoutTenantScope('e2e:tenant-admin', fn) as Promise<T>;

  const cleanup = async () => {
    const orgs = await col('orgs').find({ slug: { $regex: '^zz-tai-' } }).project({ _id: 1 }).toArray();
    const ids = orgs.map((o) => o._id);
    const keys: unknown[] = [...ids, ...ids.map(String)];
    const people = await col('users').find({ email: { $regex: '^zz-tai-' } }).project({ _id: 1 }).toArray();
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c: { name: string }) => c.name);
    for (const name of names) {
      if (name.startsWith('reg_zz_tai')) {
        await db.dropCollection(name).catch(() => undefined);
        continue;
      }
      if (name === 'orgs' || name.startsWith('system.')) continue;
      if (ids.length) await col(name).deleteMany({ orgId: { $in: keys } });
    }
    await col('auditlogs').deleteMany({ userId: { $in: people.map((p) => p._id) } });
    await col('users').deleteMany({ email: { $regex: '^zz-tai-' } });
    await col('platformusers').deleteMany({ email: { $regex: '^zz-tai-' } });
    await col('orgs').deleteMany({ _id: { $in: ids } });
  };

  try {
    await cleanup();
    console.log(`\nTENANT-ADMIN ISOLATION  (db: ${dbName})`);

    /* ══ Fixtures ═══════════════════════════════════════════════════════════ */
    t.section('fixtures');
    const allModules: string[] = MODULES.map((m: { key: string }) => m.key);
    const makeOrg = async (key: string, modules: string[]) => {
      const org = await unscoped(() =>
        Org.create({
          name: `${RUN}-${key.toUpperCase()}- Institute`,
          slug: `${RUN}-${key}`,
          status: 'active',
          branding: { appName: `${RUN}-${key.toUpperCase()}-app` },
          mobile: { androidPackage: `com.zztai.${key}.p${process.pid}` },
        }),
      );
      await col('entitlements').insertOne({
        orgId: org._id,
        modules,
        limits: {},
        status: 'active',
        writable: true,
        version: 1,
        resolvedAt: new Date(),
      });
      return String(org._id);
    };
    const A = await makeOrg('a', allModules);
    const B = await makeOrg('b', allModules);
    const C = await makeOrg('c', allModules); // suspended / deleting
    const D = await makeOrg('d', []); // no optional modules at all
    clearHostResolutionCache();

    const person = (org: string | null, tag: string, role: string, extra: Record<string, unknown> = {}) =>
      unscoped(() =>
        User.create({
          name: `${RUN}-${tag}`,
          email: `${RUN}-${tag.toLowerCase()}@example.test`,
          password: PASSWORD,
          role,
          status: 'approved',
          ...(org ? { orgId: org } : {}),
          ...extra,
        }),
      );

    type Side = {
      org: string;
      admin: any;
      teacher: any;
      student: any;
      victim: any;
      pending: any;
      parent: any;
      ids: Record<string, string>;
    };
    const seedSide = async (key: 'A' | 'B', org: string): Promise<Side> => {
      const M = `${RUN}-${key}-`;
      const admin = await person(org, `${key}-admin`, 'admin');
      const teacher = await person(org, `${key}-teacher`, 'teacher', { empCode: `${M}T1` });
      const student = await person(org, `${key}-student`, 'student', {
        empCode: `${M}S1`,
        phone: key === 'A' ? '9100000001' : '9200000001',
        classLevel: 'Class 10',
        batch: 'Alpha',
      });
      const victim = await person(org, `${key}-victim`, 'student', { empCode: `${M}S2`, classLevel: 'Class 10' });
      const pending = await person(org, `${key}-pending`, 'student', { empCode: `${M}P1`, status: 'pending' });
      const parent = await person(org, `${key}-parent`, 'parent', { phone: '9300000001' });

      const insert = async (name: string, doc: Record<string, unknown>) =>
        String((await col(name).insertOne({ ...doc, orgId: org, createdAt: new Date(), updatedAt: new Date() })).insertedId);
      const ids: Record<string, string> = {
        exam: await insert('exams', { title: `${M}exam`, createdBy: admin._id, isPublished: false }),
        question: await insert('questions', { text: `${M}question`, type: 'mcq', createdBy: admin._id }),
        imported: await insert('importedquestions', { text: `${M}imported`, type: 'mcq', subject: 'Physics' }),
        course: await insert('courses', {
          title: `${M}course`,
          subject: 'Physics',
          classLevel: 'Class 10',
          instructor: teacher._id,
          status: 'draft',
          modules: [],
        }),
        leave: await insert('leaves', {
          teacherId: String(teacher._id),
          teacherName: `${M}teacher`,
          teacherEmail: teacher.email,
          leaveType: 'sick',
          startDate: new Date('2031-03-01'),
          endDate: new Date('2031-03-02'),
          reason: `${M}leave`,
          status: 'pending',
        }),
        batch: await insert('batches', { name: `${M}batch`, classLevels: ['10'] }),
        schedule: await insert('schedules', {
          scheduleType: 'custom',
          type: 'class',
          date: new Date('2031-03-05'),
          startTimeSlot: '10:00',
          endTimeSlot: '11:00',
          subject: `${M}subject`,
          classLevel: '10',
          batch: 'Alpha',
          roomNumber: 1,
          createdBy: admin._id,
          isActive: true,
        }),
        resource: await insert('studyresources', {
          title: `${M}resource`,
          type: 'link',
          url: 'https://example.test/r',
          status: 'published',
          isPublic: false,
          uploadedBy: admin._id,
        }),
        eod: await insert('eods', {
          teacherId: String(teacher._id),
          teacherName: `${M}teacher`,
          date: new Date(),
          classes: [],
          status: 'pending',
          submittedAt: new Date(),
        }),
        holiday: await insert('holidays', {
          date: new Date(Date.UTC(2031, 0, 15)),
          name: `${M}holiday`,
          type: 'holiday',
          createdBy: admin._id,
        }),
        audit: await insert('auditlogs', { userId: admin._id, action: `${M}audit`, status: 'success' }),
        link: await insert('guardianlinks', {
          parentId: parent._id,
          studentId: student._id,
          status: 'pending',
          method: 'student-code+phone',
          requestedAt: new Date(),
        }),
      };
      return { org, admin, teacher, student, victim, pending, parent, ids };
    };
    const a = await seedSide('A', A);
    const b = await seedSide('B', B);

    // Custom roles in A: one narrow, one that may change branding only; and a
    // role in B that grants everything, assigned to an A account.
    const role = async (org: string, key: string, permissions: string[]) =>
      (
        await col('roles').insertOne({
          key,
          name: `${RUN} ${key}`,
          permissions,
          isSystem: false,
          isActive: true,
          orgId: org,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
      ).insertedId;
    const narrowRole = await role(A, 'zz-viewer', ['org.read', 'users.read']);
    const brandRole = await role(A, 'zz-brand', ['org.read', 'org.branding']);
    const everythingInB = await role(B, 'zz-everything', ['org.read', 'org.settings', 'org.branding', 'users.read', 'users.delete', 'audit.read']);
    const narrow = await person(A, 'A-narrow', 'admin', { roleIds: [narrowRole] });
    const brander = await person(A, 'A-brander', 'admin', { roleIds: [brandRole] });
    const borrower = await person(A, 'A-borrower', 'admin', { roleIds: [everythingInB] });
    const adminC = await person(C, 'C-admin', 'admin');
    const adminD = await person(D, 'D-admin', 'admin');
    const learner = await person(null, 'learner', 'student', { accountType: 'PUBLIC_LEARNER' });
    const unattached = await person(null, 'unattached', 'admin');
    // B's parent has a VERIFIED link to B's student (the pending one above is
    // A's probe target); verified parents can sign in.
    const linkedParent = await person(B, 'B-linked-parent', 'parent', { phone: '9300000002' });
    await col('guardianlinks').insertOne({
      orgId: B,
      parentId: linkedParent._id,
      studentId: b.student._id,
      status: 'verified',
      method: 'student-code+phone',
      requestedAt: new Date(),
      verifiedAt: new Date(),
      verifiedByKind: 'org-admin',
    });
    const staff = await unscoped(() =>
      PlatformUser.create({ name: 'TAI Owner', email: `${RUN}-owner@platform.test`, password: PASSWORD, role: 'owner' }),
    );
    t.check('four organizations, two fully populated, with custom roles and edge principals', true);

    /* ══ Helpers ════════════════════════════════════════════════════════════ */
    const call = (method: string, path: string, token?: string, body?: unknown, headers?: Record<string, string>) =>
      request(port, method, path, { token, body, headers });
    const login = async (tag: string, org: string | null, extra: Record<string, unknown> = {}, password = PASSWORD) =>
      call('POST', '/api/auth/login', undefined, { email: `${RUN}-${tag.toLowerCase()}@example.test`, password, ...extra }, org ? { 'X-Org-Id': org } : undefined);
    const tokenOf = async (tag: string, org: string | null) => {
      const res = await login(tag, org);
      if (!res.json?.token) throw new Error(`login ${tag} failed: ${res.status} ${res.raw.slice(0, 200)}`);
      return res.json.token as string;
    };
    const snap = async (name: string, id: string) => JSON.stringify(await col(name).findOne({ _id: new ObjectId(id) }));
    const brief = (r: Res) => `${r.status} ${r.raw.slice(0, 220)}`;
    const ghost = () => new ObjectId().toHexString();

    /* ══ The probe, once per enforcement mode ═══════════════════════════════ */
    for (const mode of MODES) {
      process.env.TENANT_ENFORCEMENT = mode;
      clearOrgStateCache();
      console.log(`\n══════════ TENANT_ENFORCEMENT=${mode} ══════════`);

      const tokA = await tokenOf('A-admin', A);
      const tokB = await tokenOf('B-admin', B);
      const q = (path: string) => `${path}${path.includes('?') ? '&' : '?'}probe=${mode}`;

      /* ── 1. Reads ─────────────────────────────────────────────────────── */
      t.section(`[${mode}] A's administrator reads A only`);
      const lists: [string, string, string][] = [
        ['users', '/api/users', 'student'],
        ['pending registrations', '/api/users/pending', 'pending'],
        ['registration records', '/api/users/registrations', 'pending'],
        ['exams', '/api/exams', 'exam'],
        ['question bank', '/api/exams/questions?limit=5000', 'imported'],
        ['courses', '/api/courses', 'course'],
        ['leave', '/api/leaves', 'leave'],
        ['batches', '/api/schedule/batches', 'batch'],
        ['student roster', '/api/schedule/students', 'student'],
        ['resources', '/api/resources/admin/all', 'resource'],
        ['EOD reports', '/api/eod/admin/all', 'eod'],
        ['holidays', '/api/holidays?year=2031', 'holiday'],
        ['audit log (admin)', '/api/admin/audit-logs?limit=200', 'audit'],
        ['audit log (institute panel)', '/api/org-admin/audit?limit=100', 'audit'],
        ['guardian links', '/api/guardian-links', 'link'],
      ];
      const idOf = (side: Side, key: string) =>
        key === 'student' ? String(side.student._id) : key === 'pending' ? String(side.pending._id) : side.ids[key];
      for (const [label, path, key] of lists) {
        const [ra, rb] = [await call('GET', q(path), tokA), await call('GET', q(path), tokB)];
        const aId = idOf(a, key);
        const bId = idOf(b, key);
        t.check(`${label}: B's own administrator sees B's record (so the probe can see a leak)`, rb.status === 200 && rb.raw.includes(bId), brief(rb));
        t.check(`${label}: A's administrator sees A's and never B's`, ra.status === 200 && ra.raw.includes(aId) && !ra.raw.includes(bId), brief(ra));
      }
      const fbStudents = await call('GET', q('/api/schedule/firebase/students'), tokA);
      t.check(
        'legacy "firebase" roster falls back to A\'s own students, never B\'s',
        fbStudents.status < 500 && !fbStudents.raw.includes(String(b.student._id)),
        brief(fbStudents),
      );
      const overview = await call('GET', '/api/org-admin/overview', tokA);
      t.check(
        'institute overview is A, counting only A\'s pending registrations',
        overview.status === 200 && overview.json?.organization?.id === A && overview.json?.counts?.pendingRegistrations === 1,
        brief(overview),
      );
      for (const path of ['/api/org-admin/profile', '/api/org-admin/branding', '/api/org-admin/registration', '/api/org-admin/configuration', '/api/org-admin/plan']) {
        const r = await call('GET', path, tokA);
        t.check(`${path} answers for A and mentions nothing of B`, r.status === 200 && !r.raw.includes(`${RUN}-B-`) && !r.raw.includes(B), brief(r));
      }
      const reg = await call('GET', '/api/org-admin/registration', tokA);
      t.check('the registration view hides the storage collection from the institute', reg.status === 200 && !reg.json?.store, brief(reg));

      /* ── 2. By id: every action on B's records ─────────────────────────── */
      t.section(`[${mode}] A cannot act on B's records — and cannot tell they exist`);
      const before: Record<string, string> = {};
      const tracked: [string, string][] = [
        ['users', String(b.student._id)],
        ['users', String(b.victim._id)],
        ['users', String(b.pending._id)],
        ['users', String(b.admin._id)],
        ['exams', b.ids.exam],
        ['questions', b.ids.question],
        ['courses', b.ids.course],
        ['leaves', b.ids.leave],
        ['batches', b.ids.batch],
        ['schedules', b.ids.schedule],
        ['studyresources', b.ids.resource],
        ['eods', b.ids.eod],
        ['holidays', b.ids.holiday],
        ['guardianlinks', b.ids.link],
      ];
      for (const [name, id] of tracked) before[`${name}:${id}`] = await snap(name, id);

      const byId: [string, string, (id: string) => string, unknown?][] = [
        ['read a B user', 'GET', (id) => `/api/users/${id}`],
        ['edit a B user', 'PUT', (id) => `/api/users/${id}`, { name: 'hijacked' }],
        ['delete a B user', 'DELETE', (id) => `/api/users/${id}`],
        ['approve a B registration', 'PUT', (id) => `/api/users/${id}/approve`],
        ['reject a B registration', 'PUT', (id) => `/api/users/${id}/reject`],
        ['send a B user a reset link', 'POST', (id) => `/api/org-admin/users/${id}/reset-link`],
        ['re-invite a B user', 'POST', (id) => `/api/org-admin/users/${id}/invite`],
        ['sign a B user out everywhere', 'POST', (id) => `/api/org-admin/users/${id}/sign-out`],
      ];
      const userTarget: Record<string, string> = {
        'read a B user': String(b.admin._id),
        'edit a B user': String(b.student._id),
        'delete a B user': String(b.victim._id),
        'approve a B registration': String(b.pending._id),
        'reject a B registration': String(b.pending._id),
        'send a B user a reset link': String(b.student._id),
        're-invite a B user': String(b.student._id),
        'sign a B user out everywhere': String(b.student._id),
      };
      const recordProbes: [string, string, (id: string) => string, string, unknown?][] = [
        ['read a B exam', 'GET', (id) => `/api/exams/${id}`, b.ids.exam],
        ['edit a B exam', 'PUT', (id) => `/api/exams/${id}`, b.ids.exam, { title: 'hijacked' }],
        ['delete a B exam (and its attempts)', 'DELETE', (id) => `/api/exams/${id}`, b.ids.exam],
        ['assign a B exam', 'POST', (id) => `/api/exams/${id}/assign`, b.ids.exam, { groups: ['10'] }],
        ['edit a B question', 'PUT', (id) => `/api/exams/questions/${id}`, b.ids.question, { text: 'hijacked' }],
        ['delete a B question', 'DELETE', (id) => `/api/exams/questions/${id}`, b.ids.question],
        ['read a B course', 'GET', (id) => `/api/courses/${id}`, b.ids.course],
        ['edit a B course', 'PUT', (id) => `/api/courses/${id}`, b.ids.course, { title: 'hijacked' }],
        ['delete a B course', 'DELETE', (id) => `/api/courses/${id}`, b.ids.course],
        ['read a B leave', 'GET', (id) => `/api/leaves/${id}`, b.ids.leave],
        ['decide a B leave', 'PATCH', (id) => `/api/leaves/${id}/status`, b.ids.leave, { status: 'approved' }],
        ['delete a B leave', 'DELETE', (id) => `/api/leaves/${id}`, b.ids.leave],
        ['rename a B batch', 'PUT', (id) => `/api/schedule/batches/${id}`, b.ids.batch, { name: 'hijacked' }],
        ['delete a B batch', 'DELETE', (id) => `/api/schedule/batches/${id}`, b.ids.batch],
        ['edit a B class', 'PUT', (id) => `/api/schedule/${id}`, b.ids.schedule, { subject: 'hijacked' }],
        ['cancel a B class', 'DELETE', (id) => `/api/schedule/${id}`, b.ids.schedule],
        ['read a B resource', 'GET', (id) => `/api/resources/${id}`, b.ids.resource],
        ['edit a B resource', 'PUT', (id) => `/api/resources/${id}`, b.ids.resource, { title: 'hijacked' }],
        ['delete a B resource', 'DELETE', (id) => `/api/resources/${id}`, b.ids.resource],
        ['review a B EOD', 'PUT', (id) => `/api/eod/admin/${id}/status`, b.ids.eod, { status: 'approved' }],
        ['delete a B EOD', 'DELETE', (id) => `/api/eod/admin/${id}`, b.ids.eod],
        ['edit a B holiday', 'PUT', (id) => `/api/holidays/${id}`, b.ids.holiday, { name: 'hijacked' }],
        ['delete a B holiday', 'DELETE', (id) => `/api/holidays/${id}`, b.ids.holiday],
        ['verify a B parent link', 'POST', (id) => `/api/guardian-links/${id}/verify`, b.ids.link],
        ['revoke a B parent link', 'POST', (id) => `/api/guardian-links/${id}/revoke`, b.ids.link],
      ];
      const probes: [string, string, (id: string) => string, string, unknown?][] = [
        ...byId.map(([label, method, path, body]) => [label, method, path, userTarget[label], body] as [string, string, (id: string) => string, string, unknown?]),
        ...recordProbes,
      ];
      for (const [label, method, path, id, body] of probes) {
        const foreign = await call(method, path(id), tokA, body);
        const missing = await call(method, path(ghost()), tokA, body);
        t.check(
          `${label}: 404, byte-identical to an id that does not exist`,
          foreign.status === 404 && missing.status === 404 && foreign.raw === missing.raw,
          `foreign ${brief(foreign)} | missing ${brief(missing)}`,
        );
      }
      const cachedMiss1 = await call('GET', `/api/courses/${b.ids.course}`, tokA);
      const cachedMiss2 = await call('GET', `/api/courses/${b.ids.course}`, tokA);
      t.check('a refusal is never cached and replayed as a 200', cachedMiss1.status === 404 && cachedMiss2.status === 404, `${brief(cachedMiss1)} | ${brief(cachedMiss2)}`);
      let untouched = true;
      const changed: string[] = [];
      for (const [name, id] of tracked) {
        if ((await snap(name, id)) !== before[`${name}:${id}`]) {
          untouched = false;
          changed.push(`${name}:${id}`);
        }
      }
      t.check('every one of B\'s records is byte-for-byte unchanged afterwards', untouched, changed.join(', '));

      /* ── 3. Naming B does not reach B ─────────────────────────────────── */
      t.section(`[${mode}] naming B in a body or a header reaches nothing of B's`);
      const hinted = await call('GET', '/api/users', tokA, undefined, { 'X-Org-Id': B });
      const mismatch = (r: Res) => (r.status === 400 || r.status === 403) && r.json?.code === 'TENANT_MISMATCH';
      t.check('A\'s token with X-Org-Id: B → refused (TENANT_MISMATCH)', mismatch(hinted), brief(hinted));
      const hintedWrite = await call('PUT', '/api/org-admin/branding', tokA, { branding: { appName: 'hijacked' } }, { 'X-Org-Id': B });
      t.check('...for a write as well', mismatch(hintedWrite), brief(hintedWrite));

      const injectedHoliday = `${RUN}-inj-holiday-${mode}`;
      const hol = await call('POST', '/api/holidays', tokA, { date: `2031-02-0${mode === 'warn' ? 1 : 2}`, name: injectedHoliday, type: 'holiday', orgId: B });
      const holInB = await col('holidays').countDocuments({ name: injectedHoliday, orgId: B });
      t.check('POST /api/holidays with orgId: B writes nothing to B', holInB === 0, `${brief(hol)} inB=${holInB}`);
      const injectedExam = `${RUN}-inj-exam-${mode}`;
      const ex = await call('POST', '/api/exams', tokA, { title: injectedExam, orgId: B, questions: [] });
      const exInB = await col('exams').countDocuments({ title: injectedExam, orgId: B });
      t.check('POST /api/exams with orgId: B writes nothing to B', exInB === 0, `${brief(ex)} inB=${exInB}`);
      const bat = await call('POST', '/api/schedule/batches', tokA, { name: `${RUN}-inj-batch-${mode}`, classLevels: ['10'], orgId: B });
      const batInB = await col('batches').countDocuments({ name: `${RUN}-inj-batch-${mode}`, orgId: B });
      t.check('POST /api/schedule/batches with orgId: B writes nothing to B', batInB === 0, `${brief(bat)} inB=${batInB}`);
      const move = await call('PUT', `/api/schedule/${a.ids.schedule}`, tokA, { orgId: B });
      const moved = await col('schedules').findOne({ _id: new ObjectId(a.ids.schedule) });
      t.check('an update cannot move A\'s class into B', moved?.orgId === A, `${brief(move)} orgId=${moved?.orgId}`);
      const moveUser = await call('PUT', `/api/users/${a.student._id}`, tokA, { orgId: B });
      const movedUser = await col('users').findOne({ _id: a.student._id });
      t.check('...nor A\'s student into B', movedUser?.orgId === A, `${brief(moveUser)} orgId=${movedUser?.orgId}`);

      /* ── 4. The institute panel changes the caller's organization only ── */
      t.section(`[${mode}] /api/org-admin changes A, never B`);
      const bOrgBefore = JSON.stringify(await col('orgs').findOne({ _id: new ObjectId(B) }));
      const bConfigBefore = (await call('GET', '/api/org-admin/configuration', tokB)).raw;
      const brand = await call('PUT', '/api/org-admin/branding', tokA, {
        orgId: B,
        branding: { appName: `${RUN}-A-app-${mode}`, primaryColor: '#1e40af' },
        appExperience: { shortName: `A${mode}` },
      });
      const profile = await call('PUT', '/api/org-admin/profile', tokA, { orgId: B, profile: { city: `A-city-${mode}` } });
      const registration = await call('PUT', '/api/org-admin/registration', tokA, {
        orgId: B,
        policy: 'approval',
        roles: { student: true, teacher: true, parent: true },
        collection: 'users',
      });
      const config = await call('PUT', '/api/org-admin/configuration', tokA, { orgId: B, subjects: [{ name: `A-subject-${mode}` }] });
      const orgA = await col('orgs').findOne({ _id: new ObjectId(A) });
      t.check('branding applied to A', brand.status === 200 && orgA?.branding?.appName === `${RUN}-A-app-${mode}`, brief(brand));
      t.check('profile applied to A', profile.status === 200 && orgA?.profile?.city === `A-city-${mode}`, brief(profile));
      t.check('registration applied to A', registration.status === 200 && orgA?.appExperience?.registrationPolicy === 'approval', brief(registration));
      t.check(
        'a `collection` in the body is ignored — A\'s ledger stays in the reg_ namespace',
        !orgA?.registrationStore?.collection || String(orgA.registrationStore.collection).startsWith('reg_'),
        JSON.stringify(orgA?.registrationStore),
      );
      const aConfig = await call('GET', '/api/org-admin/configuration', tokA);
      t.check('configuration applied to A', config.status === 200 && aConfig.raw.includes(`A-subject-${mode}`), brief(config));
      const bOrgAfter = JSON.stringify(await col('orgs').findOne({ _id: new ObjectId(B) }));
      const bConfigAfter = (await call('GET', '/api/org-admin/configuration', tokB)).raw;
      t.check('B\'s organization record is byte-for-byte unchanged', bOrgAfter === bOrgBefore);
      t.check('B\'s academic configuration is unchanged', bConfigAfter === bConfigBefore && !bConfigAfter.includes('A-subject-'));
      const planWrite = await call('PUT', '/api/org-admin/plan', tokA, { modules: allModules });
      t.check('plan and modules are read-only here (no write route)', planWrite.status === 404, brief(planWrite));

      /* ── 5. Custom roles restrict the API ──────────────────────────────── */
      t.section(`[${mode}] custom roles restrict what the API allows`);
      const tokNarrow = await tokenOf('A-narrow', A);
      const tokBrand = await tokenOf('A-brander', A);
      const tokBorrow = await tokenOf('A-borrower', A);
      const tokTeacher = await tokenOf('A-teacher', A);
      const ctx = await call('GET', '/api/me/context', tokNarrow);
      t.check('a narrowed admin is still reported as an admin account', ctx.status === 200 && ctx.json?.user?.role === 'admin', brief(ctx));
      const allowed: [string, string, string][] = [
        ['narrow (users.read)', 'GET', '/api/users'],
        ['narrow (org.read)', 'GET', '/api/org-admin/overview'],
      ];
      for (const [label, method, path] of allowed) {
        const r = await call(method, path, tokNarrow);
        t.check(`${label}: ${method} ${path} → allowed`, r.status === 200, brief(r));
      }
      const denied: [string, string, string, string, unknown?][] = [
        ['narrow', 'DELETE', `/api/users/${a.victim._id}`, tokNarrow],
        ['narrow', 'PUT', `/api/users/${a.pending._id}/approve`, tokNarrow],
        ['narrow', 'PUT', '/api/org-admin/branding', tokNarrow, { branding: { appName: 'nope' } }],
        ['narrow', 'PUT', '/api/org-admin/registration', tokNarrow, { policy: 'open' }],
        ['narrow', 'POST', '/api/exams', tokNarrow, { title: `${RUN}-narrow-exam` }],
        ['narrow', 'GET', '/api/admin/audit-logs', tokNarrow],
        ['narrow', 'GET', '/api/org-admin/audit', tokNarrow],
        ['narrow', 'GET', '/api/schedule/students', tokNarrow],
        ['narrow', 'GET', '/api/guardian-links', tokNarrow],
        ['narrow', 'POST', '/api/org-admin/invitations', tokNarrow, { name: 'x', email: `${RUN}-nope@example.test`, role: 'admin' }],
        ['branding-only', 'PUT', '/api/org-admin/registration', tokBrand, { policy: 'open' }],
        ['branding-only', 'PUT', '/api/org-admin/configuration', tokBrand, { subjects: [] }],
        ['branding-only', 'GET', '/api/users', tokBrand],
        ['borrowed B role', 'GET', '/api/users', tokBorrow],
        ['borrowed B role', 'GET', '/api/org-admin/overview', tokBorrow],
        ['borrowed B role', 'PUT', '/api/org-admin/profile', tokBorrow, { profile: { city: 'nope' } }],
        ['legacy teacher', 'PUT', '/api/org-admin/branding', tokTeacher, { branding: { appName: 'nope' } }],
        ['legacy teacher', 'GET', '/api/org-admin/audit', tokTeacher],
        ['legacy teacher', 'GET', '/api/users/pending', tokTeacher],
        ['legacy teacher', 'PUT', `/api/users/${a.pending._id}/approve`, tokTeacher],
      ];
      for (const [label, method, path, token, body] of denied) {
        const r = await call(method, path, token, body);
        t.check(`${label}: ${method} ${path.replace(RUN, '…')} → 403`, r.status === 403, brief(r));
      }
      const stillHere = await col('users').findOne({ _id: a.victim._id });
      const stillPending = await col('users').findOne({ _id: a.pending._id });
      t.check('...and nothing they were refused happened', Boolean(stillHere) && stillPending?.status === 'pending');
      const brandOk = await call('PUT', '/api/org-admin/branding', tokBrand, { branding: { tagline: `brand-role-${mode}` } });
      t.check('a role that holds org.branding may change branding', brandOk.status === 200, brief(brandOk));
      const narrowLeave = await call('GET', q('/api/leaves'), tokNarrow);
      t.check(
        'without leaves.approve, leave lists only one\'s own (A\'s teacher leave is not shown)',
        narrowLeave.status === 200 && !narrowLeave.raw.includes(a.ids.leave),
        brief(narrowLeave),
      );
      const studentTok = await tokenOf('A-student', A);
      const studentLeave = await call('GET', q('/api/leaves'), studentTok);
      t.check('a student no longer lists every teacher\'s leave', studentLeave.status === 200 && !studentLeave.raw.includes(a.ids.leave), brief(studentLeave));
      const studentRoster = await call('GET', '/api/schedule/students', studentTok);
      t.check('a student cannot pull the roster with phone numbers', studentRoster.status === 403, brief(studentRoster));

      /* ── 6. Integrations ───────────────────────────────────────────────── */
      t.section(`[${mode}] legacy integrations are unavailable to organizations that do not own them`);
      for (const path of [
        '/api/admin/firebase/stats',
        '/api/admin/firebase/users',
        '/api/attendance/all',
        '/api/attendance/my',
        '/api/automation/status',
        '/api/metrics/queue',
      ]) {
        const r = await call('GET', path, path === '/api/attendance/my' ? studentTok : tokA);
        t.check(`${path} → 404 FEATURE_NOT_AVAILABLE`, r.status === 404 && r.json?.code === 'FEATURE_NOT_AVAILABLE', brief(r));
      }
      const logsAsStudent = await call('GET', `/api/automation/logs?token=${studentTok}`);
      t.check('the automation log stream refuses a student\'s token', logsAsStudent.status === 403, brief(logsAsStudent));
      const logsAsAdmin = await call('GET', `/api/automation/logs?token=${tokA}`);
      t.check(
        '...and A\'s administrator (A does not own the automation)',
        logsAsAdmin.status === 404 && logsAsAdmin.json?.code === 'FEATURE_NOT_AVAILABLE',
        brief(logsAsAdmin),
      );
      const syncAll = await call('POST', '/api/admin/firebase/sync/all', tokA);
      t.check('POST /api/admin/firebase/sync/all → 404 FEATURE_NOT_AVAILABLE', syncAll.status === 404 && syncAll.json?.code === 'FEATURE_NOT_AVAILABLE', brief(syncAll));

      /* ── 7. Organization state and modules ─────────────────────────────── */
      t.section(`[${mode}] suspended is read-only, deleting is closed, modules are enforced`);
      const tokC = await tokenOf('C-admin', C);
      await col('orgs').updateOne({ _id: new ObjectId(C) }, { $set: { status: 'suspended' } });
      clearOrgStateCache();
      const cRead = await call('GET', '/api/org-admin/overview', tokC);
      const cWrite = await call('PUT', '/api/org-admin/profile', tokC, { profile: { city: 'x' } });
      t.check('suspended: reads still work', cRead.status === 200, brief(cRead));
      t.check('suspended: writes → 423 ORG_READ_ONLY', cWrite.status === 423 && cWrite.json?.code === 'ORG_READ_ONLY', brief(cWrite));
      await col('orgs').updateOne({ _id: new ObjectId(C) }, { $set: { status: 'active', deletion: { state: 'running', startedAt: new Date() } } });
      clearOrgStateCache();
      const dRead = await call('GET', '/api/org-admin/overview', tokC);
      const dBrand = await call('PUT', '/api/org-admin/branding', tokC, { branding: { appName: 'x' } });
      const dRegistration = await call('PUT', '/api/org-admin/registration', tokC, { policy: 'open' });
      t.check('being deleted: reads → 423 ORG_DELETING', dRead.status === 423 && dRead.json?.code === 'ORG_DELETING', brief(dRead));
      t.check(
        'being deleted: the admin panel cannot change branding or registration',
        dBrand.status === 423 && dRegistration.status === 423,
        `${brief(dBrand)} | ${brief(dRegistration)}`,
      );
      const cLogin = await login('C-admin', C, { session: 'refresh' });
      const cRefresh = cLogin.json?.refreshToken
        ? await call('POST', '/api/auth/refresh', undefined, { refreshToken: cLogin.json.refreshToken })
        : null;
      t.check(
        'being deleted: a refresh token is not honoured',
        !cRefresh || (cRefresh.status === 401 && cRefresh.json?.code === 'ORG_UNAVAILABLE'),
        cRefresh ? brief(cRefresh) : `login ${brief(cLogin)}`,
      );
      await col('orgs').updateOne({ _id: new ObjectId(C) }, { $unset: { deletion: '' } });
      clearOrgStateCache();

      const tokD = await tokenOf('D-admin', D);
      const dNoHeader = await call('GET', '/api/courses', tokD);
      const dHeader = await call('GET', '/api/courses', tokD, undefined, { 'X-Org-Id': D });
      const dAi = await call('GET', '/api/ai/guidance', tokD);
      t.check('a module the plan lacks is refused WITHOUT the org header', dNoHeader.status === 403 && dNoHeader.json?.code === 'MODULE_NOT_ENABLED', brief(dNoHeader));
      t.check('...and with it', dHeader.status === 403 && dHeader.json?.code === 'MODULE_NOT_ENABLED', brief(dHeader));
      t.check('...including AI', dAi.status === 403 && dAi.json?.code === 'MODULE_NOT_ENABLED', brief(dAi));
      const dCore = await call('GET', '/api/users', tokD);
      t.check('core surfaces stay open for that organization', dCore.status === 200, brief(dCore));

      /* ── 8. Principals on their own surfaces ───────────────────────────── */
      t.section(`[${mode}] learners, unattached accounts, parents and platform staff`);
      const learnerTok = signSessionToken({ id: String(learner._id), role: 'student', tokenVersion: 0 });
      const unattachedTok = signSessionToken({ id: String(unattached._id), role: 'admin', tokenVersion: 0 });
      const lUsers = await call('GET', '/api/users', learnerTok);
      const lPanel = await call('GET', '/api/org-admin/overview', learnerTok);
      const lCtx = await call('GET', '/api/me/context', learnerTok);
      t.check('a public learner cannot reach institute APIs (LEARNER_SCOPE)', lUsers.status === 403 && lUsers.json?.code === 'LEARNER_SCOPE' && lPanel.status === 403, `${brief(lUsers)} | ${brief(lPanel)}`);
      t.check('...but keeps its own context', lCtx.status === 200, brief(lCtx));
      const uUsers = await call('GET', '/api/users', unattachedTok);
      t.check('an admin attached to no organization reaches nothing (TENANT_REQUIRED)', uUsers.status === 403 && uUsers.json?.code === 'TENANT_REQUIRED', brief(uUsers));

      const parentLogin = await login('B-linked-parent', B);
      const parentTok = parentLogin.json?.token as string | undefined;
      t.check('B\'s verified parent can sign in', Boolean(parentTok), brief(parentLogin));
      if (parentTok) {
        const wards = await call('GET', '/api/parent/wards', parentTok);
        t.check('the parent sees their own child only', wards.status === 200 && wards.raw.includes(String(b.student._id)) && !wards.raw.includes(String(a.student._id)), brief(wards));
        const foreignWard = await call('GET', `/api/parent/wards/${a.student._id}/results`, parentTok);
        t.check('...and nothing of a child in another organization', foreignWard.status === 403 || foreignWard.status === 404, brief(foreignWard));
        const claim = await call('POST', '/api/parent/wards/link-request', parentTok, { wardCode: `${RUN}-A-S1`, wardPhone: '9100000001' });
        t.check('...and cannot claim A\'s student with A\'s real code and phone', claim.status === 400 && claim.json?.code === 'WARD_NOT_VERIFIED', brief(claim));
        const parentPanel = await call('GET', '/api/org-admin/overview', parentTok);
        const parentUsers = await call('GET', '/api/users', parentTok);
        t.check('a parent reaches no staff surface (PARENT_SCOPE)', parentPanel.status === 403 && parentUsers.status === 403 && parentUsers.json?.code === 'PARENT_SCOPE', `${brief(parentPanel)} | ${brief(parentUsers)}`);
      }

      const staffTok = signPlatformToken({ id: String(staff._id), role: 'owner', tokenVersion: 0 });
      const staffOnTenant = await call('GET', '/api/org-admin/overview', staffTok);
      t.check('a platform credential is not a tenant credential', staffOnTenant.status === 401 || staffOnTenant.status === 403, brief(staffOnTenant));
      const tenantOnPlatform = await call('GET', '/api/platform/orgs', tokA);
      t.check('an institute admin\'s credential does not open the platform console API', tenantOnPlatform.status === 401 || tenantOnPlatform.status === 403, brief(tenantOnPlatform));

      /* ── Sockets ──────────────────────────────────────────────────────── */
      t.section(`[${mode}] real-time: the socket handshake and doubt rooms`);
      const sockA = await socketPrincipal(tokA);
      t.check('a session token opens a socket confined to its organization', sockA?.orgId === A && sockA?.role === 'admin', JSON.stringify(sockA));
      t.check('a platform staff token does not open a socket', (await socketPrincipal(staffTok)) === null);
      const refreshOnly = (await login('A-teacher', A, { session: 'refresh' })).json?.refreshToken;
      t.check('a refresh token does not open a socket', Boolean(refreshOnly) && (await socketPrincipal(refreshOnly)) === null);
      const sockNarrow = await socketPrincipal(tokNarrow);
      t.check('a narrowed custom-role admin is not an admin on a socket either', sockNarrow?.role === 'student', JSON.stringify(sockNarrow));
      const doubtA = String(
        (await col('doubts').insertOne({ orgId: A, student: a.student._id, teacher: a.teacher._id, subject: 'Physics', messages: [], createdAt: new Date() })).insertedId,
      );
      const doubtB = String(
        (await col('doubts').insertOne({ orgId: B, student: b.student._id, teacher: b.teacher._id, subject: 'Physics', messages: [], createdAt: new Date() })).insertedId,
      );
      t.check('the student who asked may join their doubt room', await sockets.mayJoinDoubt(doubtA, String(a.student._id), 'student', A));
      t.check('another student of the same institute may not', !(await sockets.mayJoinDoubt(doubtA, String(a.victim._id), 'student', A)));
      t.check('A\'s administrator may not join B\'s doubt room', !(await sockets.mayJoinDoubt(doubtB, String(a.admin._id), 'admin', A)));
      t.check('...nor may A\'s teacher', !(await sockets.mayJoinDoubt(doubtB, String(a.teacher._id), 'teacher', A)));
      t.check('a parent may join no doubt room', !(await sockets.mayJoinDoubt(doubtA, String(a.parent._id), 'parent', A)));

      /* ── 9. Sessions and account links ─────────────────────────────────── */
      t.section(`[${mode}] sessions are revocable; invitations and resets work once`);
      const invitedEmail = `${RUN}-invited-${mode}@example.test`;
      const inv = await call('POST', '/api/org-admin/invitations', tokA, {
        name: `${RUN}-invited-${mode}`,
        email: invitedEmail,
        role: 'teacher',
        empCode: `${RUN}-INV-${mode}`,
        orgId: B,
      });
      const invited = await col('users').findOne({ email: invitedEmail });
      t.check('an invitation creates the account in A, whatever the body says', inv.status === 201 && invited?.orgId === A, `${brief(inv)} orgId=${invited?.orgId}`);
      t.check('the response carries a link, never a password', Boolean(inv.json?.invite?.token) && !inv.raw.includes('"password"'), brief(inv));
      const preLogin = await call('POST', '/api/auth/login', undefined, { email: invitedEmail, password: PASSWORD }, { 'X-Org-Id': A });
      t.check('before accepting, no password signs in', preLogin.status >= 400 && !preLogin.json?.token, brief(preLogin));
      const shortPw = await call('POST', '/api/auth/accept-invite', undefined, { token: inv.json?.invite?.token, password: 'short' });
      t.check('a short password is refused', shortPw.status === 400, brief(shortPw));
      const accept = await call('POST', '/api/auth/accept-invite', undefined, { token: inv.json?.invite?.token, password: PASSWORD });
      t.check('accepting sets the password', accept.status === 200, brief(accept));
      const again = await call('POST', '/api/auth/accept-invite', undefined, { token: inv.json?.invite?.token, password: PASSWORD });
      t.check('the same invitation does not work twice', again.status === 400 && again.json?.code === 'LINK_EXPIRED', brief(again));
      const invitedLogin = await call('POST', '/api/auth/login', undefined, { email: invitedEmail, password: PASSWORD }, { 'X-Org-Id': A });
      const invitedTok = invitedLogin.json?.token as string | undefined;
      t.check('the invited teacher signs in', invitedLogin.status === 200 && Boolean(invitedTok), brief(invitedLogin));
      const reinvite = await call('POST', `/api/org-admin/users/${invited?._id}/invite`, tokA);
      t.check('someone who already chose a password is not re-invited', reinvite.status === 409, brief(reinvite));

      const reset = await call('POST', `/api/org-admin/users/${invited?._id}/reset-link`, tokA);
      t.check('A\'s admin issues a reset link for A\'s teacher', reset.status === 200 && Boolean(reset.json?.reset?.token), brief(reset));
      const newPassword = `${PASSWORD}-2`;
      const redeem = await call('POST', '/api/auth/reset-password-link', undefined, { token: reset.json?.reset?.token, password: newPassword });
      t.check('the reset link sets a new password', redeem.status === 200, brief(redeem));
      const oldAfterReset = await call('GET', '/api/me/context', invitedTok);
      t.check('...and signs out the sessions from before (SESSION_REVOKED)', oldAfterReset.status === 401 && oldAfterReset.json?.code === 'SESSION_REVOKED', brief(oldAfterReset));

      const pair = await call('POST', '/api/auth/login', undefined, { email: invitedEmail, password: newPassword, session: 'refresh' }, { 'X-Org-Id': A });
      t.check('a refresh-mode sign-in returns a short access token and a refresh token', pair.status === 200 && Boolean(pair.json?.token) && Boolean(pair.json?.refreshToken) && pair.json?.expiresIn === 900, brief(pair));
      const refreshed = await call('POST', '/api/auth/refresh', undefined, { refreshToken: pair.json?.refreshToken });
      t.check('the refresh token rotates into a new pair', refreshed.status === 200 && Boolean(refreshed.json?.refreshToken), brief(refreshed));
      const accessAsRefresh = await call('POST', '/api/auth/refresh', undefined, { refreshToken: pair.json?.token });
      t.check('an access token is not a refresh token', accessAsRefresh.status === 401, brief(accessAsRefresh));
      const refreshAsAccess = await call('GET', '/api/me/context', pair.json?.refreshToken);
      t.check('a refresh token is not an access token', refreshAsAccess.status === 401 || refreshAsAccess.status === 403, brief(refreshAsAccess));

      // A pre-`tv` token: what every installed app holds today. Valid while the
      // account has never been revoked, and dies with the first revocation.
      const legacyTok = jwt.sign({ id: String(invited?._id), role: 'teacher' }, process.env.JWT_SECRET as string, { expiresIn: '1h' });
      const beforeRevoke = await call('GET', '/api/me/context', legacyTok);
      t.check(
        'a token without `tv` is refused once the account has been revoked (it has, by the reset)',
        beforeRevoke.status === 401 && beforeRevoke.json?.code === 'SESSION_REVOKED',
        brief(beforeRevoke),
      );
      const freshLegacyTok = jwt.sign({ id: String(a.teacher._id), role: 'teacher' }, process.env.JWT_SECRET as string, { expiresIn: '1h' });
      const neverRevoked = await col('users').findOne({ _id: a.teacher._id });
      if (!neverRevoked?.tokenVersion) {
        const ok = await call('GET', '/api/me/context', freshLegacyTok);
        t.check('...but still accepted for an account never revoked (installed apps keep working)', ok.status === 200, brief(ok));
      }

      const everywhere = await call('POST', '/api/auth/logout-all', refreshed.json?.token);
      t.check('sign out everywhere', everywhere.status === 200, brief(everywhere));
      const deadAccess = await call('GET', '/api/me/context', refreshed.json?.token);
      const deadRefresh = await call('POST', '/api/auth/refresh', undefined, { refreshToken: refreshed.json?.refreshToken });
      t.check('...kills the access token', deadAccess.status === 401 && deadAccess.json?.code === 'SESSION_REVOKED', brief(deadAccess));
      t.check('...and every refresh token', deadRefresh.status === 401 && deadRefresh.json?.code === 'SESSION_REVOKED', brief(deadRefresh));

      const tokInv = (await call('POST', '/api/auth/login', undefined, { email: invitedEmail, password: newPassword }, { 'X-Org-Id': A })).json?.token;
      const cpShort = await call('POST', '/api/users/me/change-password', tokInv, { currentPassword: newPassword, newPassword: 'short' });
      t.check('the second change-password route enforces the same minimum', cpShort.status === 400, brief(cpShort));
      const cp = await call('POST', '/api/auth/change-password', tokInv, { currentPassword: newPassword, newPassword: PASSWORD });
      t.check('changing the password returns a fresh token', cp.status === 200 && Boolean(cp.json?.token), brief(cp));
      const oldAfterChange = await call('GET', '/api/me/context', tokInv);
      const newAfterChange = await call('GET', '/api/me/context', cp.json?.token);
      t.check('...signs the other sessions out', oldAfterChange.status === 401, brief(oldAfterChange));
      t.check('...and the fresh token carries on', newAfterChange.status === 200, brief(newAfterChange));

      const signOut = await call('POST', `/api/org-admin/users/${invited?._id}/sign-out`, tokA);
      const afterAdminSignOut = await call('GET', '/api/me/context', cp.json?.token);
      t.check('A\'s admin can sign A\'s teacher out of every device', signOut.status === 200 && afterAdminSignOut.status === 401, `${brief(signOut)} | ${brief(afterAdminSignOut)}`);
      const revokedSocket = await socketPrincipal(cp.json?.token);
      t.check('...and a revoked token no longer opens a socket', revokedSocket === null, JSON.stringify(revokedSocket));
    }

    process.env.TENANT_ENFORCEMENT = 'warn';
  } finally {
    await cleanup().catch((e) => console.error('cleanup failed:', (e as Error).message));
    await close();
  }
  t.report();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
