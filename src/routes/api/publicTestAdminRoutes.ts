import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import {
  adminCreateSeries,
  adminCreateTest,
  adminDeleteSeries,
  adminDeleteTest,
  adminDuplicateTest,
  adminGetTest,
  adminListSeries,
  adminListTests,
  adminPromoteExam,
  adminSetTestStatus,
  adminUpdateSeries,
  adminUpdateTest,
} from '../../controllers/publicTestAdminController';

/**
 * Authoring routes for the public assessment catalogue.
 *
 * Guarded at the ROUTER level with `requireRole('admin', 'teacher')`, so no
 * handler can be reached without a staff role even if one forgot to check.
 * Learners and guests have no path into this router at all — their surfaces are
 * /api/public (read) and /api/learner (own attempts).
 *
 * Mounted at /api/admin-assessments rather than under /api/admin, because
 * adminRoutes guards that whole base path with `requireRole('admin')`. Sharing
 * it would either shadow the institute admin router or lock teachers out of
 * authoring. A sibling path leaves existing institute behaviour untouched —
 * the same shape /api/admin-analytics already uses.
 */
const router = Router();

router.use(authMiddleware, requireRole('admin', 'teacher'));

// Promotion is declared before /:id so "promote" is never read as an id.
router.post('/public-tests/promote', adminPromoteExam);

router.get('/public-tests', adminListTests);
router.post('/public-tests', adminCreateTest);
router.get('/public-tests/:id', adminGetTest);
router.patch('/public-tests/:id', adminUpdateTest);
router.delete('/public-tests/:id', adminDeleteTest);
router.post('/public-tests/:id/status', adminSetTestStatus);
router.post('/public-tests/:id/duplicate', adminDuplicateTest);

router.get('/public-series', adminListSeries);
router.post('/public-series', adminCreateSeries);
router.patch('/public-series/:id', adminUpdateSeries);
router.delete('/public-series/:id', adminDeleteSeries);

export default router;
