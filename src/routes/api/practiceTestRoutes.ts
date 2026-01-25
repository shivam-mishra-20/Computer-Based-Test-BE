import { Router, Request, Response } from 'express';
import { Types } from 'mongoose';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import {
  getAvailableMeta,
  createPracticeTest,
  getPracticeTestView,
  startPracticeTestAttempt,
  getChapterWiseAnalysis,
  listUserPracticeTests,
  getPresets,
  CreatePracticeTestRequest,
} from '../../services/practiceTestService';
import { getAttemptView, saveAnswer, markForReview, submitAttempt } from '../../services/attemptService';
import PracticeTest from '../../models/PracticeTest';
import Attempt, { IAttempt } from '../../models/Attempt';

const router = Router();

/**
 * GET /api/practice-tests/meta
 * Get available subjects, chapters, and difficulty stats for test builder UI
 */
router.get('/meta', authMiddleware, requireRole('student'), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const meta = await getAvailableMeta(userId);
    res.json(meta);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to fetch metadata' });
  }
});

/**
 * GET /api/practice-tests/presets
 * Get quick test preset configurations
 */
router.get('/presets', authMiddleware, requireRole('student'), async (_req: Request, res: Response) => {
  try {
    const presets = getPresets();
    res.json(presets);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to fetch presets' });
  }
});

/**
 * GET /api/practice-tests/history
 * Get user's practice test history
 */
router.get('/history', authMiddleware, requireRole('student'), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const status = req.query.status as string | undefined;
    const limit = parseInt(req.query.limit as string) || 20;

    const tests = await listUserPracticeTests(userId, { status, limit });
    res.json(tests);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to fetch history' });
  }
});

/**
 * POST /api/practice-tests
 * Create a new custom practice test
 */
router.post('/', authMiddleware, requireRole('student'), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const config: CreatePracticeTestRequest = req.body;

    // Validate required fields
    if (!config.subjects || config.subjects.length === 0) {
      return res.status(400).json({ message: 'At least one subject is required' });
    }
    if (!config.questionCount || config.questionCount < 5 || config.questionCount > 200) {
      return res.status(400).json({ message: 'Question count must be between 5 and 200' });
    }
    if (!config.difficulty) {
      return res.status(400).json({ message: 'Difficulty distribution is required' });
    }
    if (!config.duration) {
      return res.status(400).json({ message: 'Duration configuration is required' });
    }
    if (!config.markingScheme) {
      return res.status(400).json({ message: 'Marking scheme is required' });
    }

    const practiceTest = await createPracticeTest(userId, config);
    res.status(201).json(practiceTest);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to create practice test' });
  }
});

/**
 * GET /api/practice-tests/:id
 * Get practice test details
 */
router.get('/:id', authMiddleware, requireRole('student'), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const { practiceTest, questions } = await getPracticeTestView(req.params.id, userId);
    res.json({ practiceTest, questions });
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to fetch practice test' });
  }
});

/**
 * POST /api/practice-tests/:id/start
 * Start an attempt for a practice test
 */
router.post('/:id/start', authMiddleware, requireRole('student'), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const attempt = await startPracticeTestAttempt(req.params.id, userId);
    res.status(201).json(attempt);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to start practice test' });
  }
});

/**
 * GET /api/practice-tests/:id/attempt
 * Get the attempt view for a practice test (questions, answers, timer state)
 */
router.get('/:id/attempt', authMiddleware, requireRole('student'), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const practiceTestId = req.params.id;

    // Find the attempt for this practice test
    const attempt = await Attempt.findOne({
      practiceTestId: new Types.ObjectId(practiceTestId),
      userId: new Types.ObjectId(userId),
    });

    if (!attempt) {
      return res.status(404).json({ message: 'Attempt not found. Start the test first.' });
    }

    // Get practice test details with questions
    const { practiceTest, questions } = await getPracticeTestView(practiceTestId, userId);

    res.json({
      attempt: attempt.toObject(),
      practiceTest,
      questions,
      sections: [
        {
          _id: 'main',
          title: practiceTest.title,
          questionIds: practiceTest.questionIds.map((id) => id.toString()),
        },
      ],
    });
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to fetch attempt' });
  }
});

/**
 * POST /api/practice-tests/:id/answer
 * Save an answer for a practice test question
 */
router.post('/:id/answer', authMiddleware, requireRole('student'), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const practiceTestId = req.params.id;

    // Find the attempt
    const attempt = await Attempt.findOne({
      practiceTestId: new Types.ObjectId(practiceTestId),
      userId: new Types.ObjectId(userId),
    });

    if (!attempt) {
      return res.status(404).json({ message: 'Attempt not found' });
    }

    // Save answer using existing service
    const updatedAttempt = await saveAnswer(String(attempt._id), userId, {
      questionId: new Types.ObjectId(req.body.questionId),
      chosenOptionId: req.body.chosenOptionId ? new Types.ObjectId(req.body.chosenOptionId) : undefined,
      textAnswer: req.body.textAnswer,
      isMarkedForReview: req.body.isMarkedForReview,
      timeSpentSec: req.body.timeSpentSec,
    });

    res.json(updatedAttempt);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to save answer' });
  }
});

/**
 * POST /api/practice-tests/:id/mark
 * Mark/unmark a question for review
 */
router.post('/:id/mark', authMiddleware, requireRole('student'), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const practiceTestId = req.params.id;

    const attempt = await Attempt.findOne({
      practiceTestId: new Types.ObjectId(practiceTestId),
      userId: new Types.ObjectId(userId),
    });

    if (!attempt) {
      return res.status(404).json({ message: 'Attempt not found' });
    }

    const updatedAttempt = await markForReview(
      String(attempt._id),
      userId,
      req.body.questionId,
      !!req.body.marked
    );

    res.json(updatedAttempt);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to update mark for review' });
  }
});

/**
 * POST /api/practice-tests/:id/submit
 * Submit practice test attempt
 */
router.post('/:id/submit', authMiddleware, requireRole('student'), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const practiceTestId = req.params.id;
    const auto = !!req.body.auto;

    const attempt = await Attempt.findOne({
      practiceTestId: new Types.ObjectId(practiceTestId),
      userId: new Types.ObjectId(userId),
    });

    if (!attempt) {
      return res.status(404).json({ message: 'Attempt not found' });
    }

    // Submit using existing service
    const submittedAttempt = await submitAttempt(String(attempt._id), userId, auto);

    // Update practice test status
    await PracticeTest.findByIdAndUpdate(practiceTestId, { status: 'completed' });

    res.json(submittedAttempt);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to submit practice test' });
  }
});

/**
 * GET /api/practice-tests/:id/result
 * Get result with chapter-wise analysis
 */
router.get('/:id/result', authMiddleware, requireRole('student'), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const practiceTestId = req.params.id;

    // Get practice test and attempt
    const { practiceTest, questions } = await getPracticeTestView(practiceTestId, userId);
    
    const attempt = await Attempt.findOne({
      practiceTestId: new Types.ObjectId(practiceTestId),
      userId: new Types.ObjectId(userId),
    });

    if (!attempt) {
      return res.status(404).json({ message: 'Attempt not found' });
    }

    if (attempt.status !== 'submitted' && attempt.status !== 'auto-submitted') {
      return res.status(400).json({ message: 'Test not yet completed' });
    }

    // Get chapter-wise analysis
    const chapterAnalysis = await getChapterWiseAnalysis(practiceTestId, userId);

    res.json({
      attempt: attempt.toObject(),
      practiceTest,
      questions,
      sections: [
        {
          _id: 'main',
          title: practiceTest.title,
          questionIds: practiceTest.questionIds.map((id) => id.toString()),
        },
      ],
      chapterAnalysis,
    });
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to fetch result' });
  }
});

export default router;
