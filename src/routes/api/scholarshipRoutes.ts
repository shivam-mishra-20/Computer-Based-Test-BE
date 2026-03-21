import { Router } from 'express';
import {
  createAttemptCtrl,
  getAttemptCtrl,
  saveAnswerCtrl,
  submitTestCtrl,
  getResultsCtrl,
  publishResultsCtrl,
  createTestCtrl,
  getTestsCtrl,
  getTestCtrl,
  deleteTestCtrl,
  getShareLinkCtrl,
  getTestPreviewCtrl,
  getAttemptReviewCtrl,
  updateAttemptReviewCtrl,
  updateAttemptBatchCtrl,
  getAttemptPublicResultLinkCtrl,
  getPublicResultByTokenCtrl,
} from '../../controllers/scholarshipController';
import { authMiddleware } from '../../middlewares/authMiddleware';

const router = Router();

// Public routes (no authentication required)
router.post('/attempts', createAttemptCtrl);
router.get('/attempts/:attemptId', getAttemptCtrl);
router.post('/attempts/:attemptId/answer', saveAnswerCtrl);
router.post('/attempts/:attemptId/submit', submitTestCtrl);
router.get('/public/results/:token', getPublicResultByTokenCtrl);

// Admin routes (authentication required)
router.get('/results', authMiddleware, getResultsCtrl);
router.post('/results/publish', authMiddleware, publishResultsCtrl);
router.get('/results/:attemptId/detail', authMiddleware, getAttemptReviewCtrl);
router.patch('/results/:attemptId/review', authMiddleware, updateAttemptReviewCtrl);
router.patch('/results/:attemptId/batch', authMiddleware, updateAttemptBatchCtrl);
router.get('/results/:attemptId/public-link', authMiddleware, getAttemptPublicResultLinkCtrl);

// Test Management routes
router.post('/tests', authMiddleware, createTestCtrl);
router.get('/tests', getTestsCtrl);
router.get('/tests/:testId', getTestCtrl);
router.delete('/tests/:testId', authMiddleware, deleteTestCtrl);
router.get('/tests/:testId/share-link', authMiddleware, getShareLinkCtrl);
router.get('/tests/:testId/preview', authMiddleware, getTestPreviewCtrl);

export default router;
