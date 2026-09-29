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
import { requireStaffPermission } from '../../middlewares/requirePermission';
import { agtsRegisterLimiter } from '../../middlewares/rateLimiter';

/**
 * The pre-AGTS scholarship routes.
 *
 * The public flow now lives at /api/agts; these stay for attempts already in
 * flight on old clients, result links already shared, and the admin test
 * builder. Two fixes over the original wiring:
 *
 *  - Every staff route names a permission. They used to require only a login,
 *    so a STUDENT token could list every candidate's name and phone number,
 *    read answer keys through the preview, and create or delete tests.
 *    Candidate data needs `enquiries.manage` (admins, front desk); building
 *    tests needs the exam permissions a teacher already holds.
 *  - Creating an attempt is rate limited; it selects questions and writes a row.
 */
const router = Router();

const candidates = [authMiddleware, requireStaffPermission('enquiries.manage')];

// Public routes (no authentication required)
router.post('/attempts', agtsRegisterLimiter, createAttemptCtrl);
router.get('/attempts/:attemptId', getAttemptCtrl);
router.post('/attempts/:attemptId/answer', saveAnswerCtrl);
router.post('/attempts/:attemptId/submit', submitTestCtrl);
router.get('/public/results/:token', getPublicResultByTokenCtrl);

// Admin routes (authentication required)
router.get('/results', ...candidates, getResultsCtrl);
router.post('/results/publish', ...candidates, publishResultsCtrl);
router.get('/results/:attemptId/detail', ...candidates, getAttemptReviewCtrl);
router.patch('/results/:attemptId/review', ...candidates, updateAttemptReviewCtrl);
router.patch('/results/:attemptId/batch', ...candidates, updateAttemptBatchCtrl);
router.get('/results/:attemptId/public-link', ...candidates, getAttemptPublicResultLinkCtrl);

// Test Management routes
router.post('/tests', authMiddleware, requireStaffPermission('exams.create'), createTestCtrl);
router.get('/tests', getTestsCtrl);
router.get('/tests/:testId', getTestCtrl);
router.delete('/tests/:testId', authMiddleware, requireStaffPermission('exams.delete'), deleteTestCtrl);
router.get('/tests/:testId/share-link', authMiddleware, requireStaffPermission('exams.create'), getShareLinkCtrl);
// The preview returns the answer key.
router.get('/tests/:testId/preview', authMiddleware, requireStaffPermission('exams.create'), getTestPreviewCtrl);

export default router;
