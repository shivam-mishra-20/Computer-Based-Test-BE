import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middlewares/authMiddleware';
import OfflineResult from '../../models/OfflineResult';
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
    // Normalize class level - handle both "11" and "Class 11" formats
    const rawClass = String(user.classLevel || '').trim();
    const userClassNormalized = rawClass.replace(/^Class\s*/i, '').trim();
    const userBatch = user.batch || '';

    console.log(`[OfflineResults] Fetching for user: name="${userName}", class="${userClassNormalized}", batch="${userBatch}", rawClass="${rawClass}"`);

    // Build query - the offlineresults collection seems to store by class/batch, not by student name
    // So we match by class level and batch
    const query: any = {};
    
    // Match class in various formats (e.g., "11", "Class 11")
    query.$or = [
      { class: userClassNormalized },
      { class: `Class ${userClassNormalized}` },
      { class: rawClass }
    ];
    
    // If user has a batch, try to match it (but also include results without batch)
    if (userBatch) {
      query.batch = { $in: [userBatch, '', null] };
    }

    console.log(`[OfflineResults] Query:`, JSON.stringify(query));

    let results = await OfflineResult.find(query)
      .sort({ testDate: -1, createdAt: -1 })
      .lean();

    // If no results found with batch filter, try without batch
    if (results.length === 0 && userBatch) {
      console.log('[OfflineResults] No results with batch filter, trying class-only match...');
      const classOnlyQuery = {
        $or: [
          { class: userClassNormalized },
          { class: `Class ${userClassNormalized}` },
          { class: rawClass }
        ]
      };
      results = await OfflineResult.find(classOnlyQuery)
        .sort({ testDate: -1, createdAt: -1 })
        .lean();
    }

    // Also try to match by user's batch specifically
    if (results.length === 0 && userBatch) {
      console.log('[OfflineResults] Trying batch-only match...');
      const batchResults = await OfflineResult.find({ batch: userBatch })
        .sort({ testDate: -1, createdAt: -1 })
        .lean();
      if (batchResults.length > 0) {
        results = batchResults;
      }
    }

    console.log(`[OfflineResults] Found ${results.length} results`);
    res.json(results);
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
