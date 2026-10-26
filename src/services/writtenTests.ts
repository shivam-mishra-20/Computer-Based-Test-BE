/**
 * Written (pen-and-paper) tests — which ones a student can see, and which
 * entry in a test is theirs. Shared by the student's own results
 * (/api/offline-results/student), the upcoming-tests list, and the analytics
 * that feed a parent's average, so all three answer the same question the
 * same way.
 */

import mongoose from 'mongoose';

// Build the assignment-aware $or that matches every TestResult a given student
// should see. A test is visible when the student's CLASS matches AND, if the
// test specifies a BATCH (its `batch` field or `assignedBatches`), the student's
// batch matches too. Individually-assigned tests bypass class/batch. This also
// covers legacy tests (no assignmentType) and tests created before the
// assignment fields existed, which carry their scope on `class`/`batch`.
export function buildStudentTestMatch(user: {
  id?: string;
  classLevel?: string;
  batch?: string;
}): any[] {
  const rawClass = String(user.classLevel || '').trim();
  const classNum = rawClass.replace(/^Class\s*/i, '').trim();
  const classVariants = [classNum, `Class ${classNum}`, rawClass].filter(
    (v) => v && v !== 'Class',
  );
  const userBatch = (user.batch || '').trim();

  // Class scope: the test's own `class` OR an explicit `assignedClasses` entry.
  const classMatch = {
    $or: [
      { class: { $in: classVariants } },
      { assignedClasses: { $in: classVariants } },
    ],
  };

  // A test is NOT batch-restricted when it has no specific `batch` and no
  // `assignedBatches` ("" / "all" / "All Batches" == whole class).
  const noBatchRestriction = {
    $and: [
      {
        $or: [
          { batch: { $in: [null, ''] } },
          { batch: { $exists: false } },
          { batch: { $regex: /^all(\s*batches)?$/i } },
        ],
      },
      {
        $or: [
          { assignedBatches: { $exists: false } },
          { assignedBatches: { $size: 0 } },
        ],
      },
    ],
  };

  const or: any[] = [];

  // Individually-assigned tests are always visible to the named student.
  if (user.id && mongoose.Types.ObjectId.isValid(user.id)) {
    or.push({
      assignmentType: 'students',
      assignedStudents: new mongoose.Types.ObjectId(user.id),
    });
  }

  // Whole-class tests: class matches and the test imposes no batch restriction.
  or.push({
    $and: [
      { assignmentType: { $ne: 'students' } },
      classMatch,
      noBatchRestriction,
    ],
  });

  // Batch-restricted tests: class matches AND the student's batch is targeted.
  if (userBatch) {
    or.push({
      $and: [
        { assignmentType: { $ne: 'students' } },
        classMatch,
        { $or: [{ batch: userBatch }, { assignedBatches: userBatch }] },
      ],
    });
  }

  return or;
}

/** The parts of a test entry the matching reads. */
export interface WrittenEntry {
  studentId?: string | null;
  studentName?: string | null;
  marksObtained?: number | null;
  isAbsent?: boolean | null;
}

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * This student's entry in a test, or undefined.
 *
 * By id first — the account id, or the Firebase uid older rows were keyed by.
 * A NAME is used only as a last resort, and only for an entry whose studentId
 * cannot be anybody else's account id: two students with the same name in one
 * class used to match each other's row (the first one found won), so one could
 * read the other's marks.
 */
export function entryForStudent<T extends WrittenEntry>(
  entries: readonly T[] | null | undefined,
  student: {
    id?: string | null;
    firebaseUid?: string | null;
    name?: string | null;
  },
): T | undefined {
  const list = entries ?? [];
  const ids = new Set(
    [student.id, student.firebaseUid]
      .map((v) => String(v ?? '').trim())
      .filter(Boolean),
  );
  const byId = list.find((r) => ids.has(String(r?.studentId ?? '').trim()));
  if (byId) return byId;
  const name = String(student.name ?? '')
    .trim()
    .toLowerCase();
  if (!name) return undefined;
  return list.find((r) => {
    const sid = String(r?.studentId ?? '').trim();
    return (
      !OBJECT_ID.test(sid) &&
      String(r?.studentName ?? '')
        .trim()
        .toLowerCase() === name
    );
  });
}

/** One written-test mark that counts towards an average. */
export interface WrittenMark {
  testId: string;
  subject: string;
  testDate: string;
  marks: number;
  outOf: number;
}

/**
 * A student's written-test marks that count towards an average: an entry
 * exists for them and they were not absent (an absence has no mark — the class
 * leaderboard leaves it out the same way). Tests with no maximum are skipped;
 * they cannot be expressed as a share of anything.
 */
export function countableWrittenMarks(
  tests: ReadonlyArray<{
    _id: unknown;
    subject?: string | null;
    testDate?: string | null;
    maxMarks?: number | null;
    studentResults?: WrittenEntry[] | null;
  }>,
  student: {
    id?: string | null;
    firebaseUid?: string | null;
    name?: string | null;
  },
): WrittenMark[] {
  const out: WrittenMark[] = [];
  for (const test of tests) {
    const outOf = Number(test.maxMarks) || 0;
    if (outOf <= 0) continue;
    const entry = entryForStudent(test.studentResults ?? [], student);
    if (!entry || entry.isAbsent) continue;
    const marks = Math.max(0, Number(entry.marksObtained) || 0);
    out.push({
      testId: String(test._id),
      subject: String(test.subject ?? ''),
      testDate: String(test.testDate ?? ''),
      marks: Math.min(marks, outOf),
      outOf,
    });
  }
  return out;
}
