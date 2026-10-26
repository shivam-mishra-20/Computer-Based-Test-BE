/**
 * Student notifications, results, attendance and push devices — end to end,
 * through the real app, on the `test` database ONLY.
 *
 *   npx ts-node --transpile-only scripts/safety/student-notifications.e2e.test.ts
 *
 * ── Why `test` and not a scratch database ───────────────────────────────────
 * This suite writes only tagged synthetic fixtures and deletes every one of
 * them by id when it finishes (or fails). It refuses to run unless the target
 * database is named exactly `test`, checked before connecting and again after.
 * It never drops a collection: a collection the run had to create (the first
 * document of a kind) is left empty and listed in the report.
 *
 * ── What is real and what is not ────────────────────────────────────────────
 * Real: the Express app, routing, auth, tenancy, Mongo, every producer and
 * reader under test. Replaced: the Expo push client, by a recorder — so the
 * suite proves what WOULD be sent, to which tokens, and how Expo's errors are
 * handled. It does not prove delivery to a phone; nothing short of a real
 * device and FCM credentials can.
 */

import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { config } from 'dotenv';
import { configureDnsForSrv, requireEnv } from './lib';

config();

const FORBIDDEN = new Set([
  'abhigyangurukul',
  'abhigyangurukul_console',
  'admin',
  'local',
  'sample_mflix',
]);
const RUN = `zznotif${Date.now().toString(36)}`;
const PASSWORD = 'E2e-Pass-2026!';

function testUri(prod: string): string {
  const m = prod.match(
    /^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/,
  );
  if (!m) throw new Error('MONGO_URI could not be parsed.');
  return `${m[1]}test${m[3] ?? ''}`;
}
function assertTestName(name: string): void {
  if (name !== 'test' || FORBIDDEN.has(name) || /_scratch/.test(name))
    throw new Error(`TEST ABORTED — UNSAFE DATABASE "${name}"`);
}

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(
      `  ✗ ${label}${detail === undefined ? '' : `\n      ${JSON.stringify(detail).slice(0, 400)}`}`,
    );
  }
}
const section = (t: string) => console.log(`\n${t}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Res {
  status: number;
  json: any;
  raw: string;
}
function request(
  port: number,
  method: string,
  path: string,
  opts: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? null : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.headers ?? {}),
          ...(data
            ? { 'Content-Length': String(Buffer.byteLength(data)) }
            : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json: any = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json, raw });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const uri = testUri(requireEnv('MONGO_URI'));
  assertTestName(uri.match(/\/([^/?]+)(\?|$)/)?.[1] ?? '');
  configureDnsForSrv();
  Object.assign(process.env, {
    MONGO_URI: uri,
    MONGODB_URI: uri,
    PLATFORM_MONGODB_URI: '',
    MONGO_URI_DIRECT: '',
    SERVICE_REALM: 'platform',
    TENANT_MODE: 'claim',
    TENANT_ENFORCEMENT: process.env.E2E_TENANT_ENFORCEMENT || 'warn',
    DB_BOOT_SCHEMA_SYNC: 'false',
    ENABLE_CRON: 'false',
    PPT_WORKER_EMBEDDED: 'false',
    APP_BUILD_WORKER_EMBEDDED: 'false',
    ENABLE_ATTENDANCE_WEBHOOK: 'false',
    REDIS_ENABLED: 'false',
    REDIS_URL: 'redis://127.0.0.1:1',
    APP_BUILD_QUEUE_NAME: `app-builds-${RUN}`,
    AI_QUEUE_NAME: `ai-${RUN}`,
    ADMIN_EMAIL: '',
    ADMIN_PASSWORD: '',
    EXPO_TOKEN: '',
    PLATFORM_GOOGLE_SERVICES_PATH: '',
    PLATFORM_GOOGLE_SERVICES_JSON: '',
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    AUTH_RATE_LIMIT_MAX: '5000',
    PUBLIC_FORM_RATE_LIMIT_MAX: '5000',
    GUARDIAN_VERIFY_MAX: '5000',
    NODE_ENV: 'development',
  });
  process.on('unhandledRejection', () => {
    /* the server tolerates these too */
  });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registerTenancy } = require('../../src/core/tenancy');
  registerTenancy();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mongoose = require('mongoose');
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 20000,
    autoCreate: false,
    autoIndex: false,
  });
  assertTestName(mongoose.connection.db.databaseName);
  const db = mongoose.connection.db;
  const baseline: string[] = (
    await db.listCollections({}, { nameOnly: true }).toArray()
  )
    .map((c: { name: string }) => c.name)
    .sort();
  console.log(
    `[e2e] connected to "${db.databaseName}" — ${baseline.length} collections at baseline, run ${RUN}`,
  );

  const created: Record<string, unknown[]> = {};
  const remember = (collection: string, id: unknown) =>
    (created[collection] ??= []).push(id);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    withoutTenantScope,
    runWithTenant,
  } = require('../../src/core/tenancy/context');
  const unscoped = <T>(fn: () => Promise<T>) =>
    withoutTenantScope(`e2e:${RUN}`, fn) as Promise<T>;
  /* eslint-disable @typescript-eslint/no-var-requires */
  const Org = require('../../src/models/Org').default;
  const User = require('../../src/models/User').default;
  const GuardianLink = require('../../src/models/GuardianLink').default;
  const PushDevice = require('../../src/models/PushDevice').default;
  const pushDelivery = require('../../src/services/pushDelivery');
  const {
    notifyAttendanceSynced,
  } = require('../../src/services/AttendanceCron');
  /* eslint-enable @typescript-eslint/no-var-requires */

  // ── Expo, recorded ─────────────────────────────────────────────────────
  const sent: Array<{
    to: string;
    title: string;
    body: string;
    data: Record<string, string>;
  }> = [];
  const verdict = new Map<string, string>(); // token → Expo error code
  pushDelivery.__setExpoClient({
    chunkPushNotifications: (messages: unknown[]) => [messages],
    sendPushNotificationsAsync: async (
      messages: Array<{
        to: string;
        title: string;
        body: string;
        data: Record<string, string>;
      }>,
    ) =>
      messages.map((m) => {
        sent.push({ to: m.to, title: m.title, body: m.body, data: m.data });
        const code = verdict.get(m.to);
        return code
          ? { status: 'error', message: code, details: { error: code } }
          : { status: 'ok', id: crypto.randomUUID() };
      }),
  });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const app = require('../../src/app').default || require('../../src/app');
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const api = (
    method: string,
    path: string,
    opts?: Parameters<typeof request>[3],
  ) => request(port, method, path, opts);

  try {
    /* ── Fixtures ───────────────────────────────────────────────────────── */
    const makeOrg = async (key: string, name: string) => {
      const org = await unscoped(() =>
        Org.create({
          name,
          slug: `${RUN}-${key}`,
          status: 'active',
          branding: { appName: name },
          mobile: { androidPackage: `com.zz.${RUN}.${key}` },
        }),
      );
      remember('orgs', org._id);
      return String(org._id);
    };
    const A = await makeOrg('a', 'Northgate Academy (E2E)');
    const B = await makeOrg('b', 'Riverside Institute (E2E)');
    const person = async (
      org: string,
      tag: string,
      role: string,
      extra: Record<string, unknown> = {},
    ) => {
      const u = await unscoped(() =>
        User.create({
          name: `E2E ${tag}`,
          email: `${RUN}-${tag}@example.test`,
          password: PASSWORD,
          role,
          status: 'approved',
          orgId: org,
          ...extra,
        }),
      );
      remember('users', u._id);
      return u;
    };
    const teacher = await person(A, 'teacher', 'teacher', {
      name: 'Ravi Teacher',
    });
    const teacher2 = await person(A, 'teacher2', 'teacher', {
      name: 'Other Teacher',
    });
    const admin = await person(A, 'admin', 'admin', { name: 'Meera Admin' });
    const s1 = await person(A, 's1', 'student', {
      name: 'Asha Verma',
      empCode: `${RUN}-S1`,
      phone: '9000000301',
      classLevel: 'Class 11',
      batch: 'Alpha',
    });
    const s2 = await person(A, 's2', 'student', {
      name: 'Kabir Rao',
      empCode: `${RUN}-S2`,
      phone: '9000000302',
      classLevel: 'Class 11',
      batch: 'Alpha',
    });
    const s3 = await person(A, 's3', 'student', {
      name: 'Dev Shah',
      empCode: `${RUN}-S3`,
      phone: '9000000303',
      classLevel: 'Class 11',
      batch: 'Alpha',
    });
    const twin = await person(A, 'twin', 'student', {
      name: 'Asha Verma',
      empCode: `${RUN}-S4`,
      phone: '9000000304',
      classLevel: 'Class 11',
      batch: 'Alpha',
    });
    const fresh = await person(A, 'fresh', 'student', {
      name: 'New Joiner',
      empCode: `${RUN}-S5`,
      phone: '9000000305',
      classLevel: 'Class 11',
      batch: 'Alpha',
    });
    const parent = await person(A, 'parent', 'parent', {
      name: 'Sunita Verma',
      phone: '9000000399',
    });
    const sb1 = await person(B, 'sb1', 'student', {
      name: 'Other Org Student',
      empCode: `${RUN}-B1`,
      phone: '9000000401',
      classLevel: 'Class 11',
      batch: 'Alpha',
    });
    const link = await unscoped(() =>
      GuardianLink.create({
        orgId: A,
        parentId: parent._id,
        studentId: s1._id,
        status: 'verified',
        method: 'student-code+phone',
        verifiedAt: new Date(),
        verifiedBy: String(admin._id),
        verifiedByKind: 'org-admin',
      }),
    );
    remember('guardianlinks', link._id);

    // Class-bank questions: the subject lives on the question (top-level, as in the real banks, or tags.subject).
    const q = (subject: { top?: string; tag?: string }) => ({
      _id: new mongoose.Types.ObjectId(),
      text: `${RUN} question`,
      type: 'mcq',
      options: [
        { _id: new mongoose.Types.ObjectId(), text: 'a', isCorrect: true },
        { _id: new mongoose.Types.ObjectId(), text: 'b', isCorrect: false },
      ],
      marks: 4,
      ...(subject.top ? { subject: subject.top } : {}),
      ...(subject.tag ? { tags: { subject: subject.tag } } : {}),
      orgId: A,
      e2eRun: RUN,
      createdAt: new Date(),
    });
    const questions = [
      q({ top: 'Physics' }),
      q({ top: 'Physics' }),
      q({ tag: 'Chemistry' }),
    ];
    await db.collection('class_11').insertMany(questions);
    questions.forEach((x) => remember('class_11', x._id));

    const exam = async (
      title: string,
      sections: unknown[],
      createdBy: unknown,
    ) => {
      const res = await db.collection('exams').insertOne({
        title,
        classLevel: '11',
        batch: 'Alpha',
        isPublished: true,
        totalDurationMins: 30,
        markingScheme: { correct: 4, incorrect: -1, unattempted: 0 },
        sections,
        schedule: {
          startAt: new Date(Date.now() - 3 * 864e5),
          endAt: new Date(Date.now() - 3 * 864e5 + 36e5),
          timezone: 'Asia/Kolkata',
        },
        assignedTo: { users: [], groups: [] },
        createdBy,
        owner: createdBy,
        orgId: A,
        e2eRun: RUN,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      remember('exams', res.insertedId);
      return res.insertedId;
    };
    const exam1 = await exam(
      `${RUN} Rotational Motion — Unit Test`,
      [
        {
          _id: new mongoose.Types.ObjectId(),
          title: 'Section 1',
          questionIds: questions.map((x) => x._id),
        },
      ],
      teacher._id,
    );
    const exam2 = await exam(
      `${RUN} Vectors — Chapter Test`,
      [
        {
          _id: new mongoose.Types.ObjectId(),
          title: 'Section 1',
          questionIds: [new mongoose.Types.ObjectId()],
        },
      ],
      teacher._id,
    );
    const exam3 = await exam(
      `${RUN} Cells — Quiz`,
      [
        {
          _id: new mongoose.Types.ObjectId(),
          title: 'Biology',
          questionIds: [new mongoose.Types.ObjectId()],
        },
      ],
      teacher._id,
    );

    const attempt = async (
      examId: unknown,
      user: { _id: unknown },
      submitted: boolean,
      score = 16,
      max = 20,
    ) => {
      const res = await db.collection('attempts').insertOne({
        examId,
        userId: user._id,
        orgId: A,
        status: submitted ? 'submitted' : 'in-progress',
        resultPublished: false,
        totalScore: score,
        maxScore: max,
        percentage: (score / max) * 100,
        answers: [],
        startedAt: new Date(Date.now() - 3 * 864e5),
        submittedAt: submitted
          ? new Date(Date.now() - 3 * 864e5 + 20 * 6e4)
          : null,
        createdAt: new Date(),
        e2eRun: RUN,
      });
      remember('attempts', res.insertedId);
      return res.insertedId;
    };
    await attempt(exam1, s1, true, 16, 20);
    await attempt(exam1, s2, false);
    const s3attempt = await attempt(exam2, s3, true, 10, 20);
    await attempt(exam3, s3, true, 5, 10);

    // A written test: s1's 38/50, a same-named classmate's 12/50; an absence elsewhere.
    const written = await db.collection('testresults').insertOne({
      testName: `${RUN} Mathematics — Written Test 1`,
      testDate: new Date(Date.now() - 864e5).toISOString().slice(0, 10),
      class: 'Class 11',
      batch: 'Alpha',
      subject: 'Mathematics',
      maxMarks: 50,
      assignmentType: 'class',
      assignedClasses: [],
      assignedBatches: [],
      assignedStudents: [],
      notifiedUpcoming: true,
      resultsNotifiedStudentIds: [],
      studentResults: [
        {
          studentId: String(twin._id),
          studentName: 'Asha Verma',
          marksObtained: 12,
          percentage: 24,
          grade: 'F',
        },
        {
          studentId: String(s1._id),
          studentName: 'Asha Verma',
          marksObtained: 38,
          percentage: 76,
          grade: 'B',
        },
      ],
      createdBy: String(teacher._id),
      orgId: A,
      e2eRun: RUN,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    remember('testresults', written.insertedId);
    const absentTest = await db.collection('testresults').insertOne({
      testName: `${RUN} Chemistry — Written Test 2`,
      testDate: new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10),
      class: 'Class 11',
      batch: 'Alpha',
      subject: 'Chemistry',
      maxMarks: 40,
      assignmentType: 'class',
      assignedClasses: [],
      assignedBatches: [],
      assignedStudents: [],
      notifiedUpcoming: true,
      resultsNotifiedStudentIds: [],
      studentResults: [
        {
          studentId: String(s1._id),
          studentName: 'Asha Verma',
          marksObtained: 0,
          percentage: 0,
          grade: 'AB',
          isAbsent: true,
        },
      ],
      createdBy: String(teacher._id),
      orgId: A,
      e2eRun: RUN,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    remember('testresults', absentTest.insertedId);

    // Attendance: s1 punched from the 1st (an account created today whose
    // history began earlier); `fresh` has never punched.
    const now = new Date();
    const punches = [];
    for (let d = 1; d < now.getDate(); d++) {
      const day = new Date(now.getFullYear(), now.getMonth(), d, 10, 0, 0);
      if (day.getDay() === 0) continue;
      punches.push({
        _id: new mongoose.Types.ObjectId(),
        studentId: s1._id,
        date: day,
        status: 'present',
        clockIn: '07:55',
        clockOut: '15:40',
        orgId: A,
        e2eRun: RUN,
        createdAt: new Date(),
      });
    }
    if (punches.length) await db.collection('attendances').insertMany(punches);
    punches.forEach((p) => remember('attendances', p._id));

    const login = async (org: string, tag: string) =>
      (
        await api('POST', '/api/auth/login', {
          headers: { 'X-Org-Id': org },
          body: {
            email: `${RUN}-${tag}@example.test`,
            password: PASSWORD,
            session: 'refresh',
          },
        })
      ).json?.token as string;
    const tok: Record<string, string> = {};
    for (const [org, tag] of [
      [A, 'teacher'],
      [A, 'teacher2'],
      [A, 'admin'],
      [A, 's1'],
      [A, 's2'],
      [A, 's3'],
      [A, 'fresh'],
      [A, 'parent'],
      [B, 'sb1'],
    ] as const)
      tok[tag] = await login(org, tag);
    check(
      'every fixture account signs in',
      Object.values(tok).every(Boolean),
      Object.fromEntries(Object.entries(tok).map(([k, v]) => [k, Boolean(v)])),
    );

    const inbox = async (who: string) =>
      (await api('GET', '/api/notifications?limit=50', { token: tok[who] }))
        .json ?? {};
    const resultNotices = async (who: string) =>
      ((await inbox(who)).notifications ?? []).filter(
        (n: any) => n?.data?.type === 'exam_result',
      );

    /* ── E. Subjects (before publication: no scores either) ─────────────── */
    section('E. Online result subjects');
    const mineBefore =
      (await api('GET', '/api/attempts/mine', { token: tok.s1 })).json ?? [];
    const row1 = (Array.isArray(mineBefore) ? mineBefore : []).find(
      (r: any) => String(r.examId) === String(exam1),
    );
    check(
      'a result row names its exam\'s subjects, from the questions ("Section 1" is not a subject)',
      row1?.subject === 'Physics, Chemistry',
      row1?.subject,
    );
    check(
      'before publication the row carries no score',
      row1 && row1.totalScore === null && row1.percentage === null,
      row1,
    );
    const mine3 = ((await api('GET', '/api/attempts/mine', { token: tok.s3 }))
      .json ?? []) as any[];
    check(
      'questions that no longer exist and a generic section: no subject (null), not "Section 1"',
      mine3.find((r) => String(r.examId) === String(exam2))?.subject === null,
    );
    check(
      '…but a section titled with a subject still speaks for it',
      mine3.find((r) => String(r.examId) === String(exam3))?.subject ===
        'Biology',
    );
    const assigned = ((
      await api('GET', '/api/attempts/assigned', { token: tok.s1 })
    ).json ?? []) as any[];
    check(
      'the exam list carries the same subject',
      assigned.find((e) => String(e._id) === String(exam1))?.subject ===
        'Physics, Chemistry',
    );
    const mineB = ((await api('GET', '/api/attempts/mine', { token: tok.sb1 }))
      .json ?? []) as any[];
    check(
      "another organization's student sees none of these attempts",
      mineB.length === 0,
      mineB.length,
    );

    /* ── Push devices ───────────────────────────────────────────────────── */
    section('Push devices — one installation, one account');
    const T1 = `ExponentPushToken[${RUN}-one]`;
    const T2 = `ExponentPushToken[${RUN}-two]`;
    const T3 = `ExponentPushToken[${RUN}-three]`;
    const I1 = `${RUN}install1`;
    const I2 = `${RUN}install2`;
    const I3 = `${RUN}install3`;
    const reg = (who: string, token: string, installationId: string) =>
      api('POST', '/api/notifications/devices', {
        token: tok[who],
        body: {
          token,
          installationId,
          platform: 'android',
          appId: `com.zz.${RUN}.a`,
          projectId: 'e2e',
        },
      });
    check(
      'a student registers this installation',
      (await reg('s1', T1, I1)).status === 200,
    );
    check(
      'a malformed token is refused',
      (
        await api('POST', '/api/notifications/devices', {
          token: tok.s1,
          body: { token: 'nope', installationId: I1, platform: 'android' },
        })
      ).status === 400,
    );
    const devices = () =>
      unscoped(() =>
        PushDevice.find({ installationId: { $in: [I1, I2, I3] } }).lean(),
      ) as Promise<any[]>;
    let all = await devices();
    check(
      'the device is stored for that account, in its organization',
      all.length === 1 &&
        String(all[0].userId) === String(s1._id) &&
        String(all[0].orgId) === A,
      all,
    );
    // The phone changes hands: same install, another account signs in.
    check(
      'another account signing in on the same installation takes it over',
      (await reg('s2', T1, I1)).status === 200,
    );
    all = await devices();
    check(
      "…and the previous account's registration is gone (no more of their pushes on this phone)",
      all.length === 1 && String(all[0].userId) === String(s2._id),
      all,
    );
    // Release without a session (signed out offline, token expired).
    const release = (installationId: string, token: string) =>
      api('POST', '/api/notifications/devices/release', {
        body: { installationId, token },
      });
    check(
      'release without a session needs the exact token: a wrong one removes nothing',
      (await release(I1, T2)).json?.released === false &&
        (await devices()).length === 1,
    );
    check(
      '…the right one releases it',
      (await release(I1, T1)).json?.released === true &&
        (await devices()).length === 0,
    );
    check(
      'signing out (with the session) removes only that installation',
      (await reg('s1', T1, I1)).status === 200 &&
        (
          await api('DELETE', `/api/notifications/devices/${I1}`, {
            token: tok.s1,
          })
        ).json?.removed === 1,
    );
    await reg('s1', T1, I1);
    await reg('s3', T3, I3);
    await reg('s2', T2, I2);
    verdict.set(T3, 'DeviceNotRegistered');
    verdict.set(T2, 'InvalidCredentials');

    /* ── A. Online result notifications ─────────────────────────────────── */
    section('A. Publishing online results notifies, once, only the entitled');
    const publish = (who: string, examId: unknown, state: string) =>
      api('POST', `/api/exam-review/${examId}/state`, {
        token: tok[who],
        body: { state },
      });
    const byStudent = await publish('s1', exam1, 'published');
    check(
      'a student cannot publish',
      byStudent.status >= 400,
      byStudent.status,
    );
    const byOther = await publish('teacher2', exam1, 'published');
    check(
      'a teacher who does not own the exam cannot publish',
      byOther.status >= 400,
      byOther.status,
    );
    check(
      'no notification before a real publish',
      (await resultNotices('s1')).length === 0,
    );
    sent.length = 0;
    const published = await publish('teacher', exam1, 'published');
    check(
      'the owning teacher publishes',
      published.status === 200,
      published.status,
    );
    await sleep(1500);
    const n1 = await resultNotices('s1');
    check(
      'the student who submitted is told — exactly once',
      n1.length === 1,
      n1.length,
    );
    check(
      'the notification names the exam and carries no score',
      n1[0]?.data?.examId === String(exam1) &&
        !/\d+\s*\/\s*\d+|%/.test(`${n1[0]?.title} ${n1[0]?.message}`) &&
        !('totalScore' in (n1[0]?.data ?? {})),
      n1[0],
    );
    check(
      'a student still mid-attempt is not told (nothing of theirs was published)',
      (await resultNotices('s2')).length === 0,
    );
    check(
      'a student of another exam is not told',
      (await resultNotices('s3')).length === 0,
    );
    check(
      "another organization's student is not told",
      (await resultNotices('sb1')).length === 0,
    );
    const pushToS1 = sent.filter((m) => m.to === T1);
    check(
      'a push went to the student’s device, carrying the notification id and route — not the score',
      pushToS1.length === 1 &&
        pushToS1[0].data.type === 'exam_result' &&
        pushToS1[0].data.notificationId === String(n1[0]?._id) &&
        !/\d+\s*\/\s*\d+|%/.test(pushToS1[0].body),
      pushToS1,
    );
    const mineAfter = ((
      await api('GET', '/api/attempts/mine', { token: tok.s1 })
    ).json ?? []) as any[];
    const publishedRow = mineAfter.find(
      (r) => String(r.examId) === String(exam1),
    );
    check(
      'now the result row carries the score',
      typeof publishedRow?.totalScore === 'number' &&
        typeof publishedRow?.maxScore === 'number',
      publishedRow,
    );

    await publish('teacher', exam1, 'draft');
    await publish('teacher', exam1, 'published');
    await publish('teacher', exam1, 'republished');
    await sleep(1200);
    check(
      'unpublish → publish → republish: still one notification',
      (await resultNotices('s1')).length === 1,
    );
    check('…and no second push', sent.filter((m) => m.to === T1).length === 1);

    sent.length = 0;
    const [p1, p2] = await Promise.all([
      api('POST', `/api/attempts/${s3attempt}/publish`, {
        token: tok.teacher,
        body: { publish: true },
      }),
      api('POST', `/api/attempts/${s3attempt}/publish`, {
        token: tok.teacher,
        body: { publish: true },
      }),
    ]);
    check(
      'publishing one attempt (twice, at once) succeeds',
      p1.status === 200 && p2.status === 200,
      [p1.status, p2.status],
    );
    await sleep(1500);
    check(
      '…and tells that one student exactly once',
      (await resultNotices('s3')).length === 1,
      (await resultNotices('s3')).length,
    );
    check(
      'a dead token (DeviceNotRegistered) is removed',
      !(await devices()).some((d) => d.token === T3),
    );

    /* ── Push: credentials and claims ───────────────────────────────────── */
    section('Push delivery — Expo errors and once-only claims');
    const testPush = await api('POST', '/api/notifications/test-push', {
      token: tok.s2,
      body: {},
    });
    check(
      'the test push reports a device whose build has no FCM key (InvalidCredentials)',
      testPush.status === 200 &&
        testPush.json?.sent === 0 &&
        (testPush.json?.failing ?? []).some(
          (f: any) => f.lastError === 'InvalidCredentials',
        ),
      testPush.json,
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Notification = require('../../src/models/Notification').default;
    const doc = await unscoped(() =>
      Notification.create({
        userId: s1._id,
        orgId: A,
        type: 'general',
        title: `${RUN} claim`,
        message: 'once',
        data: { type: 'test' },
        read: false,
      }),
    );
    remember('notifications', doc._id);
    const first = await unscoped(() => pushDelivery.pushNotifications([doc]));
    const second = await unscoped(() => pushDelivery.pushNotifications([doc]));
    check(
      'the same stored notification is pushed once, however often delivery runs',
      (first as any).claimed === 1 && (second as any).claimed === 0,
      [first, second],
    );

    /* ── C. Attendance notification format ──────────────────────────────── */
    section('C. Attendance sync notifications (message, not body)');
    await runWithTenant({ orgId: A, userId: null, source: 'claim' }, () =>
      notifyAttendanceSynced([String(s1._id)]),
    );
    await sleep(500);
    const box = await inbox('s1');
    const attendanceRows = (box.notifications ?? []).filter(
      (n: any) => n?.data?.type === 'attendance',
    );
    check(
      'the sync now stores ONE inbox entry, with its text in `message`',
      attendanceRows.length === 1 &&
        /synced/.test(attendanceRows[0]?.message ?? ''),
      attendanceRows,
    );
    const legacy = await db
      .collection('notifications')
      .insertOne({
        userId: s1._id,
        orgId: A,
        type: 'attendance',
        title: `${RUN} legacy`,
        body: 'Legacy body text',
        read: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    remember('notifications', legacy.insertedId);
    const box2 = await inbox('s1');
    const legacyRow = (box2.notifications ?? []).find(
      (n: any) => String(n._id) === String(legacy.insertedId),
    );
    check(
      'a legacy row written with `body` reads as `message`',
      legacyRow?.message === 'Legacy body text' &&
        !('body' in (legacyRow ?? {})),
      legacyRow,
    );
    const unreadBefore = box2.unreadCount;
    check(
      '…and counts as unread',
      typeof unreadBefore === 'number' && unreadBefore >= 3,
      unreadBefore,
    );
    await api('PUT', `/api/notifications/${legacy.insertedId}/read`, {
      token: tok.s1,
    });
    check(
      'marking it read lowers the count by one',
      (await inbox('s1')).unreadCount === unreadBefore - 1,
    );
    await api('PUT', '/api/notifications/read-all', { token: tok.s1 });
    check(
      'mark-all leaves nothing unread',
      (await inbox('s1')).unreadCount === 0,
    );
    for (const n of [...(box2.notifications ?? [])])
      remember('notifications', n._id);

    /* ── D. Parent average ──────────────────────────────────────────────── */
    section("D. A parent's average includes written tests (pooled)");
    const progress = await api('GET', `/api/parent/wards/${s1._id}/progress`, {
      token: tok.parent,
    });
    check(
      'the parent reads their ward’s progress',
      progress.status === 200,
      progress.status,
    );
    // Publishing recomputes the online score from the attempt's answers, so the
    // expectation is built from what was actually published.
    const online = await db
      .collection('attempts')
      .findOne({ examId: exam1, userId: s1._id });
    const expected = Math.round(
      ((((online?.totalScore as number) ?? 0) + 38) /
        (((online?.maxScore as number) ?? 0) + 50)) *
        100,
    );
    check(
      `average = (online ${online?.totalScore}/${online?.maxScore} + written 38/50) pooled = ${expected}% — the absence and the same-named classmate’s 12 left out`,
      progress.json?.avgScore === expected && progress.json?.examsTaken === 2,
      { avg: progress.json?.avgScore, exams: progress.json?.examsTaken },
    );
    const wardResults = await api(
      'GET',
      `/api/parent/wards/${s1._id}/results`,
      { token: tok.parent },
    );
    check(
      "the parent's result rows name the subject too",
      (wardResults.json?.results ?? []).some(
        (r: any) => r?.exam?.subject === 'Physics, Chemistry',
      ),
      wardResults.json,
    );
    check(
      'a parent cannot read a child who is not theirs',
      (
        await api('GET', `/api/parent/wards/${twin._id}/progress`, {
          token: tok.parent,
        })
      ).status === 404,
    );

    /* ── Attendance start ───────────────────────────────────────────────── */
    section('Attendance — no absences before a student joined');
    const month = `month=${now.getMonth() + 1}&year=${now.getFullYear()}`;
    const meFresh = (
      await api('GET', `/api/attendance/me?${month}`, { token: tok.fresh })
    ).json;
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    check(
      'a student who joined today has no working day before today',
      Array.isArray(meFresh?.meta?.workingDates) &&
        meFresh.meta.workingDates.every((d: string) => d >= today) &&
        meFresh.stats.absent <= 1,
      meFresh?.stats,
    );
    const meS1 = (
      await api('GET', `/api/attendance/me?${month}`, { token: tok.s1 })
    ).json;
    check(
      'an account created today whose punches began on the 1st still counts from the 1st',
      Array.isArray(meS1?.meta?.workingDates) &&
        meS1.meta.workingDates.some((d: string) => d < today) &&
        meS1.stats.present >= punches.length - 1,
      meS1?.stats,
    );
    const meTeacher = (
      await api('GET', `/api/attendance/me?${month}`, { token: tok.teacher })
    ).json;
    check(
      'staff are unchanged: every working day of the month so far still counts',
      (meTeacher?.meta?.workingDates ?? []).length >=
        (meFresh?.meta?.workingDates ?? []).length +
          (now.getDate() > 2 ? 1 : 0),
      {
        teacher: (meTeacher?.meta?.workingDates ?? []).length,
        fresh: (meFresh?.meta?.workingDates ?? []).length,
      },
    );
    const exportRes = await api(
      'GET',
      `/api/attendance/admin/export?role=student&search=${encodeURIComponent('New Joiner')}`,
      { token: tok.admin },
    );
    const freshRow = (exportRes.json?.users ?? []).find(
      (u: any) => String(u.userId) === String(fresh._id),
    );
    check(
      'the admin export applies the same rule to the student’s row',
      freshRow && freshRow.stats.expected <= 1 && freshRow.stats.absent <= 1,
      { status: exportRes.status, row: freshRow?.stats },
    );
  } finally {
    /* ── Cleanup: every fixture by id; nothing dropped ─────────────────── */
    server.close();
    const removed: Record<string, number> = {};
    await unscoped(async () => {
      const del = async (
        collection: string,
        filter: Record<string, unknown>,
      ) => {
        const r = await db.collection(collection).deleteMany(filter);
        if (r.deletedCount)
          removed[collection] = (removed[collection] ?? 0) + r.deletedCount;
      };
      for (const [collection, ids] of Object.entries(created))
        await del(collection, { _id: { $in: ids } });
      const userIds = (created.users ?? []) as unknown[];
      const orgIds = (created.orgs ?? []) as unknown[];
      const orgKeys = [...orgIds, ...orgIds.map(String)];
      await del('notifications', { userId: { $in: userIds } });
      await del('attempts', { userId: { $in: userIds } });
      await del('examevaluations', {
        examId: { $in: (created.exams ?? []) as unknown[] },
      });
      await del('reviewauditlogs', {
        examId: { $in: (created.exams ?? []) as unknown[] },
      });
      await del('pushdevices', { userId: { $in: userIds } });
      await del('entitlements', { orgId: { $in: orgKeys } });
      await del('auditlogs', { orgId: { $in: orgKeys } });
      await del('guardianlinks', { orgId: { $in: orgKeys } });
    });
    const after: string[] = (
      await db.listCollections({}, { nameOnly: true }).toArray()
    )
      .map((c: { name: string }) => c.name)
      .sort();
    const leftovers: Record<string, number> = {};
    for (const name of after) {
      const n = await db
        .collection(name)
        .countDocuments({
          $or: [
            { e2eRun: RUN },
            {
              orgId: {
                $in: [
                  ...((created.orgs ?? []) as unknown[]),
                  ...((created.orgs ?? []) as unknown[]).map(String),
                ],
              },
            },
          ],
        });
      if (n) leftovers[name] = n;
    }
    const newCollections = after.filter((n) => !baseline.includes(n));
    console.log(`\n[e2e] removed ${JSON.stringify(removed)}`);
    console.log(
      `[e2e] documents left from this run: ${Object.keys(leftovers).length ? JSON.stringify(leftovers) : 'none'}`,
    );
    console.log(
      `[e2e] collections: ${after.length} (baseline ${baseline.length})${newCollections.length ? ` — created by this run and left EMPTY (not dropped): ${newCollections.join(', ')}` : ''}`,
    );
    for (const name of newCollections) {
      const n = await db.collection(name).countDocuments({});
      if (n) console.log(`[e2e] WARNING: ${name} is new and not empty (${n})`);
    }
    await mongoose.disconnect();
  }
  console.log(`\n  ${checks - failures}/${checks} checks passed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('[e2e] failed:', error?.stack ?? error);
  process.exit(1);
});
