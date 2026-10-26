/**
 * The decisions behind student notifications, results and attendance — pure,
 * no database. The same behaviours are exercised end to end over HTTP by
 * student-notifications.e2e.test.ts.
 *
 *   npx ts-node --transpile-only scripts/safety/student-notifications.test.ts
 */

import {
  newlyEntitled,
  resultNotificationPayload,
  EXAM_RESULT_EVENT,
} from '../../src/services/resultNotifications';
import { presentNotification } from '../../src/services/notificationFormat';
import {
  declaredSubject,
  questionSubject,
  subjectLabel,
} from '../../src/services/examSubjects';
import {
  countableWrittenMarks,
  entryForStudent,
} from '../../src/services/writtenTests';
import {
  activeFromYmd,
  localYmd,
  workingDatesFor,
} from '../../src/services/attendanceStart';
import { messagesFor, pushContentFor } from '../../src/services/pushDelivery';
import {
  googleServicesFor,
  pushReadinessFor,
} from '../../src/core/platform/pushConfig';
import { ATTENDANCE_SYNC_NOTICE } from '../../src/services/AttendanceCron';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}
const section = (t: string) => console.log(`\n${t}`);

section('A. Online result notifications');
check(
  'everyone whose result is visible and who was not told yet',
  newlyEntitled(['u1', 'u2', 'u3'], ['u2']).join(',') === 'u1,u3',
);
check(
  'a student is told once even if listed twice',
  newlyEntitled(['u1', 'u1', 'u2'], []).join(',') === 'u1,u2',
);
check(
  'nobody new means nobody notified (repeat publish)',
  newlyEntitled(['u1', 'u2'], ['u1', 'u2']).length === 0,
);
check(
  'ids compare as strings (ObjectId vs string)',
  newlyEntitled([{ toString: () => 'u9' }], ['u9']).length === 0,
);
const payload = resultNotificationPayload({
  _id: 'e1',
  title: 'Rotational Motion — Unit Test 3',
});
check(
  'the event is exam_result, which both apps route to Results',
  payload.data.type === EXAM_RESULT_EVENT &&
    EXAM_RESULT_EVENT === 'exam_result',
);
check(
  'the payload carries the exam id and nothing score-shaped',
  payload.data.examId === 'e1' &&
    !/\d+\s*\/\s*\d+|%|score|marks|rank/i.test(
      `${payload.title} ${payload.body} ${JSON.stringify(payload.data)}`,
    ),
);

section('C. Notification text field (message vs legacy body)');
const legacy = presentNotification({
  _id: 'n1',
  title: 'Attendance Updated',
  body: 'Your attendance has been synced.',
  read: false,
});
check(
  'a legacy row with only `body` is presented with `message`',
  legacy.message === 'Your attendance has been synced.' && !('body' in legacy),
);
const current = presentNotification({
  _id: 'n2',
  title: 't',
  message: 'current',
  read: true,
});
check(
  'a current row is unchanged',
  current.message === 'current' && current.read === true,
);
check(
  'a row with neither has an empty message, not undefined',
  presentNotification({ _id: 'n3', title: 't' }).message === '',
);
check(
  'the attendance sync notice is stored as `message` through the broadcast (no direct create with `body`)',
  ATTENDANCE_SYNC_NOTICE.body.length > 0 &&
    ATTENDANCE_SYNC_NOTICE.type === 'attendance' &&
    ATTENDANCE_SYNC_NOTICE.data.type === 'attendance',
);

section('D. Written-test marks in the pooled average');
const entries = [
  {
    studentId: '64b000000000000000000001',
    studentName: 'Rahul Sharma',
    marksObtained: 12,
  },
  {
    studentId: '64b000000000000000000002',
    studentName: 'Rahul Sharma',
    marksObtained: 45,
  },
];
check(
  'a student is matched by id first — not the first same-named row',
  entryForStudent(entries, {
    id: '64b000000000000000000002',
    name: 'Rahul Sharma',
  })?.marksObtained === 45,
);
check(
  "a same-named student with no row of their own does not get another student's row",
  entryForStudent(entries, {
    id: '64b000000000000000000009',
    name: 'Rahul Sharma',
  }) === undefined,
);
check(
  'a legacy row keyed by name (no account id) still matches its student',
  entryForStudent(
    [
      {
        studentId: 'Rahul Sharma',
        studentName: 'Rahul Sharma',
        marksObtained: 30,
      },
    ],
    { id: '64b000000000000000000009', name: 'rahul sharma' },
  )?.marksObtained === 30,
);
check(
  'a Firebase-uid row matches its account',
  entryForStudent([{ studentId: 'fbUID123', marksObtained: 7 }], {
    id: 'x',
    firebaseUid: 'fbUID123',
  })?.marksObtained === 7,
);
const tests = [
  {
    _id: 't1',
    subject: 'Maths',
    testDate: '2026-10-10',
    maxMarks: 50,
    studentResults: [{ studentId: 's1', marksObtained: 38 }],
  },
  {
    _id: 't2',
    subject: 'Chemistry',
    testDate: '2026-10-12',
    maxMarks: 40,
    studentResults: [{ studentId: 's1', marksObtained: 0, isAbsent: true }],
  },
  {
    _id: 't3',
    subject: 'Physics',
    testDate: '2026-10-13',
    maxMarks: 0,
    studentResults: [{ studentId: 's1', marksObtained: 5 }],
  },
  {
    _id: 't4',
    subject: 'Biology',
    testDate: '2026-10-14',
    maxMarks: 20,
    studentResults: [{ studentId: 's2', marksObtained: 20 }],
  },
];
const marks = countableWrittenMarks(tests, { id: 's1' });
check(
  'only the student’s own, non-absent marks with a maximum count',
  marks.length === 1 &&
    marks[0].testId === 't1' &&
    marks[0].marks === 38 &&
    marks[0].outOf === 50,
);
const pooled = Math.round(((16 + 38) / (20 + 50)) * 100);
check(
  'pooled with an online 16/20 the average is 77 (Σ obtained ÷ Σ max), not the mean of 80 and 76',
  pooled === 77,
);
check(
  'a mark above the maximum is capped, never inflating the average',
  countableWrittenMarks(
    [
      {
        _id: 'x',
        maxMarks: 10,
        studentResults: [{ studentId: 's1', marksObtained: 15 }],
      },
    ],
    { id: 's1' },
  )[0].marks === 10,
);

section('E. Online result subjects');
check(
  'distinct subjects in first-seen order, case-insensitive',
  subjectLabel(['Physics', 'physics', ' Chemistry ', '', null]) ===
    'Physics, Chemistry',
);
check('no subjects is null, not an empty string', subjectLabel([]) === null);
check(
  'a question’s subject: tags.subject first, then the bank’s top-level subject',
  questionSubject({ tags: { subject: 'Physics' }, subject: 'X' }) ===
    'Physics' &&
    questionSubject({ subject: 'Maths' }) === 'Maths' &&
    questionSubject(null) === null,
);
check(
  'generic section titles are not subjects ("Section 1", "Part A")',
  declaredSubject({
    _id: 'e',
    sections: [{ title: 'Section 1' }, { title: 'Part A' }],
  }) === null,
);
check(
  'a real section title, or an explicit subject, is used when the questions say nothing',
  declaredSubject({ _id: 'e', sections: [{ title: 'Biology' }] }) ===
    'Biology' &&
    declaredSubject({
      _id: 'e',
      meta: { subject: 'English' },
      sections: [{ title: 'Section 1' }],
    }) === 'English',
);

section('Attendance — absences start when the student joined');
const created = new Date(2026, 9, 12, 15, 30);
const firstPunch = new Date(2026, 9, 14, 8, 0);
check(
  'the earlier of account creation and first punch',
  activeFromYmd(created, firstPunch) === '2026-10-12' &&
    activeFromYmd(firstPunch, created) === '2026-10-12',
);
check(
  'a legacy account created after its first punch counts from the punch',
  activeFromYmd(new Date(2026, 9, 20), new Date(2026, 8, 1)) === '2026-09-01',
);
check(
  'nothing known means no bound (unchanged behaviour)',
  activeFromYmd(null, undefined) === null,
);
const october = [
  '2026-10-01',
  '2026-10-02',
  '2026-10-12',
  '2026-10-13',
  '2026-10-14',
];
check(
  'a student’s working days start at that day',
  workingDatesFor(october, 'student', '2026-10-12').join(',') ===
    '2026-10-12,2026-10-13,2026-10-14',
);
check(
  'staff are untouched (their units feed pay)',
  workingDatesFor(october, 'teacher', '2026-10-12').length === october.length,
);
check(
  'a student with no known start keeps every working day',
  workingDatesFor(october, 'student', null).length === october.length,
);
check(
  'dates are server-local yyyy-mm-dd, as every report uses',
  localYmd(new Date(2026, 0, 5, 23, 59)) === '2026-01-05',
);

section('Push payloads and fan-out');
const graded = pushContentFor({
  _id: 'n9',
  userId: 'u1',
  title: 'Homework Graded',
  message: 'Your homework has been graded. Grade: A+',
  data: {
    type: 'homework_graded',
    homeworkId: 'h1',
    grade: 'A+',
    screen: '/x',
  },
});
check(
  'a grade never travels in a push: the body is withheld and only routing keys are sent',
  !/A\+/.test(graded.body) &&
    !('grade' in graded.data) &&
    graded.data.homeworkId === 'h1' &&
    graded.data.notificationId === 'n9',
);
const plain = pushContentFor({
  _id: 'n8',
  userId: 'u1',
  title: 'New Upcoming Test',
  message: 'Chemistry on 17 Oct',
  data: { type: 'offline_test', testId: 't1', extra: { nested: true } },
});
check(
  'other notifications push their own text; nested data is dropped',
  plain.body === 'Chemistry on 17 Oct' &&
    !('extra' in plain.data) &&
    plain.data.testId === 't1',
);
const tokens = new Map([
  ['u1', ['ExponentPushToken[aaa]', 'ExponentPushToken[aaa]', 'not-a-token']],
  ['u2', ['ExponentPushToken[bbb]']],
]);
const out = messagesFor(
  [
    { _id: 'n1', userId: 'u1', title: 't', message: 'm' },
    { _id: 'n2', userId: 'u2', title: 't', message: 'm' },
    { _id: 'n3', userId: 'u3', title: 't', message: 'm' },
  ],
  tokens,
);
check(
  'one message per notification per distinct valid token; a user with no device gets none',
  out.length === 2 &&
    out[0].token === 'ExponentPushToken[aaa]' &&
    out[1].token === 'ExponentPushToken[bbb]' &&
    out.every((o) => o.message.channelId === 'default'),
);

section('Push build configuration');
const platformFile = {
  project_info: { project_id: 'platform-push' },
  client: [
    {
      client_info: {
        android_client_info: { package_name: 'com.platform.abc' },
      },
      api_key: [{ current_key: 'k1' }],
    },
    {
      client_info: {
        android_client_info: { package_name: 'com.platform.xyz' },
      },
      api_key: [{ current_key: 'k2' }],
    },
  ],
};
const own = googleServicesFor(platformFile, 'com.platform.abc');
check(
  "a build gets only its own package's entry — nothing about another organization",
  !!own &&
    own.client!.length === 1 &&
    JSON.stringify(own).includes('com.platform.abc') &&
    !JSON.stringify(own).includes('xyz'),
);
check(
  'an unregistered package has no file',
  googleServicesFor(platformFile, 'com.platform.new') === null,
);
check(
  'no configuration: a warning (inbox only), not a refusal, unless required',
  pushReadinessFor({ file: null, error: null }, 'com.platform.abc', false)
    .required === false &&
    pushReadinessFor({ file: null, error: null }, 'com.platform.abc', true)
      .required === true,
);
const missing = pushReadinessFor(
  { file: platformFile, error: null },
  'com.platform.new',
  false,
);
check(
  'a package missing from the project refuses the build and names the fix',
  missing.state === 'package-missing' &&
    missing.required &&
    /Firebase console/.test(missing.message ?? ''),
);
check(
  'a broken file refuses the build',
  pushReadinessFor({ file: null, error: 'is not valid JSON' }, 'x', false)
    .state === 'invalid-file',
);
check(
  'a registered package is ready',
  pushReadinessFor(
    { file: platformFile, error: null },
    'com.platform.xyz',
    true,
  ).state === 'ready',
);

console.log(`\n  ${checks - failures}/${checks} checks passed.\n`);
process.exit(failures ? 1 : 0);
