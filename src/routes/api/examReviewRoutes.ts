import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import {
  listReviewTestsCtrl,
  reviewSummaryCtrl,
  reviewHistoryCtrl,
  setTotalMarksCtrl,
  setAnswerKeyCtrl,
  setMarkingSchemeCtrl,
  setQuestionMarksCtrl,
  adjustSubjectiveCtrl,
  setManualScoreCtrl,
  transitionStateCtrl,
  recomputeCtrl,
  approveSubjectiveCtrl,
  bulkPublishCtrl,
  bulkRecomputeCtrl,
  backfillCtrl,
  cleanupDuplicatesCtrl,
  deleteAttemptCtrl,
  dedupeCtrl,
} from '../../controllers/examReviewController';

const router = Router();

// All review endpoints are teacher/admin only.
router.use(authMiddleware, requireRole('teacher', 'admin'));

// Specific routes first so they aren't shadowed by the `/:examId` patterns.
router.get('/tests', listReviewTestsCtrl);
router.post('/bulk/publish', bulkPublishCtrl);
router.post('/bulk/recompute', bulkRecomputeCtrl);
router.post('/backfill', requireRole('admin'), backfillCtrl);
router.post('/cleanup-duplicates', requireRole('admin'), cleanupDuplicatesCtrl);
router.patch('/attempts/:attemptId/score', adjustSubjectiveCtrl);
router.patch('/attempts/:attemptId/manual-score', setManualScoreCtrl);
router.delete('/attempts/:attemptId', deleteAttemptCtrl);

// Test-level routes.
router.get('/:examId/summary', reviewSummaryCtrl);
router.get('/:examId/history', reviewHistoryCtrl);
router.patch('/:examId/total-marks', setTotalMarksCtrl);
router.patch('/:examId/marking-scheme', setMarkingSchemeCtrl);
router.patch('/:examId/question-marks', setQuestionMarksCtrl);
router.patch('/:examId/answer-key', setAnswerKeyCtrl);
router.post('/:examId/state', transitionStateCtrl);
router.post('/:examId/recompute', recomputeCtrl);
router.post('/:examId/approve-subjective', approveSubjectiveCtrl);
router.post('/:examId/dedupe', dedupeCtrl);

export default router;
