/**
 * AGTS end-to-end — the real app on an ephemeral port against a SCRATCH
 * database (bootScratchApp refuses production and unmarked databases).
 *
 *   SCRATCH_DB_NAME=abhigyangurukul_console_scratch_app npm run safety:agts
 *
 * AGTS runs on the class-wise papers built in the test builder
 * (`scholarshiptests`), so the suite seeds papers as well as questions.
 *
 * Covers: paper listing/availability/naming, registration + validation, lead creation/dedupe, consent and UTM,
 * unknown-field / score / status tampering, the paper (no answer key), atomic
 * answer saves, skipping, server-side deadline, submission + scoring +
 * analysis, idempotent submit, result access control, guidance requests,
 * per-phone attempt ceiling, rate limiting, the staff lead desk (auth,
 * permissions, filters, notes, status, follow-up, contact log, cross-org
 * isolation) and the legacy /api/scholarship routes.
 *
 * Everything it creates is tagged and removed at the end; a collection it had
 * to create (`leads`) is dropped again if it did not exist before.
 */

import { bootScratchApp, Checks, request, type Res } from './e2eHarness';

const RUN = `zz-agts-${process.pid}`;
const NAME = 'Zzagts'; // student-name prefix (letters only: the validator refuses digits)
const BOARD = `AGTS E2E ${process.pid}`;

async function main() {
  const t = new Checks();
  const { port, dbName, mongoose, close } = await bootScratchApp({
    AGTS_REGISTER_RATE_LIMIT_MAX: '40',
    AGTS_MAX_ATTEMPTS_PER_PHONE_PER_DAY: '3',
    AGTS_SUBMIT_GRACE_SEC: '90',
  });
  console.log(`\nAGTS E2E  (scratch db: ${dbName})`);
  if (/^abhigyangurukul(_console)?$/i.test(dbName)) throw new Error('refusing to run against a protected database');

  /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */
  const { withoutTenantScope } = require('../../src/core/tenancy/context');
  const { signSessionToken } = require('../../src/core/auth/tokens');
  const Org = require('../../src/models/Org').default;
  const User = require('../../src/models/User').default;
  const Lead = require('../../src/models/Lead').default;
  const ScholarshipAttempt = require('../../src/models/ScholarshipAttempt').default;
  const ScholarshipTest = require('../../src/models/ScholarshipTest').default;
  const AuditLog = require('../../src/models/AuditLog').default;
  const { getClassQuestionModel } = require('../../src/models/ClassQuestion');
  /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */

  const unscoped = <T>(fn: () => Promise<T>) => withoutTenantScope('e2e:agts', fn) as Promise<T>;
  const db = mongoose.connection.db;
  const collectionNames = async () => (await db.listCollections({}, { nameOnly: true }).toArray()).map((c: { name: string }) => c.name);
  const before = await collectionNames();
  const leadsExisted = before.includes('leads');
  console.log(`  scratch collections before: ${before.length} (leads existed: ${leadsExisted})`);

  const Q11 = getClassQuestionModel('Class 11');
  const orgIds: string[] = [];
  const userIds: string[] = [];

  const cleanup = async () => {
    await unscoped(async () => {
      await ScholarshipAttempt.deleteMany({ $or: [{ name: { $regex: `^${NAME}` } }, { orgId: { $in: orgIds } }] });
      await Lead.deleteMany({ $or: [{ 'student.name': { $regex: `^${NAME}` } }, { orgId: { $in: orgIds } }] });
      await Q11.deleteMany({ board: BOARD });
      await ScholarshipTest.deleteMany({ description: RUN });
      if (userIds.length) await AuditLog.deleteMany({ userId: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) } });
      await User.deleteMany({ email: { $regex: `^${RUN}` } });
      await Org.deleteMany({ slug: { $regex: `^${RUN}` } });
    });
  };

  let failed = false;
  try {
    // ── Fixtures ───────────────────────────────────────────────────────────
    const org = async (tag: string) =>
      unscoped(() => Org.create({ name: `AGTS E2E ${tag}`, slug: `${RUN}-${tag}`, status: 'active', mobile: { androidPackage: `com.zzagts${tag}.p${process.pid}` } }));
    const orgA = String((await org('a'))._id);
    const orgB = String((await org('b'))._id);
    orgIds.push(orgA, orgB);

    const person = async (tag: string, role: string, orgId: string) => {
      const u = await unscoped(() =>
        User.create({ name: `${NAME} ${tag}`, email: `${RUN}-${tag}@example.test`, password: 'Agts-E2E!2026', role, status: 'approved', orgId }),
      );
      userIds.push(String(u._id));
      return signSessionToken({ id: String(u._id), role, orgId, tokenVersion: 0 });
    };
    const adminA = await person('admina', 'admin', orgA);
    const teacherA = await person('teachera', 'teacher', orgA);
    const studentA = await person('studenta', 'student', orgA);
    const adminB = await person('adminb', 'admin', orgB);
    const creator = new mongoose.Types.ObjectId(userIds[0]);

    // 16 per subject for Class 11 in org A; option 0 is always correct.
    const docs = [];
    for (const [subject, topics] of [['Mathematics', ['Algebra', 'Geometry']], ['Science', ['Light', 'Electricity']]] as const) {
      for (let i = 0; i < 16; i++) {
        docs.push({
          text: `${subject} question ${i + 1} (${RUN})`,
          type: 'mcq',
          options: [{ text: 'Right' , isCorrect: true }, { text: 'Wrong A' }, { text: 'Wrong B' }, { text: 'Wrong C' }],
          subject,
          topic: topics[i % 2],
          board: BOARD,
          difficulty: i % 3 === 0 ? 'hard' : 'easy',
          marks: 1,
          createdBy: creator,
          isActive: true,
          orgId: orgA,
        });
      }
    }
    await unscoped(() => Q11.insertMany(docs));
    const bank = await unscoped(() => Q11.find({ board: BOARD }).lean());
    const correctOf = new Map(bank.map((q: any) => [String(q._id), String(q.options[0]._id)]));
    const wrongOf = new Map(bank.map((q: any) => [String(q._id), String(q.options[1]._id)]));
    const foreignOption = String(bank[0].options[1]._id);

    // Class-wise papers for Class 11 in org A, oldest first. P1 carries the
    // pre-AGTS name the production papers have; P5 asks for more questions per
    // subject than the bank holds, so it must never be offered or started.
    const paper = (testName: string, questionsPerSubject = 15) =>
      unscoped(() =>
        ScholarshipTest.create({
          testName, description: RUN, eligibleClasses: [11], subjects: ['Math', 'Science'],
          durationMins: 60, questionsPerSubject, isActive: true, shareLink: `${RUN}-${testName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, orgId: orgA,
        }),
      );
    const P1 = await paper('Scholarship Test');
    await new Promise((r) => setTimeout(r, 20));
    const P2 = await paper('AGTS Paper Two');
    await new Promise((r) => setTimeout(r, 20));
    const P3 = await paper('AGTS Paper Three');
    await new Promise((r) => setTimeout(r, 20));
    const P4 = await paper('AGTS Paper Four');
    const P5 = await paper('AGTS Too Big', 20);

    const A = { 'X-Org-Id': orgA };
    const B = { 'X-Org-Id': orgB };
    const call = (method: string, path: string, opts: { body?: unknown; token?: string; key?: string; headers?: Record<string, string> } = {}) =>
      request(port, method, path, {
        body: opts.body,
        token: opts.token,
        headers: { ...(opts.headers ?? A), ...(opts.key ? { 'X-AGTS-Attempt-Key': opts.key } : {}) },
      });
    const brief = (r: Res) => `${r.status} ${r.raw.slice(0, 220)}`;
    const phone = (n: number) => `98${String(process.pid % 100000).padStart(5, '0')}${String(n).padStart(3, '0')}`;
    const reg = (n: number, extra: Record<string, unknown> = {}) => ({
      studentName: `${NAME} Student ${String.fromCharCode(64 + n)}`,
      classLevel: 11,
      guardianName: 'Meera Shah',
      phone: phone(n),
      email: `parent${n}@example.test`,
      school: 'Sunrise School',
      board: 'CBSE',
      consent: true,
      ...extra,
    });
    const leadOf = (p: string, orgId = orgA) => unscoped(() => Lead.findOne({ phoneNormalized: p, orgId }).lean());
    const attemptOf = (id: string) => unscoped(() => ScholarshipAttempt.findOne({ attemptId: id }).lean());

    // ── 1. Tests list ──────────────────────────────────────────────────────
    t.section('class-wise papers');
    const tests = await call('GET', '/api/agts/tests');
    const listed = (tests.json?.tests || []).map((x: any) => x.ref);
    t.check('GET /api/agts/tests → the four papers the bank can fill, Class 11', tests.status === 200 && listed.length === 4 && JSON.stringify(tests.json?.classes) === '[11]', brief(tests));
    t.check('a paper the bank cannot fill (20 per subject) is not offered', !listed.includes(P5.shareLink));
    const p1View = (tests.json?.tests || []).find((x: any) => x.ref === P1.shareLink);
    t.check('a paper stored as "Scholarship Test" is shown as an AGTS paper', p1View?.name === 'AGTS · Class 11 · 30 questions · 60 min', p1View?.name);
    t.check('no scholarship wording anywhere in the paper list', !/scholarship/i.test(JSON.stringify(tests.json?.tests || [])));
    const tooBig = await call('POST', '/api/agts/register', { body: reg(8, { testRef: P5.shareLink }) });
    t.check('starting the unfillable paper → 503, and no lead is written', tooBig.status === 503 && !(await leadOf(phone(8))), brief(tooBig));
    const badRef = await call('GET', '/api/agts/tests/..%2Fetc');
    t.check('a malformed test ref → 404', badRef.status === 404, brief(badRef));

    // ── 2. Validation ──────────────────────────────────────────────────────
    t.section('registration validation');
    const empty = await call('POST', '/api/agts/register', { body: {} });
    t.check('empty body → 400 with field errors', empty.status === 400 && ['studentName', 'classLevel', 'guardianName', 'phone', 'consent'].every((f) => empty.json?.errors?.[f]), brief(empty));
    const noConsent = await call('POST', '/api/agts/register', { body: reg(1, { consent: 'true' }) });
    t.check('consent as a string → 400 (must be boolean true)', noConsent.status === 400 && noConsent.json?.errors?.consent, brief(noConsent));
    const badPhone = await call('POST', '/api/agts/register', { body: reg(1, { phone: '12345' }) });
    t.check('invalid phone → 400', badPhone.status === 400 && badPhone.json?.errors?.phone, brief(badPhone));
    const badClass = await call('POST', '/api/agts/register', { body: reg(1, { classLevel: 6 }) });
    t.check('class outside 7–12 → 400', badClass.status === 400 && badClass.json?.errors?.classLevel, brief(badClass));
    t.check('no lead was written for any refused registration', !(await leadOf(phone(1))));

    // ── 3. Registration → lead + attempt ───────────────────────────────────
    t.section('registration creates a lead and an attempt');
    const r1 = await call('POST', '/api/agts/register', {
      body: reg(1, {
        attribution: {
          utm_source: 'instagram',
          utm_medium: 'social',
          utm_campaign: 'agts_launch',
          landingPage: 'https://abhigyangurukul.com/agts?phone=999&utm_source=instagram',
          referrer: 'https://www.google.com/search?q=private',
        },
      }),
    });
    t.check('POST /register → 201', r1.status === 201, brief(r1));
    const att1: string = r1.json?.attemptId;
    const key1: string = r1.json?.attemptAccessKey;
    t.check('attempt id is AGTS- prefixed', /^AGTS-11-\d{6}-[A-Z0-9]{8}$/.test(att1 || ''), att1);
    t.check('attempt key is 48 hex chars', /^[a-f0-9]{48}$/.test(key1 || ''));
    t.check('server returns the deadline', Math.abs(new Date(r1.json?.endsAt).getTime() - Date.now() - 60 * 60000) < 120000);
    const lead1: any = await leadOf(phone(1));
    t.check('lead created in org A with status new', lead1 && lead1.status === 'new' && String(lead1.orgId) === orgA, JSON.stringify(lead1?.status));
    t.check('consent recorded with timestamp and version', lead1?.consent?.contact === true && lead1?.consent?.grantedAt && lead1?.consent?.version);
    t.check('student, guardian, email, school, board stored', lead1?.student?.name?.startsWith(NAME) && lead1?.guardian?.name === 'Meera Shah' && lead1?.email === 'parent1@example.test' && lead1?.student?.school === 'Sunrise School' && lead1?.student?.board === 'CBSE');
    t.check('UTM captured as first touch', lead1?.attribution?.first?.source === 'instagram' && lead1?.attribution?.first?.campaign === 'agts_launch');
    t.check('landing page stored without its query string', lead1?.attribution?.first?.landingPage === '/agts', lead1?.attribution?.first?.landingPage);
    t.check('referrer stored as host only', lead1?.attribution?.first?.referrer === 'www.google.com');
    t.check('attempt count 1, channel agts', lead1?.agts?.attemptCount === 1 && lead1?.channels?.includes('agts'));
    const a1: any = await attemptOf(att1);
    t.check('attempt linked to the lead, program agts, 30 questions', String(a1?.leadId) === String(lead1?._id) && a1?.program === 'agts' && a1?.questions?.length === 30);
    t.check('with no paper named, the class\'s latest paper is used (P4)', a1?.scholarshipTestId === String(P4._id));

    // ── 4. Unknown-field / status / score / org injection ─────────────────
    t.section('tampering at registration');
    const r2 = await call('POST', '/api/agts/register', {
      body: reg(2, { status: 'enrolled', score: 100, percentage: 100, orgId: orgB, leadOwner: 'attacker', agts: { latest: { percentage: 100 } }, notes: [{ text: 'x' }] }),
    });
    const lead2: any = await leadOf(phone(2));
    t.check('registration with injected fields still succeeds', r2.status === 201, brief(r2));
    t.check('status is server-set (new), not "enrolled"', lead2?.status === 'new');
    t.check('orgId comes from the request context, not the body', String(lead2?.orgId) === orgA && !(await leadOf(phone(2), orgB)));
    t.check('no leadOwner / score / notes were stored', lead2 && !('leadOwner' in lead2) && !('score' in lead2) && (lead2.notes || []).length === 0 && lead2.agts?.latest == null);

    // ── 5. The paper ───────────────────────────────────────────────────────
    t.section('the paper and attempt access');
    const noKey = await call('GET', `/api/agts/attempts/${att1}`);
    t.check('no key → 404', noKey.status === 404, brief(noKey));
    const wrongKey = await call('GET', `/api/agts/attempts/${att1}`, { key: r2.json?.attemptAccessKey });
    t.check('another attempt\'s key → 404 (same as not found)', wrongKey.status === 404, brief(wrongKey));
    const paper = await call('GET', `/api/agts/attempts/${att1}`, { key: key1 });
    t.check('right key → 200 with 30 questions', paper.status === 200 && paper.json?.questions?.length === 30, brief(paper));
    t.check('no answer key anywhere in the paper', !/isCorrect|correctAnswerText|integerAnswer|explanation/.test(paper.raw));
    t.check('no phone number in the paper', !paper.raw.includes(phone(1)));
    const qs: string[] = (paper.json?.questions || []).map((q: any) => q._id);

    // ── 6. Answering ───────────────────────────────────────────────────────
    t.section('answering');
    const save = (qid: string, answer: unknown, extra: Record<string, unknown> = {}) =>
      call('POST', `/api/agts/attempts/${att1}/answer`, { key: key1, body: { questionId: qid, answer, ...extra } });
    const s1 = await save(qs[0], correctOf.get(qs[0]));
    t.check('save a correct answer → 200', s1.status === 200 && s1.json?.saved, brief(s1));
    const s2 = await save(qs[1], { chosenOptionId: wrongOf.get(qs[1]), isCorrect: true, marks: 99 });
    t.check('a wrong answer with forged isCorrect/marks is accepted as a plain answer', s2.status === 200);
    const s3 = await save(qs[2], null, { markedForReview: true });
    t.check('mark for review without answering → 200', s3.status === 200);
    const foreign = await save(qs[3], qs[3] === String(bank[0]._id) ? String(bank[1].options[0]._id) : foreignOption);
    t.check('an option from another question → 400', foreign.status === 400 && foreign.json?.code === 'AGTS_OPTION_NOT_ON_QUESTION', brief(foreign));
    const offPaper = await save(new mongoose.Types.ObjectId().toString(), foreignOption);
    t.check('a question not on the paper → 400', offPaper.status === 400 && offPaper.json?.code === 'AGTS_QUESTION_NOT_ON_PAPER', brief(offPaper));
    const junk = await save('not-an-id', 'x');
    t.check('a malformed question id → 400', junk.status === 400, brief(junk));

    // Ten concurrent saves for ten different questions must all land.
    const burst = qs.slice(5, 15);
    const burstRes = await Promise.all(burst.map((qid) => save(qid, correctOf.get(qid))));
    t.check('10 concurrent saves → all 200', burstRes.every((r) => r.status === 200), burstRes.map((r) => r.status).join(','));
    const afterBurst: any = await attemptOf(att1);
    const savedIds = new Set((afterBurst.answers || []).filter((a: any) => a.chosenOptionId).map((a: any) => a.questionId));
    t.check('…and all 10 are stored (atomic per-answer writes)', burst.every((q) => savedIds.has(q)), `${[...savedIds].length} stored`);
    // Change an answer, then clear another.
    await save(qs[5], wrongOf.get(qs[5]));
    await save(qs[6], null);
    const afterEdit: any = await attemptOf(att1);
    const byQ = new Map((afterEdit.answers || []).map((a: any) => [a.questionId, a]));
    t.check('changing an answer overwrites it', (byQ.get(qs[5]) as any)?.chosenOptionId === wrongOf.get(qs[5]));
    t.check('clearing an answer leaves it unanswered (skipped)', !(byQ.get(qs[6]) as any)?.chosenOptionId);
    t.check('no forged isCorrect=true stored before grading', !(afterEdit.answers || []).some((a: any) => a.isCorrect === true));

    // ── 7. Resume and duplicate protection ─────────────────────────────────
    t.section('resume and duplicate leads');
    const again = await call('POST', '/api/agts/register', { body: reg(1) });
    t.check('same phone + same student → 200 resumed, same attempt', again.status === 200 && again.json?.attemptId === att1 && again.json?.resumed, brief(again));
    const other = await call('POST', '/api/agts/register', { body: reg(1, { studentName: `${NAME} Someone Else` }) });
    t.check('same phone, different student while in progress → 409, no key', other.status === 409 && other.json?.code === 'AGTS_IN_PROGRESS_ELSEWHERE' && !other.json?.attemptAccessKey, brief(other));
    const leadsForPhone = await unscoped(() => Lead.countDocuments({ phoneNormalized: phone(1) }));
    t.check('still exactly one lead for the phone', leadsForPhone === 1, String(leadsForPhone));
    t.check('resume did not count a new attempt', (await leadOf(phone(1)))?.agts?.attemptCount === 1);

    // ── 8. Guidance before submission ──────────────────────────────────────
    const earlyGuidance = await call('POST', `/api/agts/attempts/${att1}/guidance`, { key: key1, body: { preferredTime: 'Any time' } });
    t.check('guidance before submitting → 409', earlyGuidance.status === 409, brief(earlyGuidance));
    const earlyResult = await call('GET', `/api/agts/attempts/${att1}/result`, { key: key1 });
    t.check('result before submitting → 409', earlyResult.status === 409 && earlyResult.json?.code === 'AGTS_NOT_SUBMITTED', brief(earlyResult));

    // ── 9. Submission, scoring, analysis ───────────────────────────────────
    t.section('submission and server-side scoring');
    // Final flush: answer two more correctly, and try to forge the outcome.
    const flush: Record<string, unknown> = { [qs[20]]: correctOf.get(qs[20]), [qs[21]]: { chosenOptionId: correctOf.get(qs[21]) } };
    const sub = await call('POST', `/api/agts/attempts/${att1}/submit`, {
      key: key1,
      body: { answers: flush, reason: 'candidate', score: 30, percentage: 100, status: 'enrolled', totalScore: 30 },
    });
    t.check('submit → 200 with a report', sub.status === 200 && sub.json?.analysis?.overall, brief(sub));
    const graded: any = await attemptOf(att1);
    const expectCorrect = [qs[0], ...qs.slice(6, 15), qs[20], qs[21]].filter((q) => q !== qs[6]).length; // q6 cleared, q5 changed to wrong
    const ov = sub.json?.analysis?.overall || {};
    t.check(`score is the server's count of correct answers (${expectCorrect}), not the forged 30`, ov.score === expectCorrect && graded.totalScore === expectCorrect, `score=${ov.score} stored=${graded.totalScore}`);
    t.check('maximum is the whole paper (30), not the answered subset', ov.maxScore === 30 && graded.maxScore === 30, String(ov.maxScore));
    t.check('percentage computed server-side', ov.percentage === Math.round((expectCorrect / 30) * 10000) / 100, String(ov.percentage));
    t.check('correct + incorrect + skipped = 30', ov.correct + ov.incorrect + ov.skipped === 30, JSON.stringify(ov));
    t.check('accuracy = correct / attempted', ov.accuracy === Math.round((ov.correct / (ov.correct + ov.incorrect)) * 10000) / 100);
    const an = sub.json?.analysis || {};
    t.check('subject-wise breakdown for both subjects', an.subjects?.length === 2);
    t.check('topic-wise breakdown available', an.topicsAvailable === true && an.topics?.length >= 2);
    t.check('strengths, weak areas and recommendations present', Array.isArray(an.strengths) && Array.isArray(an.weakAreas) && an.recommendations?.length >= 1);
    t.check('time taken recorded', typeof an.time?.timeTakenSec === 'number' && an.time.allottedSec === 3600);
    t.check('question map of 30 outcomes', an.questionMap?.length === 30);
    t.check('the report carries no phone, email or guardian', !sub.raw.includes(phone(1)) && !sub.raw.includes('parent1@') && !sub.raw.includes('Meera'));
    t.check('stored status submitted by the candidate', graded.status === 'submitted' && graded.submitReason === 'candidate');
    t.check('forged isCorrect on the wrong answer was overwritten by grading', (graded.answers || []).find((a: any) => a.questionId === qs[1])?.isCorrect === false);

    const leadAfter: any = await leadOf(phone(1));
    t.check('lead moved automatically to agts_completed', leadAfter?.status === 'agts_completed');
    t.check('…with an automatic history entry', (leadAfter?.statusHistory || []).some((h: any) => h.to === 'agts_completed' && h.automatic));
    t.check('lead holds the latest result snapshot', leadAfter?.agts?.latest?.attemptId === att1 && leadAfter?.agts?.latest?.percentage === ov.percentage && leadAfter?.agts?.completedCount === 1);

    const sub2 = await call('POST', `/api/agts/attempts/${att1}/submit`, { key: key1, body: {} });
    t.check('submitting again → 200, same report (idempotent)', sub2.status === 200 && sub2.json?.analysis?.overall?.score === ov.score);
    t.check('…and the lead was not counted twice', (await leadOf(phone(1)))?.agts?.completedCount === 1);
    const lateSave = await save(qs[25], correctOf.get(qs[25]));
    t.check('saving after submission → 409', lateSave.status === 409 && lateSave.json?.code === 'AGTS_ALREADY_SUBMITTED', brief(lateSave));

    t.section('result access control');
    const res0 = await call('GET', `/api/agts/attempts/${att1}/result`);
    t.check('result without key → 404', res0.status === 404);
    const resX = await call('GET', `/api/agts/attempts/${att1}/result`, { key: r2.json?.attemptAccessKey });
    t.check('result with another candidate\'s key → 404', resX.status === 404);
    const resOk = await call('GET', `/api/agts/attempts/${att1}/result`, { key: key1 });
    t.check('result with own key → 200', resOk.status === 200 && resOk.json?.analysis?.overall?.score === ov.score);

    // ── 10. Guidance ───────────────────────────────────────────────────────
    t.section('guidance request');
    const gBad = await call('POST', `/api/agts/attempts/${att1}/guidance`, { key: key1, body: { preferredTime: 'midnight' } });
    t.check('preferred time outside the list → 400', gBad.status === 400, brief(gBad));
    const g1 = await call('POST', `/api/agts/attempts/${att1}/guidance`, { key: key1, body: { preferredTime: 'Evening (4pm–8pm)', message: 'Please call after 6' } });
    t.check('guidance request → 200', g1.status === 200 && g1.json?.requested, brief(g1));
    await call('POST', `/api/agts/attempts/${att1}/guidance`, { key: key1, body: { preferredTime: 'Evening (4pm–8pm)' } });
    const gl: any = await leadOf(phone(1));
    t.check('lead flags guidance, repeat within 10 min not double-counted', gl?.guidance?.requested && gl?.guidance?.count === 1 && gl?.guidance?.preferredTime === 'Evening (4pm–8pm)');
    t.check('guidance did not change the lead status', gl?.status === 'agts_completed');
    const resG = await call('GET', `/api/agts/attempts/${att1}/result`, { key: key1 });
    t.check('the result now shows guidance as requested', resG.json?.guidance?.requested === true);

    // ── 11. Deadline enforcement ───────────────────────────────────────────
    t.section('server-side deadline');
    const r3 = await call('POST', '/api/agts/register', { body: reg(3) });
    const att3 = r3.json?.attemptId;
    const key3 = r3.json?.attemptAccessKey;
    const paper3 = await call('GET', `/api/agts/attempts/${att3}`, { key: key3 });
    const q3: string[] = (paper3.json?.questions || []).map((q: any) => q._id);
    await call('POST', `/api/agts/attempts/${att3}/answer`, { key: key3, body: { questionId: q3[0], answer: correctOf.get(q3[0]) } });
    await unscoped(() => ScholarshipAttempt.updateOne({ attemptId: att3 }, { $set: { startedAt: new Date(Date.now() - 2 * 3600 * 1000) } }));
    const lateFlush = Object.fromEntries(q3.slice(1, 11).map((q) => [q, correctOf.get(q)]));
    const lateSub = await call('POST', `/api/agts/attempts/${att3}/submit`, { key: key3, body: { answers: lateFlush } });
    t.check('a submit after the deadline is accepted…', lateSub.status === 200, brief(lateSub));
    t.check('…but answers sent after the deadline are ignored (score 1, not 11)', lateSub.json?.analysis?.overall?.score === 1, String(lateSub.json?.analysis?.overall?.score));
    t.check('…and it is recorded as expired, time capped at 60 min', lateSub.json?.submitReason === 'expired' && lateSub.json?.analysis?.time?.timeTakenSec === 3600);

    const r4 = await call('POST', '/api/agts/register', { body: reg(4) });
    const att4 = r4.json?.attemptId;
    const key4 = r4.json?.attemptAccessKey;
    await unscoped(() => ScholarshipAttempt.updateOne({ attemptId: att4 }, { $set: { startedAt: new Date(Date.now() - 2 * 3600 * 1000) } }));
    const expiredSave = await call('POST', `/api/agts/attempts/${att4}/answer`, { key: key4, body: { questionId: (await attemptOf(att4)).questions[0], answer: null } });
    t.check('saving after the deadline → 409 AGTS_TIME_UP', expiredSave.status === 409 && expiredSave.json?.code === 'AGTS_TIME_UP', brief(expiredSave));
    const expiredView = await call('GET', `/api/agts/attempts/${att4}`, { key: key4 });
    t.check('an expired attempt is closed server-side and reports submitted', expiredView.json?.status === 'submitted' && (expiredView.json?.questions || []).length === 0);
    t.check('its lead still receives the result', (await leadOf(phone(4)))?.status === 'agts_completed');

    // ── 12. Retakes and the per-phone ceiling ──────────────────────────────
    t.section('a series: one lead, many papers, per-phone ceiling');
    // phone(3): 1 attempt so far (P4, expired). The same paper is locked; other
    // papers are allowed until the daily ceiling of 3 new attempts.
    const again3 = await call('POST', '/api/agts/register', { body: reg(3) });
    t.check('the same paper again → 409 AGTS_ALREADY_TAKEN (once per phone per paper)', again3.status === 409 && again3.json?.code === 'AGTS_ALREADY_TAKEN', brief(again3));
    const retake1 = await call('POST', '/api/agts/register', { body: reg(3, { testRef: P3.shareLink }) });
    t.check('another paper of the series → 201, new attempt', retake1.status === 201 && retake1.json?.attemptId !== att3, brief(retake1));
    await call('POST', `/api/agts/attempts/${retake1.json?.attemptId}/submit`, { key: retake1.json?.attemptAccessKey, body: {} });
    const retake2 = await call('POST', '/api/agts/register', { body: reg(3, { testRef: P2.shareLink }) });
    t.check('third paper in 24h → 201', retake2.status === 201, brief(retake2));
    await call('POST', `/api/agts/attempts/${retake2.json?.attemptId}/submit`, { key: retake2.json?.attemptAccessKey, body: {} });
    const retake3 = await call('POST', '/api/agts/register', { body: reg(3, { testRef: P1.shareLink }) });
    t.check('fourth new attempt in 24h → 429 AGTS_ATTEMPT_LIMIT', retake3.status === 429 && retake3.json?.code === 'AGTS_ATTEMPT_LIMIT', brief(retake3));
    const lead3: any = await leadOf(phone(3));
    t.check('one lead for all three attempts', (await unscoped(() => Lead.countDocuments({ phoneNormalized: phone(3) }))) === 1);
    t.check('lead counts 3 attempts, 3 completed', lead3?.agts?.attemptCount === 3 && lead3?.agts?.completedCount === 3, JSON.stringify(lead3?.agts));
    t.check('three attempts linked to the lead', (await unscoped(() => ScholarshipAttempt.countDocuments({ leadId: lead3?._id }))) === 3);

    // ── 13. Staff lead desk ────────────────────────────────────────────────
    t.section('staff access control');
    const anon = await call('GET', '/api/agts/admin/leads');
    t.check('no token → 401', anon.status === 401, brief(anon));
    const asStudent = await call('GET', '/api/agts/admin/leads', { token: studentA });
    t.check('student token → 403', asStudent.status === 403, brief(asStudent));
    const asTeacher = await call('GET', '/api/agts/admin/leads', { token: teacherA });
    t.check('teacher token (no enquiries.manage) → 403', asTeacher.status === 403, brief(asTeacher));
    const list = await call('GET', '/api/agts/admin/leads', { token: adminA });
    t.check('admin → 200', list.status === 200, brief(list));
    t.check('lists the four org-A leads', list.json?.total === 4, String(list.json?.total));
    t.check('summary counts by status', list.json?.summary?.byStatus?.agts_completed === 3 && list.json?.summary?.byStatus?.new === 1, JSON.stringify(list.json?.summary));
    t.check('guidance requests counted', list.json?.summary?.guidanceRequests === 1);

    t.section('staff filters and search');
    const q = (qs: string) => call('GET', `/api/agts/admin/leads?${qs}`, { token: adminA });
    t.check('status=new → 1', (await q('status=new')).json?.total === 1);
    t.check('classLevel=11 → 4', (await q('classLevel=11')).json?.total === 4);
    t.check('search by partial phone → 1', (await q(`search=${phone(2).slice(-6)}`)).json?.total === 1);
    t.check('search by student name → 1', (await q(`search=${encodeURIComponent(`${NAME} Student C`)}`)).json?.total === 1);
    t.check('guidance=true → 1', (await q('guidance=true')).json?.total === 1);
    t.check('sort=score puts the best result first', (await q('sort=score')).json?.items?.[0]?.phone === phone(1));
    t.check('regex metacharacters in search are inert', (await q('search=.*')).json?.total === 0);
    t.check('limit is capped at 100', (await q('limit=100000')).status === 200);

    t.section('lead detail and complete analysis');
    const leadId = String(leadAfter._id);
    const detail = await call('GET', `/api/agts/admin/leads/${leadId}`, { token: adminA });
    t.check('lead detail → 200 with AGTS history', detail.status === 200 && detail.json?.attempts?.length === 1 && detail.json?.lead?.phone === phone(1), brief(detail));
    const full = await call('GET', `/api/agts/admin/leads/${leadId}/attempts/${att1}`, { token: adminA });
    t.check('complete analysis with per-question answers for staff', full.status === 200 && full.json?.questions?.length === 30 && full.json?.analysis?.overall?.score === ov.score, brief(full));
    t.check('staff view shows the answer key', full.json?.questions?.some((qq: any) => qq.options?.some((o: any) => o.isCorrect)));
    const wrongLead = await call('GET', `/api/agts/admin/leads/${leadId}/attempts/${att3}`, { token: adminA });
    t.check('an attempt of another lead → 404', wrongLead.status === 404, brief(wrongLead));
    const badId = await call('GET', '/api/agts/admin/leads/not-an-id', { token: adminA });
    t.check('a malformed lead id → 404', badId.status === 404);

    t.section('status, notes, follow-up, contact');
    const badStatus = await call('PATCH', `/api/agts/admin/leads/${leadId}/status`, { token: adminA, body: { status: 'admitted' } });
    t.check('unknown status → 400', badStatus.status === 400, brief(badStatus));
    const st = await call('PATCH', `/api/agts/admin/leads/${leadId}/status`, { token: adminA, body: { status: 'counselling', note: 'Booked Saturday', orgId: orgB } });
    t.check('status → counselling', st.status === 200 && st.json?.status === 'counselling', brief(st));
    t.check('history records who changed it', (st.json?.statusHistory || []).some((h: any) => h.to === 'counselling' && h.byName?.startsWith(NAME)));
    t.check('orgId in the body changed nothing', String((await leadOf(phone(1)))?.orgId) === orgA);
    const noteEmpty = await call('POST', `/api/agts/admin/leads/${leadId}/notes`, { token: adminA, body: { text: '   ' } });
    t.check('empty note → 400', noteEmpty.status === 400);
    const note = await call('POST', `/api/agts/admin/leads/${leadId}/notes`, { token: adminA, body: { text: 'Parent wants Science focus <b>bold</b>' } });
    t.check('note → 201 and stored as text', note.status === 201 && note.json?.notes?.some((n: any) => n.text.includes('<b>bold</b>')), brief(note));
    const fuBad = await call('PATCH', `/api/agts/admin/leads/${leadId}/follow-up`, { token: adminA, body: { followUpAt: '2099-01-01' } });
    t.check('follow-up decades away → 400', fuBad.status === 400);
    const today = new Date();
    today.setHours(18, 0, 0, 0);
    const fu = await call('PATCH', `/api/agts/admin/leads/${leadId}/follow-up`, { token: adminA, body: { followUpAt: today.toISOString(), note: 'Call back' } });
    t.check('follow-up set', fu.status === 200 && fu.json?.followUpAt, brief(fu));
    t.check('followUp=due now includes it', (await q('followUp=due')).json?.total === 1);
    const ch = await call('POST', `/api/agts/admin/leads/${leadId}/contact`, { token: adminA, body: { channel: 'whatsapp' } });
    t.check('contact logged (WhatsApp)', ch.status === 200 && ch.json?.lastContactChannel === 'whatsapp');
    const chBad = await call('POST', `/api/agts/admin/leads/${leadId}/contact`, { token: adminA, body: { channel: 'telegram' } });
    t.check('unknown contact channel → 400', chBad.status === 400);
    t.check('contact did not change the status', (await leadOf(phone(1)))?.status === 'counselling');
    const teacherWrite = await call('PATCH', `/api/agts/admin/leads/${leadId}/status`, { token: teacherA, body: { status: 'enrolled' } });
    t.check('teacher cannot change a lead status → 403', teacherWrite.status === 403);
    const audits = await unscoped(() => AuditLog.countDocuments({ userId: new mongoose.Types.ObjectId(userIds[0]), action: /^agts\.lead\./ }));
    t.check('staff actions are audit-logged', audits >= 4, String(audits));

    // A new test for a lead in counselling must not move it backwards.
    t.section('lifecycle is never moved backwards automatically');
    const phone1Test = await unscoped(() => ScholarshipAttempt.findOne({ attemptId: att1 }).lean());
    t.check('fixture: first attempt still submitted', phone1Test?.status === 'submitted');
    const retakeCounselling = await call('POST', '/api/agts/register', { body: reg(1, { testRef: P1.shareLink }) });
    await call('POST', `/api/agts/attempts/${retakeCounselling.json?.attemptId}/submit`, { key: retakeCounselling.json?.attemptAccessKey, body: {} });
    t.check('a retake while in counselling leaves the status at counselling', (await leadOf(phone(1)))?.status === 'counselling');

    t.section('cross-organization isolation');
    const bReg = await call('POST', '/api/agts/register', { body: reg(9), headers: B });
    t.check('org B has no Class 11 papers → friendly 503, no internals', bReg.status === 503 && bReg.json?.code === 'AGTS_QUESTIONS_UNAVAILABLE' && !/Required|Found/.test(bReg.raw), brief(bReg));
    const listBPapers = await call('GET', '/api/agts/tests', { headers: B });
    t.check('org B sees none of org A\'s papers', listBPapers.status === 200 && (listBPapers.json?.tests || []).length === 0, brief(listBPapers));
    const listB = await call('GET', '/api/agts/admin/leads', { token: adminB, headers: B });
    t.check('org B admin sees none of org A\'s leads', listB.status === 200 && listB.json?.total === 0, brief(listB));
    const listBNoHint = await call('GET', '/api/agts/admin/leads', { token: adminB, headers: {} });
    t.check('…and the same without any org hint (org comes from the token)', listBNoHint.status === 200 && listBNoHint.json?.total === 0, brief(listBNoHint));
    const peek = await call('GET', `/api/agts/admin/leads/${leadId}`, { token: adminB, headers: B });
    t.check('org B admin reading an org A lead → 404', peek.status === 404, brief(peek));
    const hint = await call('GET', '/api/agts/admin/leads', { token: adminA, headers: B });
    t.check('org A token with X-Org-Id: B → refused (TENANT_MISMATCH)', hint.status >= 400 && hint.status < 500 && hint.json?.code === 'TENANT_MISMATCH', brief(hint));

    // ── 14. Legacy routes ──────────────────────────────────────────────────
    t.section('legacy /api/scholarship compatibility and hardening');
    const lres = (token: string) => call('GET', '/api/scholarship/results?classLevel=11', { token });
    t.check('results list: student → 403 (was 200: names + phones)', (await lres(studentA)).status === 403);
    t.check('results list: teacher → 403', (await lres(teacherA)).status === 403);
    t.check('results list: admin → 200', (await lres(adminA)).status === 200);
    const lcreate = await call('POST', '/api/scholarship/tests', { token: studentA, body: { testName: 'x', eligibleClasses: [11], subjects: ['Math'] } });
    t.check('create test: student → 403', lcreate.status === 403, brief(lcreate));

    const legacy = await call('POST', '/api/scholarship/attempts', { body: { name: `${NAME} Legacy`, phone: phone(7), classLevel: 11 } });
    t.check('legacy attempt creation still works', (legacy.status === 201 || legacy.status === 200) && legacy.json?.attemptAccessKey, brief(legacy));
    const lid = legacy.json?.attemptId;
    const lkey = legacy.json?.attemptAccessKey;
    const lget = await call('GET', `/api/scholarship/attempts/${lid}`, { headers: { ...A, 'X-Scholarship-Attempt-Key': lkey } });
    t.check('legacy read works with the legacy header', lget.status === 200 && lget.json?.questions?.length === 30);
    t.check('legacy read has no answer key before publishing', !/isCorrect|correctOptionId/.test(lget.raw));
    const lq: string = lget.json?.questions?.[0]?._id;
    const lsave = await call('POST', `/api/scholarship/attempts/${lid}/answer`, {
      headers: { ...A, 'X-Scholarship-Attempt-Key': lkey },
      body: { questionId: lq, answer: { chosenOptionId: correctOf.get(lq), isCorrect: true, marks: 50 } },
    });
    t.check('legacy save → 200', lsave.status === 200, brief(lsave));
    const lsub = await call('POST', `/api/scholarship/attempts/${lid}/submit`, { headers: { ...A, 'X-Scholarship-Attempt-Key': lkey }, body: { answers: {} } });
    t.check('legacy submit → 200', lsub.status === 200, brief(lsub));
    const lgraded: any = await attemptOf(lid);
    t.check('legacy grading: 1 correct of 30 → 1/30 (forged marks ignored; whole-paper maximum)', lgraded.totalScore === 1 && lgraded.maxScore === 30, `${lgraded.totalScore}/${lgraded.maxScore}`);
    const lnoKey = await call('GET', `/api/scholarship/attempts/${lid}`);
    t.check('legacy read without key → refused', lnoKey.status === 400 && /Unauthorized/.test(lnoKey.raw), brief(lnoKey));
    await unscoped(() => ScholarshipAttempt.updateOne({ attemptId: lid }, { $set: { attemptAccessKey: '' } }));
    const keyless = await call('GET', `/api/scholarship/attempts/${lid}`);
    t.check('a pre-key attempt is no longer served (and issued a key) by id alone', keyless.status === 400 && !keyless.json?.attemptAccessKey, brief(keyless));
    const legacyAgts = await call('GET', `/api/scholarship/attempts/${att1}`, { headers: { ...A, 'X-Scholarship-Attempt-Key': key1 } });
    t.check('an AGTS attempt read through the legacy route never includes solutions', legacyAgts.status === 200 && !/isCorrect|correctOptionId|correctAnswerText/.test(legacyAgts.raw));

    t.section('shared result links');
    const pub = await call('POST', '/api/scholarship/results/publish', { token: adminA, body: { classLevel: 11 } });
    t.check('admin publish → 200 with AGTS result links', pub.status === 200 && (pub.json?.resultLinks || []).every((l: any) => /\/agts\/result\?token=[a-f0-9]{40}$/.test(l.publicUrl)), brief(pub));
    const link = (pub.json?.resultLinks || []).find((l: any) => l.attemptId === att1)?.publicUrl || '';
    const token = link.split('token=')[1];
    const shared = await call('GET', `/api/agts/shared/${token}`);
    t.check('shared AGTS result → 200 report without contact details', shared.status === 200 && shared.json?.analysis && !shared.raw.includes(phone(1)), brief(shared));
    const legacyShared = await call('GET', `/api/scholarship/public/results/${token}`);
    t.check('legacy public-result route: no phone, no solutions for an AGTS attempt', legacyShared.status === 200 && !legacyShared.raw.includes(phone(1)) && !/isCorrect|correctOptionId/.test(legacyShared.raw), brief(legacyShared));
    const badToken = await call('GET', '/api/agts/shared/deadbeef');
    t.check('a malformed shared token → 404', badToken.status === 404);

    // ── 15. Rate limiting (last: it exhausts the registration budget) ──────
    t.section('rate limiting');
    let limited: Res | null = null;
    for (let i = 0; i < 45 && !limited; i++) {
      const r = await call('POST', '/api/agts/register', { body: { spam: i } });
      if (r.status === 429) limited = r;
    }
    t.check('registration is rate limited per network → 429 JSON', limited?.status === 429 && limited?.json?.code === 'AGTS_RATE_LIMITED', limited ? brief(limited) : 'never limited');
  } catch (err) {
    failed = true;
    console.error('\n  ✗ suite aborted:', (err as Error).stack || err);
  } finally {
    await cleanup();
    if (!leadsExisted && (await collectionNames()).includes('leads')) {
      await db.dropCollection('leads');
    }
    const after = await collectionNames();
    console.log(`\n  scratch collections after cleanup: ${after.length} (before: ${before.length})`);
    t.check('scratch database left with the same collections it started with', after.length === before.length && after.every((n: string) => before.includes(n)));
    await close();
  }
  if (failed) t.check('suite completed without aborting', false);
  t.report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
