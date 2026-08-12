import { Request, Response } from 'express';
import mongoose from 'mongoose';
import TestResult, { ITestResult, IStudentResult } from '../models/TestResult';
import User from '../models/User';
import { sendStudentNotifications } from '../services/notificationService';
import { INSTITUTE_ACCOUNT_CLAUSE } from '../utils/instituteAudience';

// ── Assignment + notification helpers ────────────────────────────────────────
// These mirror the Homework module (homeworkRoutes.ts) so offline tests reuse
// the same class-normalization, student-resolution and notification fan-out.

const normalizeClassValue = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/Class\s*/i, '').trim() : '';

const buildClassVariants = (values: unknown): string[] => {
  const list = Array.isArray(values) ? values : [values];
  const variants = new Set<string>();
  list.forEach((value) => {
    if (value === null || value === undefined) return;
    const raw = String(value).trim();
    if (!raw) return;
    const normalized = normalizeClassValue(raw);
    if (normalized) {
      variants.add(normalized);
      variants.add(`Class ${normalized}`);
    }
    variants.add(raw);
  });
  return Array.from(variants);
};

const normalizeBatchList = (values: unknown): string[] => {
  const list = Array.isArray(values)
    ? values
    : typeof values === 'string'
      ? values.split(',')
      : [];
  return list.map((v) => String(v || '').trim()).filter(Boolean);
};

// Resolve the set of student User _ids a test targets — kept consistent with
// the visibility query (buildStudentTestMatch). A test targets students whose
// CLASS matches and, when the test specifies a BATCH (its `batch` field or
// `assignedBatches`), whose batch matches too. 'students' assignment targets
// the named students directly.
async function resolveTestStudentIds(test: any): Promise<string[]> {
  const assignmentType = test.assignmentType || 'class';

  if (assignmentType === 'students') {
    return (test.assignedStudents || []).map((id: any) => id.toString());
  }

  const classSource = test.assignedClasses?.length ? test.assignedClasses : [test.class];
  const classScope = buildClassVariants(classSource);
  if (classScope.length === 0) return [];

  const query: any = { role: 'student', ...INSTITUTE_ACCOUNT_CLAUSE, classLevel: { $in: classScope } };

  // Batch restriction = assignedBatches ∪ the test's own `batch`, ignoring
  // empty / "all" / "All Batches" wildcards. When present, only those batches
  // are targeted — so notifications match exactly who can see the test.
  const batchScope = normalizeBatchList([...(test.assignedBatches || []), test.batch]).filter(
    (b) => !['all', 'all batches'].includes(b.toLowerCase()),
  );
  if (batchScope.length > 0) {
    query.batch = { $in: batchScope };
  }

  const students = await User.find(query).select('_id').lean();
  return students.map((s: any) => s._id.toString());
}

const isFutureTestDate = (testDate: string): boolean => {
  const today = new Date().toISOString().split('T')[0];
  return typeof testDate === 'string' && testDate >= today;
};

const formatTestDate = (testDate: string): string => {
  const parsed = new Date(testDate);
  if (Number.isNaN(parsed.getTime())) return testDate;
  return parsed.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

// Sanitize incoming assignment fields from the request body onto a test doc.
function applyAssignmentFields(test: any, body: any): void {
  if (body.assignmentType) {
    test.assignmentType = body.assignmentType;
  }
  if (Array.isArray(body.assignedClasses)) {
    test.assignedClasses = body.assignedClasses.map((c: any) => String(c).trim()).filter(Boolean);
  }
  if (Array.isArray(body.assignedBatches)) {
    test.assignedBatches = body.assignedBatches.map((b: any) => String(b).trim()).filter(Boolean);
  }
  if (Array.isArray(body.assignedStudents)) {
    test.assignedStudents = body.assignedStudents
      .filter((id: any) => mongoose.Types.ObjectId.isValid(id))
      .map((id: any) => new mongoose.Types.ObjectId(id));
  }
}

// Send the "New Upcoming Test" notification once per test (guarded by
// notifiedUpcoming) when the test is dated today or in the future.
async function notifyUpcomingTest(test: any): Promise<void> {
  if (test.notifiedUpcoming) return;
  if (!isFutureTestDate(test.testDate)) return;

  const studentIds = await resolveTestStudentIds(test);
  if (studentIds.length === 0) return;

  const teacher = await User.findById(test.createdBy).select('name').lean().catch(() => null);
  const assignedBy = (teacher as any)?.name ? ` • By ${(teacher as any).name}` : '';

  // Fire-and-forget the push fan-out (matches the Homework module) so the
  // create/update response isn't blocked on Expo delivery.
  sendStudentNotifications(
    studentIds,
    'New Upcoming Test',
    `${test.testName} — ${test.subject} on ${formatTestDate(test.testDate)}${assignedBy}`,
    { type: 'offline_test', testId: String(test._id), screen: '/(student)/modules/results' },
    'exam'
  ).catch((err) => console.error('[TestResults] Upcoming push error:', err));

  test.notifiedUpcoming = true;
  await test.save();
}

// Create a new test
export const createTest = async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    const { testName, testDate, class: className, batch, subject, maxMarks, studentResults } = req.body;

    if (!testName || !testDate || !className || !subject || !maxMarks) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const newTest = new TestResult({
      testName,
      testDate,
      class: className,
      batch,
      subject,
      maxMarks,
      studentResults: studentResults || [],
      createdBy: authUser.id,
    });

    applyAssignmentFields(newTest, req.body);

    await newTest.save();
    console.log(`[TestResults] Created test: ${testName} for ${className}`);

    // Notify assigned students if the test is dated today/in the future.
    await notifyUpcomingTest(newTest).catch((err) =>
      console.error('[TestResults] Upcoming notification error:', err)
    );

    res.status(201).json(newTest);
  } catch (error: any) {
    console.error('[TestResults] Create error:', error);
    res.status(500).json({ message: 'Failed to create test', error: error.message });
  }
};

// Get all tests (with optional filters)
export const getAllTests = async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    const { class: className, batch, subject, search } = req.query;

    const query: any = {};
    if (authUser?.role === 'teacher') query.createdBy = authUser.id;
    if (className) query.class = className;
    if (batch) query.batch = batch;
    if (subject) query.subject = subject;
    if (search) query.testName = { $regex: search, $options: 'i' };

    const tests = await TestResult.find(query)
      .sort({ testDate: -1, createdAt: -1 })
      .lean();

    // Enrich with creator name — convert string IDs to ObjectId for the lookup
    const creatorIdStrings = [...new Set(tests.map((t: any) => t.createdBy).filter(Boolean))];
    const creatorObjectIds = creatorIdStrings
      .filter(id => mongoose.Types.ObjectId.isValid(id))
      .map(id => new mongoose.Types.ObjectId(id));
    const creators = await User.find({ _id: { $in: creatorObjectIds } }, 'name role').lean();
    const creatorMap: Record<string, { name: string; role: string }> = {};
    creators.forEach((c: any) => { creatorMap[String(c._id)] = { name: c.name, role: c.role }; });

    const enriched = tests.map((t: any) => ({
      ...t,
      createdByName: creatorMap[t.createdBy]?.name || 'Unknown',
      createdByRole: creatorMap[t.createdBy]?.role || 'teacher',
      studentCount: Array.isArray(t.studentResults) ? t.studentResults.length : 0,
      classAverage: (() => {
        const results = (t.studentResults || []).filter((r: any) => !r.isAbsent);
        if (!results.length || !t.maxMarks) return 0;
        const avg = results.reduce((s: number, r: any) => s + (r.marksObtained || 0), 0) / results.length;
        return Math.round((avg / t.maxMarks) * 100);
      })(),
      passCount: (() => {
        const results = (t.studentResults || []).filter((r: any) => !r.isAbsent);
        return results.filter((r: any) => (r.percentage || 0) >= 40).length;
      })(),
    }));

    res.json(enriched);
  } catch (error: any) {
    console.error('[TestResults] Get all error:', error);
    res.status(500).json({ message: 'Failed to fetch tests', error: error.message });
  }
};

// Get a specific test by ID
export const getTestById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const test = await TestResult.findById(id).lean();

    if (!test) {
      return res.status(404).json({ message: 'Test not found' });
    }

    res.json({
      ...test,
      studentResults: await withStudentImages(test.studentResults as any[]),
    });
  } catch (error: any) {
    console.error('[TestResults] Get by ID error:', error);
    res.status(500).json({ message: 'Failed to fetch test', error: error.message });
  }
};

/**
 * Attach each student's profile image to their result row.
 *
 * ── Why a join and not a stored field ────────────────────────────────────────
 * TestResult denormalises `studentName` at entry time, which is right for a
 * name (it is the name as recorded when the test was marked). An IMAGE is not
 * like that: a student who updates their photo should be recognisable in every
 * result immediately, and a copy taken at entry time would go stale and, worse,
 * would keep showing a face that no longer belongs to that person's account.
 *
 * ── Why it cannot mismatch ───────────────────────────────────────────────────
 * The lookup is keyed on `studentId` and written back onto the same row object.
 * A student whose account no longer exists simply gets no image — the row keeps
 * its stored name and marks rather than disappearing or inheriting a neighbour's
 * face.
 *
 * One query per test, regardless of class size.
 */
async function withStudentImages<T extends { studentId?: string }>(rows: T[]): Promise<T[]> {
  const list = Array.isArray(rows) ? rows : [];
  const ids = Array.from(
    new Set(
      list
        .map((r) => String(r?.studentId || ''))
        .filter((id) => mongoose.Types.ObjectId.isValid(id)),
    ),
  );
  if (ids.length === 0) return list;

  const users = await User.find({ _id: { $in: ids } })
    .select('_id profileImage')
    .lean();
  const imageById = new Map(users.map((u: any) => [String(u._id), u.profileImage]));

  return list.map((row) => ({
    ...row,
    profileImage: imageById.get(String(row?.studentId || '')) || undefined,
  }));
}

// Update test results (marks for students)
export const updateTestResults = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { studentResults } = req.body;

    if (!studentResults || !Array.isArray(studentResults)) {
      return res.status(400).json({ message: 'Invalid student results data' });
    }

    const test = await TestResult.findById(id);
    if (!test) {
      return res.status(404).json({ message: 'Test not found' });
    }

    // Track which students already had a graded result so we only notify each
    // student the first time their result becomes available.
    const isGraded = (r: any) => (Number(r?.marksObtained) || 0) > 0 || !!r?.isAbsent;
    const previouslyGraded = new Set(
      (test.studentResults || []).filter(isGraded).map((r: any) => String(r.studentId))
    );

    test.studentResults = studentResults;
    await test.save();

    // "New Result Available" notification for students newly graded.
    const alreadyNotified = new Set((test.resultsNotifiedStudentIds || []).map(String));
    const newlyGraded = (studentResults as any[])
      .filter(
        (r) =>
          isGraded(r) &&
          !previouslyGraded.has(String(r.studentId)) &&
          !alreadyNotified.has(String(r.studentId))
      )
      .map((r) => String(r.studentId));

    if (newlyGraded.length > 0) {
      sendStudentNotifications(
        newlyGraded,
        'New Result Available',
        `Your result for ${test.testName} (${test.subject}) is now available`,
        { type: 'offline_result', testId: String(test._id), screen: '/(student)/modules/results' },
        'exam'
      );
      test.resultsNotifiedStudentIds = [...alreadyNotified, ...newlyGraded];
      await test.save();
    }

    console.log(`[TestResults] Updated results for test: ${test.testName}`);
    res.json(test);
  } catch (error: any) {
    console.error('[TestResults] Update results error:', error);
    res.status(500).json({ message: 'Failed to update results', error: error.message });
  }
};

// Update test properties (name, date, maxMarks, class, subject)
export const updateTestProperties = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { testName, testDate, class: className, batch, subject, maxMarks } = req.body;

    if (!testName || !testDate || !className || !subject || !maxMarks) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const test = await TestResult.findById(id);
    if (!test) {
      return res.status(404).json({ message: 'Test not found' });
    }

    // If maxMarks changed, we should recalculate percentages for existing students
    const maxMarksChanged = test.maxMarks !== maxMarks;

    test.testName = testName;
    test.testDate = testDate;
    test.class = className;
    test.batch = batch;
    test.subject = subject;
    test.maxMarks = maxMarks;

    applyAssignmentFields(test, req.body);

    if (maxMarksChanged && test.studentResults && test.studentResults.length > 0) {
      test.studentResults = test.studentResults.map((result) => {
        if (result.isAbsent) {
          return { ...result, marksObtained: 0, percentage: 0, grade: 'AB' };
        }
        const percentage = Math.round((result.marksObtained / maxMarks) * 100);
        let grade = 'F';
        if (percentage >= 90) grade = 'A+';
        else if (percentage >= 80) grade = 'A';
        else if (percentage >= 70) grade = 'B+';
        else if (percentage >= 60) grade = 'B';
        else if (percentage >= 50) grade = 'C';
        else if (percentage >= 40) grade = 'D';

        return {
          ...result,
          percentage,
          grade
        };
      });
    }

    await test.save();

    // Notify assigned students if this is (still) an upcoming test and they
    // weren't notified yet.
    await notifyUpcomingTest(test).catch((err) =>
      console.error('[TestResults] Upcoming notification error:', err)
    );

    console.log(`[TestResults] Updated properties for test: ${test.testName}`);
    res.json(test);
  } catch (error: any) {
    console.error('[TestResults] Update properties error:', error);
    res.status(500).json({ message: 'Failed to update test properties', error: error.message });
  }
};

// Delete a test
export const deleteTest = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const test = await TestResult.findByIdAndDelete(id);

    if (!test) {
      return res.status(404).json({ message: 'Test not found' });
    }

    console.log(`[TestResults] Deleted test: ${test.testName}`);
    res.json({ message: 'Test deleted successfully' });
  } catch (error: any) {
    console.error('[TestResults] Delete error:', error);
    res.status(500).json({ message: 'Failed to delete test', error: error.message });
  }
};

// Get results for a specific student
export const getStudentResults = async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    const { studentId } = req.params;

    // Verify the request is for the authenticated user (students can only see their own results)
    // Teachers and admins can see any student's results
    if (authUser.role === 'student' && authUser.id !== studentId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const user = await User.findById(studentId);
    if (!user) {
      return res.status(404).json({ message: 'Student not found' });
    }

    // Find all tests for the student's class
    const tests = await TestResult.find({
      class: user.classLevel,
      $or: [{ batch: user.batch }, { batch: null }, { batch: '' }],
    })
      .sort({ testDate: -1 })
      .lean();

    // Extract only this student's results from each test
    const studentResults = tests.map((test: any) => {
      const studentResult = test.studentResults.find(
        (r: IStudentResult) => r.studentId === studentId || r.studentName === user.name
      );

      return {
        testId: test._id,
        testName: test.testName,
        testDate: test.testDate,
        subject: test.subject,
        maxMarks: test.maxMarks,
        ...studentResult,
      };
    }).filter((r: any) => r.studentId || r.studentName); // Only include tests where student has results

    res.json(studentResults);
  } catch (error: any) {
    console.error('[TestResults] Get student results error:', error);
    res.status(500).json({ message: 'Failed to fetch student results', error: error.message });
  }
};

// Get leaderboard for a class
export const getLeaderboard = async (req: Request, res: Response) => {
  try {
    const { classLevel } = req.params;
    const { subject, limit } = req.query;

    const query: any = { class: classLevel };
    if (subject) query.subject = subject;

    const tests = await TestResult.find(query)
      .sort({ testDate: -1 })
      .lean();

    if (tests.length === 0) {
      return res.json([]);
    }

    // Aggregate student performance across all tests
    const studentPerformance: any = {};

    tests.forEach((test: any) => {
      test.studentResults.forEach((result: IStudentResult) => {
        // Absent students are not counted in the leaderboard
        if (result.isAbsent) return;
        const studentId = result.studentId;
        if (!studentPerformance[studentId]) {
          studentPerformance[studentId] = {
            studentId,
            studentName: result.studentName,
            totalMarks: 0,
            totalMaxMarks: 0,
            testsCount: 0,
            grades: [],
          };
        }

        studentPerformance[studentId].totalMarks += result.marksObtained || 0;
        studentPerformance[studentId].totalMaxMarks += test.maxMarks;
        studentPerformance[studentId].testsCount += 1;
        studentPerformance[studentId].grades.push(result.grade);
      });
    });

    // Convert to array and calculate averages
    const leaderboard = Object.values(studentPerformance).map((student: any) => ({
      ...student,
      averagePercentage: (student.totalMarks / student.totalMaxMarks) * 100,
      averageMarks: student.totalMarks / student.testsCount,
    }));

    // Sort by average percentage (descending)
    leaderboard.sort((a: any, b: any) => b.averagePercentage - a.averagePercentage);

    // Add rank
    leaderboard.forEach((student: any, index) => {
      student.rank = index + 1;
    });

    // Apply limit if specified. Images are attached AFTER slicing, so a class
    // of 300 costs one lookup of the ten rows actually returned.
    const limitNum = limit ? parseInt(limit as string) : leaderboard.length;
    res.json(await withStudentImages(leaderboard.slice(0, limitNum)));
  } catch (error: any) {
    console.error('[TestResults] Get leaderboard error:', error);
    res.status(500).json({ message: 'Failed to fetch leaderboard', error: error.message });
  }
};
