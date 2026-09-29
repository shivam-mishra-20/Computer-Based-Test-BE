/**
 * Parents and their wards — proved against a real database, over real HTTP.
 *
 * What must hold, and is checked here by reading the collections back:
 *
 *   · a parent cannot claim an arbitrary student: registration needs the
 *     student's code AND the student's registered phone, in the SAME
 *     organization, for an APPROVED student;
 *   · a failed match gives one answer whatever was wrong, so it cannot be used
 *     to discover which student codes exist;
 *   · a match creates only a PENDING link; the parent can see nothing and
 *     cannot sign in until an administrator (the institute's, or platform
 *     staff) verifies it;
 *   · nothing a parent sends can change which student a link points at;
 *   · a parent reads only verified wards' published results, and nothing else
 *     on the platform (every other route answers PARENT_SCOPE);
 *   · Organization A and Organization B never see each other's students,
 *     parents or links;
 *   · revoking a link cuts access immediately; a revoked or broken link cannot
 *     be verified;
 *   · where an organization has not enabled Parent, it is neither offered nor
 *     accepted.
 *
 *   npx ts-node --transpile-only scripts/safety/parent-guardian.e2e.test.ts --scratch-suffix scratch_app
 */

import { bootScratchApp, Checks, request, type Res } from './e2eHarness';

const RUN = `zz-guard-${process.pid}`;
const PASSWORD = 'Guard!E2E-Passw0rd';

async function main() {
  const t = new Checks();
  const { port, dbName, mongoose, close } = await bootScratchApp({ ALLOW_PUBLIC_REGISTER: 'true' });

  /* eslint-disable @typescript-eslint/no-var-requires */
  const { withoutTenantScope } = require('../../src/core/tenancy/context');
  const { clearHostResolutionCache } = require('../../src/core/tenancy/hostResolution');
  const { signPlatformToken } = require('../../src/core/auth/tokens');
  const { setAppExperience } = require('../../src/core/platform/appExperience');
  const Org = require('../../src/models/Org').default;
  const User = require('../../src/models/User').default;
  const GuardianLink = require('../../src/models/GuardianLink').default;
  const Exam = require('../../src/models/Exam').default;
  const Attempt = require('../../src/models/Attempt').default;
  const AuditLog = require('../../src/models/AuditLog').default;
  const PlatformUser = require('../../src/models/PlatformUser').default;
  const PlatformAudit = require('../../src/models/PlatformAudit').default;
  /* eslint-enable @typescript-eslint/no-var-requires */

  const db = mongoose.connection.db!;
  const unscoped = <T>(fn: () => Promise<T>) => withoutTenantScope('e2e:guardian', fn) as Promise<T>;

  const cleanup = async () => {
    await unscoped(async () => {
      const orgs = await Org.find({ slug: { $regex: '^zz-guard-' } }).select('_id').lean();
      const ids = orgs.map((o: { _id: unknown }) => String(o._id));
      const users = await User.find({ email: { $regex: '^zz-guard-' } }).select('_id').lean();
      await Promise.all([
        AuditLog.deleteMany({ userId: { $in: users.map((u: { _id: unknown }) => u._id) } }),
        GuardianLink.deleteMany({ orgId: { $in: ids } }),
        Attempt.collection.deleteMany({ orgId: { $in: ids } }),
        Exam.collection.deleteMany({ orgId: { $in: ids } }),
        PlatformAudit.deleteMany({ orgId: { $in: ids } }),
        User.deleteMany({ email: { $regex: '^zz-guard-' } }),
        PlatformUser.deleteMany({ email: { $regex: '^zz-guard-' } }),
      ]);
      await Org.deleteMany({ _id: { $in: ids } });
    });
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c: { name: string }) => c.name);
    for (const name of names.filter((n: string) => n.startsWith('reg_zz_guard_'))) {
      await db.dropCollection(name).catch(() => undefined);
    }
  };

  try {
    await cleanup();
    console.log(`\nPARENT ↔ WARD  (db: ${dbName})`);

    /* ══ Fixtures ═══════════════════════════════════════════════════════════ */
    t.section('fixtures');
    const makeOrg = (key: string) =>
      unscoped(() =>
        Org.create({
          name: `Guardian ${key.toUpperCase()} Institute`,
          slug: `${RUN}-${key}`,
          status: 'active',
          branding: { appName: `Guardian ${key.toUpperCase()}` },
          mobile: { androidPackage: `com.zzguard.${key}.p${process.pid}` },
        }),
      );
    const [orgA, orgB, orgC] = await Promise.all([makeOrg('a'), makeOrg('b'), makeOrg('c')]);
    const A = String(orgA._id);
    const B = String(orgB._id);
    const C = String(orgC._id);
    const appOf = (key: string) => `com.zzguard.${key}.p${process.pid}`;
    await setAppExperience(A, { registrationPolicy: 'approval', roles: { student: true, teacher: true, parent: true } });
    await setAppExperience(B, { registrationPolicy: 'open', roles: { student: true, parent: true } });
    await setAppExperience(C, { registrationPolicy: 'open', roles: { student: true, parent: false } });
    clearHostResolutionCache();

    const person = (org: string, tag: string, role: string, extra: Record<string, unknown> = {}) =>
      unscoped(() =>
        User.create({
          name: `Guard ${tag}`,
          email: `${RUN}-${tag}@example.test`,
          password: PASSWORD,
          role,
          status: 'approved',
          orgId: org,
          ...extra,
        }),
      );
    const s1 = await person(A, 's1', 'student', { empCode: `${RUN}-A1`, phone: '+91 90000 00001', classLevel: 'Class 10', batch: 'Alpha' });
    const s2 = await person(A, 's2', 'student', { empCode: `${RUN}-A2`, phone: '9000000002', classLevel: 'Class 10', batch: 'Alpha' });
    await person(A, 's3', 'student', { empCode: `${RUN}-A3`, phone: '9000000003', status: 'pending' });
    const s4 = await person(A, 's4', 'student', { empCode: `${RUN}-A4`, phone: '9000000004' });
    const sb1 = await person(B, 'sb1', 'student', { empCode: `${RUN}-B1`, phone: '9000000011' });
    await person(A, 'admin-a', 'admin');
    await person(B, 'admin-b', 'admin');
    await person(A, 'teacher-a', 'teacher');

    // Two results for s1 (one published, one not), one for s2, one for B's student.
    const exam = await unscoped(() =>
      Exam.collection.insertOne({ title: `${RUN} Physics`, subject: 'Physics', orgId: A, createdAt: new Date() }),
    );
    const examB = await unscoped(() =>
      Exam.collection.insertOne({ title: `${RUN} B Chem`, subject: 'Chemistry', orgId: B, createdAt: new Date() }),
    );
    const attempt = (userId: unknown, examId: unknown, org: string, published: boolean, pct: number) =>
      unscoped(() =>
        Attempt.collection.insertOne({
          userId,
          examId,
          orgId: org,
          status: 'submitted',
          resultPublished: published,
          percentage: pct,
          submittedAt: new Date(),
        }),
      );
    await attempt(s1._id, exam.insertedId, A, true, 72.34);
    await attempt(s1._id, exam.insertedId, A, false, 10);
    await attempt(s2._id, exam.insertedId, A, true, 55);
    await attempt(sb1._id, examB.insertedId, B, true, 90);
    t.check('three organizations, five students, two administrators', true);

    const headers = (org: string, app?: string) => ({ 'X-Org-Id': org, ...(app ? { 'X-App-Id': app } : {}) });
    const register = (org: string, key: string, body: Record<string, unknown>) =>
      request(port, 'POST', '/api/auth/register', { headers: headers(org, appOf(key)), body });
    const parentBody = (tag: string, extra: Record<string, unknown> = {}) => ({
      name: `Guard ${tag}`,
      email: `${RUN}-${tag}@example.test`,
      phone: '9123456780',
      password: PASSWORD,
      role: 'parent',
      registrationSource: 'mobile',
      ...extra,
    });
    const login = async (org: string, tag: string): Promise<Res> =>
      request(port, 'POST', '/api/auth/login', {
        headers: headers(org),
        body: { email: `${RUN}-${tag}@example.test`, password: PASSWORD },
      });
    const tokenOf = async (org: string, tag: string) => (await login(org, tag)).json?.token as string | undefined;
    const usersNamed = (tag: string) => unscoped(() => User.countDocuments({ email: `${RUN}-${tag}@example.test` }));
    const linksIn = (org: string, filter: Record<string, unknown> = {}) =>
      unscoped(() => GuardianLink.find({ orgId: org, ...filter }).lean());

    /* ══ 1. Who is offered Parent ═══════════════════════════════════════════ */
    t.section('who is offered Parent');
    const polA = await request(port, 'GET', '/api/auth/registration-policy', { headers: headers(A) });
    const polC = await request(port, 'GET', '/api/auth/registration-policy', { headers: headers(C) });
    t.check('A offers Parent', polA.json?.roles?.includes('parent'), polA.raw);
    t.check('C, which turned Parent off, does not', !polC.json?.roles?.includes('parent'), polC.raw);
    t.check('neither offers admin', !polA.json?.roles?.includes('admin') && !polC.json?.roles?.includes('admin'));
    const offC = await register(C, 'c', parentBody('p-c', { wardCode: `${RUN}-A1`, wardPhone: '9000000001' }));
    t.check(
      'a parent registration where Parent is off is refused',
      offC.status === 400 && offC.json?.code === 'ROLE_NOT_AVAILABLE',
      `${offC.status} ${offC.raw}`,
    );

    /* ══ 2. Claiming a student ══════════════════════════════════════════════ */
    t.section('a parent cannot claim an arbitrary student');
    const noProof = await register(A, 'a', parentBody('p-none'));
    t.check('no student details → refused', noProof.status === 400 && noProof.json?.code === 'WARD_NOT_VERIFIED', noProof.raw);
    const byId = await register(A, 'a', parentBody('p-byid', { studentId: String(s1._id), wardId: String(s1._id) }));
    t.check(
      'naming a student by id is not proof',
      byId.status === 400 && byId.json?.code === 'WARD_NOT_VERIFIED',
      byId.raw,
    );
    const wrongCode = await register(A, 'a', parentBody('p-wc', { wardCode: `${RUN}-A9`, wardPhone: '9000000001' }));
    const wrongPhone = await register(A, 'a', parentBody('p-wp', { wardCode: `${RUN}-A1`, wardPhone: '9000000099' }));
    t.check('a wrong student code → refused', wrongCode.status === 400 && wrongCode.json?.code === 'WARD_NOT_VERIFIED');
    t.check('a right code with the wrong phone → refused', wrongPhone.status === 400 && wrongPhone.json?.code === 'WARD_NOT_VERIFIED');
    t.check(
      'the two failures are indistinguishable (no oracle for which codes exist)',
      wrongCode.status === wrongPhone.status && wrongCode.raw === wrongPhone.raw,
      `${wrongCode.raw}\n      ${wrongPhone.raw}`,
    );
    const pendingWard = await register(A, 'a', parentBody('p-pend', { wardCode: `${RUN}-A3`, wardPhone: '9000000003' }));
    t.check('a student who is not approved cannot be claimed', pendingWard.json?.code === 'WARD_NOT_VERIFIED', pendingWard.raw);
    const crossOrg = await register(A, 'a', parentBody('p-cross', { wardCode: `${RUN}-B1`, wardPhone: '9000000011' }));
    t.check(
      "Organization B's student cannot be claimed through Organization A",
      crossOrg.status === 400 && crossOrg.json?.code === 'WARD_NOT_VERIFIED',
      crossOrg.raw,
    );
    const refusedTags = ['p-c', 'p-none', 'p-byid', 'p-wc', 'p-wp', 'p-pend', 'p-cross'];
    const refusedAccounts = (await Promise.all(refusedTags.map(usersNamed))).reduce((a, b) => a + b, 0);
    t.check('...and not one of those refusals created an account', refusedAccounts === 0, String(refusedAccounts));
    t.check('...or a link', (await linksIn(A)).length === 0 && (await linksIn(C)).length === 0);

    /* ══ 3. A real claim ════════════════════════════════════════════════════ */
    t.section('a real claim is only a request');
    const p1 = await register(
      A,
      'a',
      // The decoy id is ignored: the server derives the student from the proof.
      parentBody('p1', { wardCode: `${RUN}-A1`, wardPhone: '09000000001', studentId: String(s2._id), orgId: B }),
    );
    t.check('the code plus the phone (any format) is accepted', p1.status === 201, `${p1.status} ${p1.raw}`);
    const p1User = await unscoped(() => User.findOne({ email: `${RUN}-p1@example.test` }).lean());
    t.check(
      '...as a PENDING parent, in A — the body’s orgId was ignored',
      p1User?.role === 'parent' && p1User?.status === 'pending' && String(p1User?.orgId) === A,
      JSON.stringify({ role: p1User?.role, status: p1User?.status, orgId: p1User?.orgId }),
    );
    const p1Links = await linksIn(A, { parentId: p1User?._id });
    t.check(
      '...with exactly one PENDING link, to the student the proof identified — not the decoy',
      p1Links.length === 1 && String(p1Links[0].studentId) === String(s1._id) && p1Links[0].status === 'pending',
      JSON.stringify(p1Links.map((l: any) => ({ s: String(l.studentId), st: l.status }))),
    );
    const p1Login = await login(A, 'p1');
    t.check('a pending parent cannot sign in', p1Login.status === 403 && !p1Login.json?.token, `${p1Login.status}`);

    /* ══ 4. Administrators decide ═══════════════════════════════════════════ */
    t.section('administrators decide, each in their own organization');
    const adminA = await tokenOf(A, 'admin-a');
    const adminB = await tokenOf(B, 'admin-b');
    const teacherA = await tokenOf(A, 'teacher-a');
    t.check('both administrators signed in', Boolean(adminA && adminB));
    const listA = await request(port, 'GET', '/api/guardian-links?status=pending', { token: adminA });
    const listB = await request(port, 'GET', '/api/guardian-links', { token: adminB });
    t.check(
      "A's administrator sees the pending request, with the student's code",
      listA.status === 200 && listA.json?.links?.some((l: any) => l.student?.studentCode === `${RUN}-A1`),
      listA.raw.slice(0, 300),
    );
    t.check("B's administrator sees none of A's", listB.status === 200 && (listB.json?.links ?? []).length === 0, listB.raw.slice(0, 300));
    const byTeacher = await request(port, 'GET', '/api/guardian-links', { token: teacherA });
    t.check('a teacher cannot review links', byTeacher.status === 403, `${byTeacher.status}`);
    const linkId = String(p1Links[0]._id);
    const pendingList = await request(port, 'GET', '/api/users/pending', { token: adminA });
    t.check(
      "the generic approval list does not offer parents (they are approved through their link)",
      pendingList.status === 200 && !pendingList.raw.includes(`${RUN}-p1@`),
      `${pendingList.status}`,
    );
    const shortcut = await request(port, 'PUT', `/api/users/${p1User._id}/approve`, { token: adminA, body: { empCode: `${RUN}-P1` } });
    const stillPending = await unscoped(() => User.findById(p1User._id).lean());
    t.check(
      '...and the generic approve refuses a parent, leaving the account pending',
      shortcut.status === 409 && shortcut.json?.code === 'PARENT_APPROVED_BY_LINK' && stillPending?.status === 'pending' && !stillPending?.empCode,
      `${shortcut.status} ${shortcut.raw}`,
    );
    const foreignVerify = await request(port, 'POST', `/api/guardian-links/${linkId}/verify`, { token: adminB });
    t.check("B's administrator cannot verify A's link (it does not exist for them)", foreignVerify.status === 404, `${foreignVerify.status}`);
    t.check('...and it is still pending', (await linksIn(A, { _id: linkId }))[0]?.status === 'pending');
    const verify = await request(port, 'POST', `/api/guardian-links/${linkId}/verify`, { token: adminA });
    t.check("A's administrator verifies it", verify.status === 200 && verify.json?.status === 'verified', verify.raw);
    const p1After = await unscoped(() => User.findById(p1User._id).lean());
    t.check('...which also approves the parent’s account', p1After?.status === 'approved', String(p1After?.status));

    /* ══ 5. What a parent can read ══════════════════════════════════════════ */
    t.section('a parent reads only a verified ward');
    const p1Token = await tokenOf(A, 'p1');
    t.check('the parent can now sign in', Boolean(p1Token));
    const wards = await request(port, 'GET', '/api/parent/wards', { token: p1Token });
    t.check(
      'wards = exactly the verified student',
      wards.status === 200 && wards.json?.wards?.length === 1 && wards.json.wards[0].id === String(s1._id),
      wards.raw,
    );
    t.check('...and no contact details of the student leak', !/9000000001|empCode|@example/.test(wards.raw), wards.raw);
    const results = await request(port, 'GET', `/api/parent/wards/${s1._id}/results`, { token: p1Token });
    t.check(
      "the ward's PUBLISHED results only (1 of 2)",
      results.status === 200 && results.json?.results?.length === 1 && results.json.results[0].percentage === 72.3,
      results.raw,
    );
    const other = await request(port, 'GET', `/api/parent/wards/${s2._id}/results`, { token: p1Token });
    const foreign = await request(port, 'GET', `/api/parent/wards/${sb1._id}/results`, { token: p1Token });
    const invented = await request(port, 'GET', `/api/parent/wards/${new mongoose.Types.ObjectId()}/results`, { token: p1Token });
    const garbage = await request(port, 'GET', '/api/parent/wards/not-an-id/results', { token: p1Token });
    t.check('another student in the same institute → 404', other.status === 404, `${other.status}`);
    t.check("Organization B's student → 404", foreign.status === 404, `${foreign.status}`);
    t.check(
      'an invented or malformed id → the same 404',
      invented.status === 404 && garbage.status === 404 && invented.raw === other.raw && garbage.raw === foreign.raw,
    );
    const hint = await request(port, 'GET', '/api/parent/wards', { token: p1Token, headers: { 'X-Org-Id': B } });
    t.check(
      "an X-Org-Id header naming B shows nothing of B's",
      !hint.raw.includes(String(sb1._id)),
      `${hint.status} ${hint.raw}`,
    );

    t.section('...and nothing else on the platform');
    for (const probe of ['/api/users', '/api/notifications', '/api/exams', '/api/doubts/teachers', '/api/homework']) {
      const r = await request(port, 'GET', probe, { token: p1Token });
      t.check(`${probe} → PARENT_SCOPE`, r.status === 403 && r.json?.code === 'PARENT_SCOPE', `${r.status} ${r.raw.slice(0, 120)}`);
    }
    const me = await request(port, 'GET', '/api/auth/me', { token: p1Token });
    t.check('its own account is readable', me.status === 200, `${me.status}`);
    const studentToken = await tokenOf(A, 's1');
    const asStudent = await request(port, 'GET', '/api/parent/wards', { token: studentToken });
    t.check('a student cannot use the parent routes', asStudent.status === 403, `${asStudent.status}`);

    /* ══ 6. Nothing sent can move a link ════════════════════════════════════ */
    t.section('nothing a parent sends can change the linked student');
    await request(port, 'PATCH', '/api/auth/profile', {
      token: p1Token,
      body: { studentId: String(s2._id), wardId: String(s2._id), role: 'admin', orgId: B, name: 'Guard p1' },
    });
    const p1Now = await unscoped(() => User.findById(p1User._id).lean());
    t.check('a profile update cannot change role or organization', p1Now?.role === 'parent' && String(p1Now?.orgId) === A);
    const idOnly = await request(port, 'POST', '/api/parent/wards/link-request', { token: p1Token, body: { studentId: String(s2._id) } });
    t.check('a link request naming only a student id is refused', idOnly.status === 400 && idOnly.json?.code === 'WARD_NOT_VERIFIED', idOnly.raw);
    const reAsk = await request(port, 'POST', '/api/parent/wards/link-request', {
      token: p1Token,
      body: { wardCode: `${RUN}-A1`, wardPhone: '9000000001', studentId: String(s2._id) },
    });
    t.check('re-proving the linked student changes nothing', reAsk.status === 201 && reAsk.json?.status === 'verified', reAsk.raw);
    t.check(
      '...and there is still no link to the decoy',
      (await linksIn(A, { parentId: p1User._id, studentId: s2._id })).length === 0,
    );
    const crossAsk = await request(port, 'POST', '/api/parent/wards/link-request', {
      token: p1Token,
      body: { wardCode: `${RUN}-B1`, wardPhone: '9000000011' },
    });
    t.check("a link request for B's student from A's parent is refused", crossAsk.json?.code === 'WARD_NOT_VERIFIED', crossAsk.raw);

    t.section('a second child');
    const ask2 = await request(port, 'POST', '/api/parent/wards/link-request', {
      token: p1Token,
      body: { wardCode: `${RUN}-A2`, wardPhone: '9000000002' },
    });
    t.check('proving a second child opens a pending request', ask2.status === 201 && ask2.json?.status === 'pending', ask2.raw);
    const wards2 = await request(port, 'GET', '/api/parent/wards', { token: p1Token });
    t.check(
      '...which shows as a count, not a name, until verified',
      wards2.json?.wards?.length === 1 && wards2.json?.pendingCount === 1 && !wards2.raw.includes('Guard s2'),
      wards2.raw,
    );
    const stillHidden = await request(port, 'GET', `/api/parent/wards/${s2._id}/results`, { token: p1Token });
    t.check("...and the second child's results stay hidden", stillHidden.status === 404);

    /* ══ 7. Platform staff, and broken links ════════════════════════════════ */
    t.section('platform staff, and links that must not be verified');
    const owner = await unscoped(() =>
      PlatformUser.create({ name: 'Guard Owner', email: `${RUN}-owner@platform.test`, password: PASSWORD, role: 'owner' }),
    );
    const staff = signPlatformToken({ id: String(owner._id), role: 'owner', tokenVersion: 0 });
    const staffList = await request(port, 'GET', `/api/platform/orgs/${A}/guardian-links?status=pending`, { token: staff });
    const link2 = staffList.json?.links?.find((l: any) => l.student?.id === String(s2._id));
    t.check('platform staff see A’s pending request', staffList.status === 200 && Boolean(link2), staffList.raw.slice(0, 300));
    const staffVerify = await request(port, 'POST', `/api/platform/orgs/${A}/guardian-links/${link2?.id}/verify`, { token: staff });
    t.check('...and can verify it', staffVerify.status === 200 && staffVerify.json?.status === 'verified', staffVerify.raw);
    const wards3 = await request(port, 'GET', '/api/parent/wards', { token: p1Token });
    t.check('the parent now sees both children', wards3.json?.wards?.length === 2, wards3.raw);
    const wrongOrgPath = await request(port, 'POST', `/api/platform/orgs/${B}/guardian-links/${link2?.id}/verify`, { token: staff });
    t.check("an A link addressed under B's path → 404", wrongOrgPath.status === 404, `${wrongOrgPath.status}`);
    const audited = await unscoped(() => PlatformAudit.countDocuments({ orgId: A, action: 'guardian.link.verify' }));
    t.check('the platform verification is in the platform audit log', audited === 1, String(audited));

    // A link whose student stops being a student cannot be verified.
    const ask4 = await request(port, 'POST', '/api/parent/wards/link-request', {
      token: p1Token,
      body: { wardCode: `${RUN}-A4`, wardPhone: '9000000004' },
    });
    t.check('a request for a fourth student opens', ask4.status === 201, ask4.raw);
    await unscoped(() => User.updateOne({ _id: s4._id }, { $set: { role: 'teacher' } }));
    const link4 = (await linksIn(A, { parentId: p1User._id, studentId: s4._id }))[0];
    const badVerify = await request(port, 'POST', `/api/guardian-links/${link4?._id}/verify`, { token: adminA });
    t.check('a link to someone who is no longer a student is rejected', badVerify.status === 409, `${badVerify.status} ${badVerify.raw}`);

    /* ══ 8. Revocation ══════════════════════════════════════════════════════ */
    t.section('revocation');
    const revoke = await request(port, 'POST', `/api/guardian-links/${linkId}/revoke`, { token: adminA });
    t.check('A’s administrator revokes the first link', revoke.status === 200 && revoke.json?.status === 'revoked', revoke.raw);
    const afterRevoke = await request(port, 'GET', `/api/parent/wards/${s1._id}/results`, { token: p1Token });
    const wards4 = await request(port, 'GET', '/api/parent/wards', { token: p1Token });
    t.check('access ends at once', afterRevoke.status === 404 && wards4.json?.wards?.length === 1, `${afterRevoke.status} ${wards4.raw}`);
    const reVerify = await request(port, 'POST', `/api/guardian-links/${linkId}/verify`, { token: adminA });
    t.check('a revoked link cannot simply be re-verified', reVerify.status === 409, `${reVerify.status}`);

    /* ══ 9. Organization B, independently ═══════════════════════════════════ */
    t.section("Organization B's parents live in B");
    const pb = await register(B, 'b', parentBody('pb', { wardCode: `${RUN}-B1`, wardPhone: '9000000011' }));
    t.check('a parent registers in B (pending even though B is open)', pb.status === 201 && pb.json?.status !== 'active', pb.raw);
    const pbLink = (await linksIn(B))[0];
    const pbVerify = await request(port, 'POST', `/api/guardian-links/${pbLink?._id}/verify`, { token: adminB });
    t.check("B's administrator verifies it", pbVerify.status === 200, pbVerify.raw);
    const pbToken = await tokenOf(B, 'pb');
    const pbWards = await request(port, 'GET', '/api/parent/wards', { token: pbToken });
    t.check("B's parent sees B's student only", pbWards.json?.wards?.length === 1 && pbWards.json.wards[0].id === String(sb1._id), pbWards.raw);
    const pbIntoA = await request(port, 'GET', `/api/parent/wards/${s2._id}/results`, { token: pbToken });
    t.check("...and nothing of A's", pbIntoA.status === 404, `${pbIntoA.status}`);
    const pbResults = await request(port, 'GET', `/api/parent/wards/${sb1._id}/results`, { token: pbToken });
    t.check("...and B's student's results", pbResults.json?.results?.length === 1, pbResults.raw);
    t.check(
      "no link anywhere joins a parent to another organization's student",
      (await unscoped(() =>
        GuardianLink.countDocuments({ $or: [{ orgId: A, studentId: sb1._id }, { orgId: B, studentId: { $in: [s1._id, s2._id] } }] }),
      )) === 0,
    );
  } catch (err) {
    t.check('the suite ran to the end', false, (err as Error).stack ?? String(err));
  } finally {
    await cleanup().catch((e: Error) => console.error('cleanup failed:', e.message));
    const left = await withoutTenantScope('e2e:guardian-left', async () =>
      User.countDocuments({ email: { $regex: '^zz-guard-' } }),
    );
    t.check('cleanup left no fixture behind', left === 0, String(left));
    await close();
  }
  t.report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
