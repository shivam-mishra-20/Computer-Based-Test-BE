/**
 * Everything a teacher makes for students, declared once.
 *
 * One entry per kind. The loader knows nothing about homework or syllabi — it
 * walks this list. Adding a ninth kind is an entry here and nothing else: no
 * new query, no new branch in the loader, no new field in the response, no
 * client change beyond a label.
 *
 * ── Two things every entry has to get right ─────────────────────────────────
 * 1. `attribution` must match how that collection actually records a teacher.
 *    Guessing produces an empty section that looks like "this teacher did
 *    nothing", which is the most damaging wrong answer this report can give.
 * 2. `dateKind` must match the stored type. `TestResult.testDate` is a
 *    "YYYY-MM-DD" string; comparing it against a Date matches nothing at all
 *    and, again, reads as "did nothing".
 */

import type { ActivityItem, ActivitySource } from './types';

/** "Physics · Class 11 · Lakshya", skipping whatever is missing. */
function describe(parts: Array<string | number | null | undefined>): string {
  return parts
    .map((part) => (part === null || part === undefined ? '' : String(part).trim()))
    .filter(Boolean)
    .join(' · ');
}

/** Local YYYY-MM-DD, matching how the rest of this report reads a "day". */
function ymd(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Sentence case for a stored enum: "in-progress" → "In progress". */
function readable(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const spaced = text.replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** Who a piece of work was given to, in words rather than enum names. */
function audience(doc: {
  assignmentType?: string;
  assignedClasses?: string[];
  assignedBatches?: string[];
  assignedStudents?: unknown[];
  classLevel?: string;
  batch?: string;
}): string {
  const classes = doc.assignedClasses || [];
  const batches = doc.assignedBatches || [];
  const students = doc.assignedStudents || [];

  switch (doc.assignmentType) {
    case 'all':
      return 'Everyone';
    case 'students':
      return `${students.length} chosen ${students.length === 1 ? 'student' : 'students'}`;
    case 'batch':
      return batches.length > 0 ? `Batches: ${batches.join(', ')}` : 'Chosen batches';
    case 'class':
    case 'class_batch':
      return classes.length > 0 ? `Classes: ${classes.join(', ')}` : 'Chosen classes';
    default:
      // Rows written before targeting existed behave as "this class".
      return describe([doc.classLevel ? `Class ${doc.classLevel}` : null, doc.batch]) || 'Not set';
  }
}

export const ACTIVITY_SOURCES: ActivitySource[] = [
  /* ── Homework ──────────────────────────────────────────────────────────── */
  {
    kind: 'homework',
    label: 'Homework given',
    noun: { one: 'homework task', many: 'homework tasks' },
    model: 'Homework',
    attribution: { style: 'objectId', field: 'createdBy' },
    dateField: 'createdAt',
    dateKind: 'date',
    rangeMode: 'window',
    select:
      'title subject classLevel status dueDate maxPoints attachments assignmentType assignedClasses assignedBatches assignedStudents allowLateSubmission createdAt',
    sort: { createdAt: -1 },
    toItem: (doc): ActivityItem => ({
      id: String(doc._id),
      kind: 'homework',
      title: doc.title || 'Untitled homework',
      subtitle: describe([doc.subject, doc.classLevel ? `Class ${doc.classLevel}` : null]),
      date: ymd(doc.createdAt),
      status: readable(doc.status),
      meta: {
        'Given to': audience(doc),
        'Due date': ymd(doc.dueDate) || 'No due date',
        Marks: doc.maxPoints ?? 'Not set',
        Files: Array.isArray(doc.attachments) ? doc.attachments.length : 0,
        'Late allowed': doc.allowLateSubmission ? 'Yes' : 'No',
      },
    }),
  },

  /* ── Study material ────────────────────────────────────────────────────── */
  {
    kind: 'material',
    label: 'Study material uploaded',
    noun: { one: 'file', many: 'files' },
    model: 'Material',
    attribution: { style: 'objectId', field: 'uploadedBy' },
    dateField: 'createdAt',
    dateKind: 'date',
    rangeMode: 'window',
    select:
      'title subject classLevel chapter type isPublished downloadCount version fileName fileSize assignmentType assignedClasses assignedBatches assignedStudents createdAt',
    sort: { createdAt: -1 },
    toItem: (doc): ActivityItem => ({
      id: String(doc._id),
      kind: 'material',
      title: doc.title || doc.fileName || 'Untitled file',
      subtitle: describe([
        doc.subject,
        doc.classLevel ? `Class ${doc.classLevel}` : null,
        doc.chapter,
      ]),
      date: ymd(doc.createdAt),
      status: doc.isPublished ? 'Published' : 'Not published',
      meta: {
        Type: readable(doc.type) || 'File',
        'Shared with': audience(doc),
        Downloads: doc.downloadCount ?? 0,
        Version: doc.version ?? 1,
        Size: typeof doc.fileSize === 'number' ? `${Math.max(1, Math.round(doc.fileSize / 1024))} KB` : 'Unknown',
      },
    }),
  },

  /* ── Syllabus ──────────────────────────────────────────────────────────── */
  {
    kind: 'syllabus',
    label: 'Syllabus progress',
    noun: { one: 'subject plan', many: 'subject plans' },
    model: 'Syllabus',
    // Written before the teacher picker existed, so the id may be an _id, a
    // Firebase uid or a name. `teacherName` is carried as a second chance.
    attribution: { style: 'alias', field: 'teacherId', nameField: 'teacherName' },
    dateField: 'updatedAt',
    dateKind: 'date',
    // A syllabus is a living record, not an event. Limiting it to the selected
    // month would hide the progress of a subject the teacher simply did not
    // edit in those weeks — the opposite of what the reader wants to know.
    rangeMode: 'always',
    select:
      'subject classLevel batch academicYear totalTopics completedTopics progressPercentage chapters isActive updatedAt',
    sort: { progressPercentage: 1 },
    baseFilter: { isActive: true },
    toItem: (doc): ActivityItem => {
      const chapters = Array.isArray(doc.chapters) ? doc.chapters : [];
      const chaptersDone = chapters.filter(
        (chapter: any) =>
          Array.isArray(chapter?.topics) &&
          chapter.topics.length > 0 &&
          chapter.topics.every((topic: any) => topic?.completed)
      ).length;

      return {
        id: String(doc._id),
        kind: 'syllabus',
        // A syllabus is titled by what it covers rather than by a name field,
        // so a row missing all three parts would otherwise render as a blank
        // line the reader cannot click on or ask about.
        title:
          describe([doc.subject, doc.classLevel ? `Class ${doc.classLevel}` : null, doc.batch]) ||
          'Subject not named',
        subtitle: doc.academicYear ? `Academic year ${doc.academicYear}` : '',
        date: ymd(doc.updatedAt),
        status: `${doc.progressPercentage ?? 0}% done`,
        meta: {
          'Topics done': `${doc.completedTopics ?? 0} of ${doc.totalTopics ?? 0}`,
          'Chapters finished': `${chaptersDone} of ${chapters.length}`,
          'Last updated': ymd(doc.updatedAt) || 'Never',
          // Kept as a number as well as in the text above, so the client can
          // draw a bar without parsing a sentence.
          progressPercentage: doc.progressPercentage ?? 0,
        },
      };
    },
  },

  /* ── Offline tests ─────────────────────────────────────────────────────── */
  {
    kind: 'offlineTest',
    label: 'Class tests set',
    noun: { one: 'test', many: 'tests' },
    model: 'TestResult',
    // Declared as a String on the model, so it is matched as one.
    attribution: { style: 'idString', field: 'createdBy' },
    // A "YYYY-MM-DD" string, not a Date. See the note at the top of this file.
    dateField: 'testDate',
    dateKind: 'ymd',
    rangeMode: 'window',
    select:
      'testName testDate class batch subject maxMarks studentResults assignmentType assignedClasses assignedBatches assignedStudents createdAt',
    sort: { testDate: -1 },
    toItem: (doc): ActivityItem => {
      const results = Array.isArray(doc.studentResults) ? doc.studentResults : [];
      const marked = results.filter((r: any) => !r?.isAbsent).length;
      const average =
        marked > 0
          ? Math.round(
              results
                .filter((r: any) => !r?.isAbsent)
                .reduce((sum: number, r: any) => sum + (Number(r?.percentage) || 0), 0) / marked
            )
          : null;

      return {
        id: String(doc._id),
        kind: 'offlineTest',
        title: doc.testName || 'Untitled test',
        subtitle: describe([doc.subject, doc.class ? `Class ${doc.class}` : null, doc.batch]),
        date: ymd(doc.testDate),
        status: results.length > 0 ? 'Marks entered' : 'No marks yet',
        meta: {
          'Given to': audience({ ...doc, classLevel: doc.class }),
          'Total marks': doc.maxMarks ?? 'Not set',
          'Students marked': marked,
          'Class average': average === null ? 'No marks yet' : `${average}%`,
        },
      };
    },
  },

  /* ── Online exams ──────────────────────────────────────────────────────── */
  {
    kind: 'onlineExam',
    label: 'Online exams made',
    noun: { one: 'exam', many: 'exams' },
    model: 'Exam',
    attribution: { style: 'objectId', field: 'createdBy' },
    dateField: 'createdAt',
    dateKind: 'date',
    rangeMode: 'window',
    select:
      'title description mode sections totalDurationMins schedule classLevel batch isPublished antiCheat createdAt',
    sort: { createdAt: -1 },
    toItem: (doc): ActivityItem => {
      const sections = Array.isArray(doc.sections) ? doc.sections : [];
      // Sections carry `questionIds`, not embedded questions — counting the
      // wrong field reports every exam as empty.
      const questions = sections.reduce(
        (sum: number, section: any) =>
          sum + (Array.isArray(section?.questionIds) ? section.questionIds.length : 0),
        0
      );

      return {
        id: String(doc._id),
        kind: 'onlineExam',
        title: doc.title || 'Untitled exam',
        subtitle: describe([
          readable(doc.mode) || 'Exam',
          doc.classLevel,
          doc.batch,
        ]),
        date: ymd(doc.createdAt),
        status: doc.isPublished ? 'Given to students' : 'Not given out yet',
        meta: {
          Questions: questions,
          Sections: sections.length,
          Length: doc.totalDurationMins ? `${doc.totalDurationMins} min` : 'Not set',
          Starts: ymd(doc.schedule?.startAt) || 'Not scheduled',
          'Exam watch': doc.antiCheat ? 'On' : 'Off',
        },
      };
    },
  },

  /* ── Doubts ────────────────────────────────────────────────────────────── */
  {
    kind: 'doubt',
    label: 'Student doubts handled',
    noun: { one: 'doubt', many: 'doubts' },
    model: 'Doubt',
    attribution: { style: 'objectId', field: 'teacher' },
    // When the thread last moved. A doubt raised in March and answered in
    // September belongs to September's report, which is when the work happened.
    dateField: 'updatedAt',
    dateKind: 'date',
    rangeMode: 'window',
    select: 'subject topic classLevel batch question status priority messages repliedAt updatedAt createdAt',
    sort: { updatedAt: -1 },
    toItem: (doc): ActivityItem => {
      const messages = Array.isArray(doc.messages) ? doc.messages : [];
      const replies = messages.filter((m: any) => m?.senderRole === 'teacher').length;
      const question = String(doc.question || '').trim();

      return {
        id: String(doc._id),
        kind: 'doubt',
        title: question.length > 90 ? `${question.slice(0, 90)}…` : question || 'Doubt',
        subtitle: describe([
          doc.subject,
          doc.classLevel ? `Class ${doc.classLevel}` : null,
          doc.batch,
          doc.topic,
        ]),
        date: ymd(doc.updatedAt),
        status: readable(doc.status),
        meta: {
          'Replies from teacher': replies,
          'Asked on': ymd(doc.createdAt) || 'Unknown',
          'First answered': ymd(doc.repliedAt) || 'Not answered yet',
          Priority: readable(doc.priority) || 'Normal',
        },
      };
    },
  },

  /* ── Announcements ─────────────────────────────────────────────────────── */
  {
    kind: 'announcement',
    label: 'Notices posted',
    noun: { one: 'notice', many: 'notices' },
    model: 'Announcement',
    attribution: { style: 'objectId', field: 'createdBy' },
    dateField: 'createdAt',
    dateKind: 'date',
    rangeMode: 'window',
    select: 'title content priority target targetClass targetBatch isPublished expiresAt createdAt',
    sort: { createdAt: -1 },
    toItem: (doc): ActivityItem => {
      const content = String(doc.content || '').trim();
      return {
        id: String(doc._id),
        kind: 'announcement',
        title: doc.title || 'Untitled notice',
        subtitle: content.length > 120 ? `${content.slice(0, 120)}…` : content,
        date: ymd(doc.createdAt),
        status: doc.isPublished ? 'Published' : 'Not published',
        meta: {
          'Shown to':
            doc.target === 'class'
              ? `Class ${doc.targetClass || '?'}`
              : doc.target === 'batch'
                ? `Batch ${doc.targetBatch || '?'}`
                : readable(doc.target) || 'Everyone',
          Importance: readable(doc.priority) || 'Normal',
          Expires: ymd(doc.expiresAt) || 'No end date',
        },
      };
    },
  },
];

/** Every kind, in the order the report shows them. */
export const ACTIVITY_KINDS = ACTIVITY_SOURCES.map((source) => source.kind);

export function sourceFor(kind: string): ActivitySource | undefined {
  return ACTIVITY_SOURCES.find((source) => source.kind === kind);
}
