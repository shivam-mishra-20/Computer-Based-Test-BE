import { Router, Request, Response } from 'express';
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
} from '../../controllers/offlineResultsController';

const router = Router();

// New structured test routes
router.post('/tests', authMiddleware, createTest);
router.get('/tests', authMiddleware, getAllTests);
router.get('/tests/:id', authMiddleware, getTestById);
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

    // Query TestResult model (where teachers actually write results)
    const classQuery = {
      $or: [
        { class: userClassNormalized },
        { class: `Class ${userClassNormalized}` },
        { class: rawClass }
      ]
    };

    const tests = await TestResult.find(classQuery)
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
