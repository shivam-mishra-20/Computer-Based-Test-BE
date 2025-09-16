import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
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
  
} from '../../controllers/attemptController';

const router = Router();

// Student: assigned exams
router.get('/assigned', authMiddleware, requireRole('student'), listAssignedCtrl);
router.post('/:examId/start', authMiddleware, requireRole('student'), startAttemptCtrl);
router.get('/:attemptId', authMiddleware, requireRole('student'), getAttemptCtrl);
router.post('/:attemptId/answer', authMiddleware, requireRole('student'), saveAnswerCtrl);
router.post('/:attemptId/mark', authMiddleware, requireRole('student'), markForReviewCtrl);
router.post('/:attemptId/submit', authMiddleware, requireRole('student'), submitAttemptCtrl);
router.post('/:attemptId/log', authMiddleware, requireRole('student'), logActivityCtrl);
router.post('/:attemptId/next', authMiddleware, requireRole('student'), nextAdaptiveQuestionCtrl);
router.get('/:attemptId/questions/:questionId/explanation', authMiddleware, requireRole('student'), (req, res, next) => {
  // lazy import to avoid circular
  return require('../../controllers/attemptController').getPracticeExplanationCtrl(req, res);
});

// Teacher/Admin: publish results
router.post('/:attemptId/publish', authMiddleware, requireRole('teacher', 'admin'), publishResultCtrl);

export default router;
