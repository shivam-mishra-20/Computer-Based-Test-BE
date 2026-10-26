import { requireStaffPermission, staffHolds } from '../../middlewares/requirePermission';
import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { authMiddleware } from '../../middlewares/authMiddleware';
import OfflineResult from '../../models/OfflineResult';
import TestResult from '../../models/TestResult';
import User from '../../models/User';
import {
  buildStudentTestMatch,
  entryForStudent,
} from '../../services/writtenTests';
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


// New structured test routes
//
// Writes are staff-only. The handlers check no role, so before these guards any
// signed-in student could create, rename, re-mark or delete an offline test.
// Entering marks also notifies students ("New Result Available"), which is why
// it needs results.publish. Legacy admins and teachers hold all four through
// LEGACY_ROLE_PERMISSIONS, so nothing changes for them.
//
// Reads are staff-only too: a test carries EVERY student's marks, and the list
// was unscoped for anyone but a teacher, so a student could read the whole
// class's results. Students read their own through /student. Which tests a
// teacher may change is decided in the controller (canManageTest): their own,
// unless they are an admin.
router.post('/tests', authMiddleware, requireStaffPermission('exams.create'), createTest);
router.get('/tests', authMiddleware, requireStaffPermission('results.read'), getAllTests);
router.get('/tests/:id', authMiddleware, requireStaffPermission('results.read'), getTestById);
router.put('/tests/:id', authMiddleware, requireStaffPermission('exams.update'), updateTestProperties);
router.put('/tests/:id/results', authMiddleware, requireStaffPermission('results.publish'), updateTestResults);
router.delete('/tests/:id', authMiddleware, requireStaffPermission('exams.delete'), deleteTest);

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
        const studentResult: any = entryForStudent<any>(test.studentResults, {
          id: authUser.id,
          firebaseUid: user.firebaseUid,
          name: userName,
        });
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
      const mine: any = entryForStudent<any>(t.studentResults, {
        id: userId,
        firebaseUid: user.firebaseUid,
        name: userName,
      });
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
    
    if (!user || !(await staffHolds(req, 'results.read', 'org.read'))) {
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
