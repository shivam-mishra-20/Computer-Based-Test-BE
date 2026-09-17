/**
 * Regression checks for teacher activity attribution and display.
 *
 *     npx ts-node --transpile-only src/scripts/verify_teacher_activity.ts
 *
 * No database and no framework. What is pinned here is the part that is both
 * invisible and dangerous: which rows get credited to which teacher. Every
 * collection in this report records a teacher differently, and the failure
 * mode of getting it wrong is not an error message — it is a confident, empty
 * section that reads as "this teacher did nothing for their students".
 *
 * The other half is the rule that a name two teachers share identifies
 * neither. A query built on such a name returns a colleague's homework under
 * the wrong person's heading, which is the worst thing this report can do.
 */
import mongoose from 'mongoose';
import { TeacherIdentityIndex } from '../services/dailyHoursService';
import { ACTIVITY_KINDS, ACTIVITY_SOURCES, sourceFor } from '../services/teacherActivity/sources';
import { bucketOwner, filterFor, groupKeys } from '../services/teacherActivity/attribution';
import { parseKinds } from '../services/teacherActivity/loaders';

let failures = 0;
function check(name: string, actual: any, expected: any) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures += 1;
    console.log(`FAIL  ${name}\n      expected ${e}\n      actual   ${a}`);
  } else {
    console.log(`ok    ${name} = ${a}`);
  }
}

// ── Roster ──────────────────────────────────────────────────────────────────
// Two teachers named "Priya Nair" on purpose: that collision is what every
// ambiguity check below turns on.
const ARCHIT = new mongoose.Types.ObjectId().toString();
const BEENA = new mongoose.Types.ObjectId().toString();
const PRIYA_ONE = new mongoose.Types.ObjectId().toString();
const PRIYA_TWO = new mongoose.Types.ObjectId().toString();

const roster = [
  { _id: ARCHIT, name: 'Archit Sharma', firebaseUid: 'fb-archit' },
  { _id: BEENA, name: 'Beena Rao' },
  { _id: PRIYA_ONE, name: 'Priya Nair', firebaseUid: 'fb-priya-1' },
  { _id: PRIYA_TWO, name: 'Priya Nair', firebaseUid: 'fb-priya-2' },
];
const identity = new TeacherIdentityIndex(roster);

// ── aliasesFor: the inverse of resolve ──────────────────────────────────────
const architAliases = identity.aliasesFor(ARCHIT);
check('aliases: own id is included', architAliases.ids.includes(ARCHIT), true);
check('aliases: firebase uid is included', architAliases.ids.includes('fb-archit'), true);
check('aliases: name is returned raw, not lower-cased', architAliases.names, ['Archit Sharma']);

const priyaAliases = identity.aliasesFor(PRIYA_ONE);
check('aliases: a shared name is refused', priyaAliases.names, []);
check('aliases: her own id survives the collision', priyaAliases.ids.includes(PRIYA_ONE), true);
check('aliases: her own uid survives the collision', priyaAliases.ids.includes('fb-priya-1'), true);
check('aliases: the other Priya is not hers', priyaAliases.ids.includes('fb-priya-2'), false);
check('aliases: an unknown teacher has none', identity.aliasesFor('nope'), { ids: [], names: [] });

// ── filterFor: objectId attribution ─────────────────────────────────────────
const byObjectId = filterFor({ style: 'objectId', field: 'createdBy' }, ARCHIT, identity) as any;
check('objectId: filters on the right field', Object.keys(byObjectId), ['createdBy']);
check('objectId: casts to an ObjectId', byObjectId.createdBy instanceof mongoose.Types.ObjectId, true);
check('objectId: keeps the id intact', String(byObjectId.createdBy), ARCHIT);
check(
  'objectId: an unusable id yields no filter rather than a wide one',
  filterFor({ style: 'objectId', field: 'createdBy' }, 'not-an-id', identity),
  null
);

// ── filterFor: id-stored-as-string attribution ──────────────────────────────
const byString = filterFor({ style: 'idString', field: 'createdBy' }, ARCHIT, identity) as any;
check('idString: offers both spellings', byString.$or.length, 2);
check('idString: the string spelling is first', byString.$or[0].createdBy, ARCHIT);
check(
  'idString: the ObjectId spelling is also offered',
  byString.$or[1].createdBy instanceof mongoose.Types.ObjectId,
  true
);

// ── filterFor: alias attribution ────────────────────────────────────────────
const byAlias = filterFor(
  { style: 'alias', field: 'teacherId', nameField: 'teacherName' },
  ARCHIT,
  identity
) as any;
const aliasIdClause = byAlias.$or.find((clause: any) => clause.teacherId?.$in);
const aliasIdValues = aliasIdClause.teacherId.$in.map(String);
check('alias: matches on the id', aliasIdValues.includes(ARCHIT), true);
check('alias: matches on the firebase uid', aliasIdValues.includes('fb-archit'), true);

const nameClauses = byAlias.$or.filter((clause: any) =>
  (clause.teacherId?.$in || clause.teacherName?.$in || []).some((v: any) => v instanceof RegExp)
);
check('alias: the name is matched on both fields', nameClauses.length, 2);
const namePattern = (nameClauses[0].teacherId?.$in || nameClauses[0].teacherName?.$in)[0];
check('alias: the name match is anchored', namePattern.source, '^Archit Sharma$');
check('alias: the name match ignores case', namePattern.flags.includes('i'), true);
check('alias: an anchored pattern does not match a longer name', namePattern.test('Archit Sharman'), false);
check('alias: it does match a different casing', namePattern.test('archit sharma'), true);

// A teacher whose ONLY distinguishing mark is a shared name must not produce a
// filter that matches her namesake's rows.
const priyaAlias = filterFor(
  { style: 'alias', field: 'teacherId', nameField: 'teacherName' },
  PRIYA_ONE,
  identity
) as any;
const priyaHasName = priyaAlias.$or.some((clause: any) =>
  (clause.teacherId?.$in || clause.teacherName?.$in || []).some((v: any) => v instanceof RegExp)
);
check('alias: a shared name is never queried on', priyaHasName, false);
check('alias: her unambiguous ids are still queried on', priyaAlias.$or.length, 1);

// A name containing regex punctuation must be escaped, not interpreted.
const trickyIdentity = new TeacherIdentityIndex([
  { _id: BEENA, name: 'R. K. Singh (Sr.)' },
]);
const tricky = filterFor(
  { style: 'alias', field: 'teacherId' },
  BEENA,
  trickyIdentity
) as any;
const trickyPattern = tricky.$or.find((c: any) =>
  (c.teacherId?.$in || []).some((v: any) => v instanceof RegExp)
).teacherId.$in.find((v: any) => v instanceof RegExp);
check('alias: regex characters in a name are escaped', trickyPattern.test('R. K. Singh (Sr.)'), true);
check('alias: the escaped name is not a wildcard', trickyPattern.test('RXKX Singh (SrX)'), false);

// ── groupKeys: what a summary aggregation groups by ─────────────────────────
check('groupKeys: objectId needs only the id', groupKeys({ style: 'objectId', field: 'createdBy' }), {
  id: 'createdBy',
  name: null,
});
check(
  'groupKeys: alias also groups by the name, as a second chance',
  groupKeys({ style: 'alias', field: 'teacherId', nameField: 'teacherName' }),
  { id: 'teacherId', name: 'teacherName' }
);

// ── bucketOwner: attributing a grouped count ────────────────────────────────
check('bucket: by id', bucketOwner({ rawId: ARCHIT }, identity), ARCHIT);
check('bucket: by firebase uid', bucketOwner({ rawId: 'fb-archit' }, identity), ARCHIT);
check('bucket: by a name in the id field', bucketOwner({ rawId: 'Archit Sharma' }, identity), ARCHIT);
check('bucket: by the name field when the id is unknown', bucketOwner({ rawId: 'x', rawName: 'Beena Rao' }, identity), BEENA);
check('bucket: a shared name is credited to nobody', bucketOwner({ rawId: '', rawName: 'Priya Nair' }, identity), null);
check('bucket: an unknown id is credited to nobody', bucketOwner({ rawId: 'ghost' }, identity), null);
check('bucket: a null id does not throw', bucketOwner({ rawId: null }, identity), null);
check('bucket: an absent bucket does not throw', bucketOwner({}, identity), null);

// ── The registry ────────────────────────────────────────────────────────────
check('registry: every kind is unique', new Set(ACTIVITY_KINDS).size, ACTIVITY_KINDS.length);
check('registry: syllabus ignores the date range on purpose', sourceFor('syllabus')!.rangeMode, 'always');
check('registry: class tests filter on a YYYY-MM-DD string', sourceFor('offlineTest')!.dateKind, 'ymd');
check('registry: class tests are attributed by a string id', sourceFor('offlineTest')!.attribution.style, 'idString');
check('registry: syllabus is attributed by alias', sourceFor('syllabus')!.attribution.style, 'alias');
check('registry: material is attributed by who uploaded it', sourceFor('material')!.attribution.field, 'uploadedBy');
check('registry: an unknown kind is not invented', sourceFor('nonsense'), undefined);

for (const source of ACTIVITY_SOURCES) {
  // The projection has to include the field the section is dated by, or every
  // item comes back with a null date and the list cannot be ordered.
  check(
    `registry: ${source.kind} selects the field it is dated by`,
    source.select.split(/\s+/).includes(source.dateField),
    true
  );
}

// ── parseKinds: query-string narrowing ──────────────────────────────────────
check('kinds: a known list passes through', parseKinds('homework,material'), ['homework', 'material']);
check('kinds: unknown names are dropped, not trusted', parseKinds('homework,wingspan'), ['homework']);
check('kinds: empty means all of them', parseKinds(''), []);
check('kinds: whitespace is tolerated', parseKinds(' homework , syllabus '), ['homework', 'syllabus']);

// ── toItem: the display mapping ─────────────────────────────────────────────
const homework = sourceFor('homework')!.toItem({
  _id: 'h1',
  title: 'Trigonometry sheet 3',
  subject: 'Maths',
  classLevel: '11',
  status: 'published',
  dueDate: new Date(2026, 8, 20),
  maxPoints: 20,
  attachments: [{}, {}],
  assignmentType: 'batch',
  assignedBatches: ['Lakshya', 'Aadharshila'],
  allowLateSubmission: true,
  createdAt: new Date(2026, 8, 15),
});
check('homework: title', homework.title, 'Trigonometry sheet 3');
check('homework: subtitle joins subject and class', homework.subtitle, 'Maths · Class 11');
check('homework: date is local YYYY-MM-DD', homework.date, '2026-09-15');
check('homework: status is sentence case', homework.status, 'Published');
check('homework: audience names the batches', homework.meta['Given to'], 'Batches: Lakshya, Aadharshila');
check('homework: attachments are counted', homework.meta.Files, 2);

const test = sourceFor('offlineTest')!.toItem({
  _id: 't1',
  testName: 'Unit test 2',
  testDate: '2026-09-11',
  class: '10',
  subject: 'Science',
  maxMarks: 25,
  studentResults: [
    { percentage: 80 },
    { percentage: 60 },
    { percentage: 0, isAbsent: true },
  ],
});
check('test: a YYYY-MM-DD string is passed through unchanged', test.date, '2026-09-11');
check('test: absentees are excluded from the average', test.meta['Class average'], '70%');
check('test: absentees are excluded from the marked count', test.meta['Students marked'], 2);

const emptyTest = sourceFor('offlineTest')!.toItem({
  _id: 't2',
  testName: 'Unit test 3',
  testDate: '2026-09-12',
  class: '10',
  subject: 'Science',
  studentResults: [],
});
check('test: no marks does not divide by zero', emptyTest.meta['Class average'], 'No marks yet');
check('test: no marks is said plainly', emptyTest.status, 'No marks yet');

const syllabus = sourceFor('syllabus')!.toItem({
  _id: 's1',
  subject: 'Physics',
  classLevel: '12',
  batch: 'Lakshya',
  academicYear: '2026-27',
  totalTopics: 40,
  completedTopics: 18,
  progressPercentage: 45,
  chapters: [
    { name: 'Optics', topics: [{ completed: true }, { completed: true }] },
    { name: 'Modern', topics: [{ completed: true }, { completed: false }] },
    { name: 'Empty', topics: [] },
  ],
  updatedAt: new Date(2026, 8, 14),
});
check('syllabus: title names the subject and class', syllabus.title, 'Physics · Class 12 · Lakshya');
check('syllabus: progress is stated as a percentage', syllabus.status, '45% done');
check('syllabus: topics are counted', syllabus.meta['Topics done'], '18 of 40');
check('syllabus: a chapter with no topics is not "finished"', syllabus.meta['Chapters finished'], '1 of 3');
check('syllabus: progress is also a number, for a bar', syllabus.meta.progressPercentage, 45);

const exam = sourceFor('onlineExam')!.toItem({
  _id: 'e1',
  title: 'Mid-term',
  mode: 'live',
  sections: [{ questionIds: [1, 2, 3] }, { questionIds: [4, 5] }],
  totalDurationMins: 90,
  isPublished: false,
});
check('exam: questions come from questionIds', exam.meta.Questions, 5);
check('exam: sections are counted', exam.meta.Sections, 2);
check('exam: an unpublished exam says so plainly', exam.status, 'Not given out yet');

const material = sourceFor('material')!.toItem({
  _id: 'm1',
  title: 'Wave optics notes',
  subject: 'Physics',
  classLevel: '12',
  chapter: 'Optics',
  type: 'pdf',
  isPublished: true,
  downloadCount: 31,
  version: 2,
  fileSize: 2_400_000,
  assignmentType: 'all',
  createdAt: new Date(2026, 8, 9),
});
check('material: subtitle includes the chapter', material.subtitle, 'Physics · Class 12 · Optics');
check('material: size is human readable', material.meta.Size, '2344 KB');
check('material: everyone is named plainly', material.meta['Shared with'], 'Everyone');

const doubt = sourceFor('doubt')!.toItem({
  _id: 'd1',
  subject: 'Maths',
  classLevel: '11',
  question: 'x'.repeat(200),
  status: 'in-progress',
  messages: [
    { senderRole: 'student' },
    { senderRole: 'teacher' },
    { senderRole: 'teacher' },
  ],
  createdAt: new Date(2026, 8, 1),
  updatedAt: new Date(2026, 8, 13),
});
check('doubt: a long question is trimmed', doubt.title.length, 91);
check('doubt: an enum reads as English', doubt.status, 'In progress');
check('doubt: only the teacher replies are counted', doubt.meta['Replies from teacher'], 2);
check('doubt: an unanswered doubt says so', doubt.meta['First answered'], 'Not answered yet');

const notice = sourceFor('announcement')!.toItem({
  _id: 'n1',
  title: 'Holiday on Friday',
  content: 'The institute will remain closed.',
  priority: 'high',
  target: 'class',
  targetClass: '10',
  isPublished: true,
  createdAt: new Date(2026, 8, 3),
});
check('notice: the audience names the class', notice.meta['Shown to'], 'Class 10');
check('notice: no expiry is said plainly', notice.meta.Expires, 'No end date');

// ── Missing fields must degrade, never throw ────────────────────────────────
for (const source of ACTIVITY_SOURCES) {
  try {
    const bare = source.toItem({ _id: 'bare' });
    check(`${source.kind}: an empty document still yields an id`, bare.id, 'bare');
    check(`${source.kind}: an empty document still yields a title`, typeof bare.title, 'string');
    check(`${source.kind}: an empty document has a non-empty title`, bare.title.length > 0, true);
  } catch (error: any) {
    failures += 1;
    console.log(`FAIL  ${source.kind}: an empty document threw — ${error.message}`);
  }
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
