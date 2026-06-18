import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { authMiddleware } from '../../middlewares/authMiddleware';
import OfflineResult from '../../models/OfflineResult';
import TestResult from '../../models/TestResult';
import User from '../../models/User';
import {
  createTest,
  getAllTests,
  getTestById,
  updateTestResults,
  deleteTest,
  getStudentResults,
  getLeaderboard,
  updateTestProperties,
} from '../../controllers/offlineResultsController';

const router = Router();

// Build the assignment-aware $or that matches every TestResult a given student
// should see. A test is visible when the student's CLASS matches AND, if the
// test specifies a BATCH (its `batch` field or `assignedBatches`), the student's
// batch matches too. Individually-assigned tests bypass class/batch. This also
// covers legacy tests (no assignmentType) and tests created before the
// assignment fields existed, which carry their scope on `class`/`batch`.
function buildStudentTestMatch(user: { id?: string; classLevel?: string; batch?: string }): any[] {
  const rawClass = String(user.classLevel || '').trim();
  const classNum = rawClass.replace(/^Class\s*/i, '').trim();
  const classVariants = [classNum, `Class ${classNum}`, rawClass].filter((v) => v && v !== 'Class');
  const userBatch = (user.batch || '').trim();

  // Class scope: the test's own `class` OR an explicit `assignedClasses` entry.
  const classMatch = {
    $or: [{ class: { $in: classVariants } }, { assignedClasses: { $in: classVariants } }],
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
        $or: [{ assignedBatches: { $exists: false } }, { assignedBatches: { $size: 0 } }],
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
  or.push({ $and: [{ assignmentType: { $ne: 'students' } }, classMatch, noBatchRestriction] });

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

// New structured test routes
router.post('/tests', authMiddleware, createTest);
router.get('/tests', authMiddleware, getAllTests);
router.get('/tests/:id', authMiddleware, getTestById);
router.put('/tests/:id', authMiddleware, updateTestProperties);
router.put('/tests/:id/results', authMiddleware, updateTestResults);
router.delete('/tests/:id', authMiddleware, deleteTest);

// Student results routes
router.get('/students/:studentId/results', authMiddleware, getStudentResults);

// Leaderboard route
router.get('/leaderboard/:classLevel', authMiddleware, getLeaderboard);

// Get offline results for the logged-in student
router.get('/student', authMiddleware, async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    const user = await User.findById(authUser.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userName = user.name;
    const rawClass = String(user.classLevel || '').trim();
    const userClassNormalized = rawClass.replace(/^Class\s*/i, '').trim();
    const userBatch = user.batch || '';

    console.log(`[OfflineResults] Fetching for user: name="${userName}", id="${authUser.id}", class="${userClassNormalized}", batch="${userBatch}"`);

    // Query TestResult model (where teachers actually write results), matching
    // every test assigned to this student (class/batch/individual + legacy).
    const tests = await TestResult.find({
      $or: buildStudentTestMatch({
        id: authUser.id,
        classLevel: user.classLevel,
        batch: user.batch,
      }),
    })
      .sort({ testDate: -1, createdAt: -1 })
      .lean();

    console.log(`[OfflineResults] Found ${tests.length} tests for class ${userClassNormalized}`);

    // Extract this student's results from each test's studentResults array
    const studentResults = tests
      .map((test: any) => {
        const studentResult = test.studentResults?.find(
          (r: any) => r.studentId === authUser.id || r.studentName === userName
        );
        if (!studentResult) return null;

        return {
          _id: test._id,
          class: test.class,
          name: test.testName,
          batch: test.batch || '',
          subject: test.subject,
          marks: studentResult.marksObtained ?? studentResult.marks ?? 0,
          outOf: test.maxMarks ?? 0,
          remarks: studentResult.remarks || '',
          testDate: test.testDate,
          createdAt: test.createdAt,
          percentage: test.maxMarks > 0
            ? Math.round(((studentResult.marksObtained ?? studentResult.marks ?? 0) / test.maxMarks) * 100)
            : 0,
          grade: studentResult.grade || '',
          isAbsent: !!studentResult.isAbsent,
        };
      })
      .filter(Boolean);

    console.log(`[OfflineResults] Found ${studentResults.length} results for student "${userName}"`);
    res.json(studentResults);
  } catch (error: any) {
    console.error('Error fetching offline results:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch offline results' });
  }
});

// Get upcoming (future-dated) tests assigned to the logged-in student
router.get('/student/upcoming', authMiddleware, async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    const user = await User.findById(authUser.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const today = new Date().toISOString().split('T')[0];

    const tests = await TestResult.find({
      testDate: { $gte: today },
      $or: buildStudentTestMatch({
        id: authUser.id,
        classLevel: user.classLevel,
        batch: user.batch,
      }),
    })
      .sort({ testDate: 1, createdAt: 1 })
      .lean();

    // Drop any test the student already has a graded result for (defensive —
    // a future-dated test normally has no results yet).
    const userId = String(authUser.id);
    const userName = user.name;
    const upcoming = tests.filter((t: any) => {
      const mine = (t.studentResults || []).find(
        (r: any) => r.studentId === userId || r.studentName === userName
      );
      return !mine || (!(Number(mine.marksObtained) > 0) && !mine.isAbsent);
    });

    // Enrich with creator name for the "Assigned By" line.
    const creatorIds = [...new Set(upcoming.map((t: any) => t.createdBy).filter(Boolean))]
      .filter((id: any) => mongoose.Types.ObjectId.isValid(id))
      .map((id: any) => new mongoose.Types.ObjectId(id));
    const creators = creatorIds.length
      ? await User.find({ _id: { $in: creatorIds } }, 'name').lean()
      : [];
    const creatorMap: Record<string, string> = {};
    creators.forEach((c: any) => {
      creatorMap[String(c._id)] = c.name;
    });

    const result = upcoming.map((t: any) => ({
      _id: t._id,
      testName: t.testName,
      subject: t.subject,
      class: t.class,
      batch: t.batch || '',
      testDate: t.testDate,
      maxMarks: t.maxMarks,
      assignedBy: creatorMap[String(t.createdBy)] || 'Teacher',
    }));

    res.json(result);
  } catch (error: any) {
    console.error('Error fetching upcoming offline tests:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch upcoming tests' });
  }
});

// Get all offline results (admin only)
router.get('/all', authMiddleware, async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    const user = await User.findById(authUser.id);
    
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { classLevel, batch, subject, limit = 100 } = req.query;
    
    const query: any = {};
    if (classLevel) query.class = classLevel;
    if (batch) query.batch = batch;
    if (subject) query.subject = new RegExp(subject as string, 'i');

    const results = await OfflineResult.find(query)
      .sort({ testDate: -1, createdAt: -1 })
      .limit(Number(limit))
      .lean();

    res.json(results);
  } catch (error: any) {
    console.error('Error fetching all offline results:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch offline results' });
  }
});

export default router;
