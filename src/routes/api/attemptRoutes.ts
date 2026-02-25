import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import { cacheMiddleware, invalidateCacheOn } from '../../utils/cacheHelpers';
import {
  getAttemptCtrl,
  listAssignedCtrl,
  logActivityCtrl,
  markForReviewCtrl,
  publishResultCtrl,
  saveAnswerCtrl,
  startAttemptCtrl,
  submitAttemptCtrl,
  nextAdaptiveQuestionCtrl,
  listPendingReviewCtrl,
  adjustAnswerScoreCtrl,
  listMyAttemptsCtrl,
  teacherAttemptViewCtrl,
} from '../../controllers/attemptController';

const router = Router();

// Student: assigned exams - Cached per user for 3 minutes (180s)
router.get('/assigned', authMiddleware, requireRole('student'), cacheMiddleware({ ttl: 180, customKey: (req) => `assigned-exams:user:${(req as any).user.id}` }), listAssignedCtrl);
// Start exam - Invalidates assigned exams cache
router.post('/:examId/start', authMiddleware, requireRole('student'), invalidateCacheOn({ patterns: ['assigned-exams', 'attempts'] }), startAttemptCtrl);
// list current user's attempts (must come before /:attemptId) - Cached per user for 5 minutes
router.get('/mine', authMiddleware, requireRole('student'), cacheMiddleware({ ttl: 300, customKey: (req) => `my-attempts:user:${(req as any).user.id}` }), listMyAttemptsCtrl);
router.get('/:attemptId', authMiddleware, requireRole('student'), getAttemptCtrl);
// Submit answer - Invalidates attempt cache
router.post('/:attemptId/answer', authMiddleware, requireRole('student'), invalidateCacheOn({ patterns: ['attempts'] }), saveAnswerCtrl);
router.post('/:attemptId/mark', authMiddleware, requireRole('student'), markForReviewCtrl);
// Submit exam - Invalidates exam and attempt caches
router.post('/:attemptId/submit', authMiddleware, requireRole('student'), invalidateCacheOn({ patterns: ['assigned-exams', 'attempts'] }), submitAttemptCtrl);
router.post('/:attemptId/log', authMiddleware, requireRole('student'), logActivityCtrl);
router.post('/:attemptId/next', authMiddleware, requireRole('student'), nextAdaptiveQuestionCtrl);
router.get('/:attemptId/questions/:questionId/explanation', authMiddleware, requireRole('student'), (req, res, next) => {
  // lazy import to avoid circular
  return require('../../controllers/attemptController').getPracticeExplanationCtrl(req, res);
});

// Teacher/Admin: publish results
router.post('/:attemptId/publish', authMiddleware, requireRole('teacher', 'admin'), publishResultCtrl);
router.get('/review/pending', authMiddleware, requireRole('teacher','admin'), listPendingReviewCtrl);
router.patch('/:attemptId/adjust', authMiddleware, requireRole('teacher','admin'), adjustAnswerScoreCtrl);
router.get('/:attemptId/review', authMiddleware, requireRole('teacher','admin'), teacherAttemptViewCtrl);

export default router;
