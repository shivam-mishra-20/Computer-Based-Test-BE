import { Router } from 'express';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { requireStaffAnyPermission, requireStaffPermission } from '../../middlewares/requirePermission';
import { invalidateCacheOn } from '../../utils/cacheHelpers';
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
router.use(authMiddleware, requireStaffAnyPermission('attempts.grade', 'results.publish'));

const grade = requireStaffPermission('attempts.grade');
const publish = requireStaffPermission('results.publish');
const override = requireStaffPermission('results.override');
const editExam = requireStaffPermission('exams.update');
const maintenance = requireStaffPermission('org.settings');

// Publishing/recomputing changes what students see — clear the per-user
// assigned-exams and attempts caches so newly published results (or score
// changes) appear in the app promptly instead of after the cache TTL.
const invalidateStudentResultCaches = invalidateCacheOn({ patterns: ['assigned-exams', 'attempts'] });

// Specific routes first so they aren't shadowed by the `/:examId` patterns.
router.get('/tests', listReviewTestsCtrl);
router.post('/bulk/publish', publish, invalidateStudentResultCaches, bulkPublishCtrl);
router.post('/bulk/recompute', override, bulkRecomputeCtrl);
router.post('/backfill', maintenance, backfillCtrl);
router.post('/cleanup-duplicates', maintenance, cleanupDuplicatesCtrl);
router.patch('/attempts/:attemptId/score', grade, adjustSubjectiveCtrl);
router.patch('/attempts/:attemptId/manual-score', grade, setManualScoreCtrl);
router.delete('/attempts/:attemptId', override, deleteAttemptCtrl);

// Test-level routes.
router.get('/:examId/summary', reviewSummaryCtrl);
router.get('/:examId/history', reviewHistoryCtrl);
router.patch('/:examId/total-marks', editExam, setTotalMarksCtrl);
router.patch('/:examId/marking-scheme', editExam, setMarkingSchemeCtrl);
router.patch('/:examId/question-marks', editExam, setQuestionMarksCtrl);
router.patch('/:examId/answer-key', editExam, setAnswerKeyCtrl);
router.post('/:examId/state', publish, invalidateStudentResultCaches, transitionStateCtrl);
router.post('/:examId/recompute', override, invalidateStudentResultCaches, recomputeCtrl);
router.post('/:examId/approve-subjective', grade, approveSubjectiveCtrl);
router.post('/:examId/dedupe', override, dedupeCtrl);

export default router;
