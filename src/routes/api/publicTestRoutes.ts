import { Router } from 'express';
import { optionalAuthMiddleware } from '../../middlewares/authMiddleware';
import {
  getPublicSeries,
  getPublicTest,
  getTestFilterOptions,
  listPublicSeries,
  listPublicTests,
} from '../../controllers/publicTestController';

/**
 * Public assessment discovery — GUESTS BROWSE, LEARNERS ATTEMPT.
 *
 * Every route here is read-only and mounted behind `optionalAuthMiddleware`, so
 * a guest sees the same catalogue a learner does. Nothing that mutates state or
 * serves a question paper lives in this file — starting an attempt requires an
 * account and lives under /api/learner/attempts.
 *
 * The published floor is applied inside each controller's LOOKUP, so a draft is
 * a 404 rather than a filtered-out document.
 */
const router = Router();

// NOTE: /tests/filters must be declared before /tests/:id, or Express matches
// "filters" as an id.
router.get('/tests/filters', optionalAuthMiddleware, getTestFilterOptions);
router.get('/tests', optionalAuthMiddleware, listPublicTests);
router.get('/tests/:id', optionalAuthMiddleware, getPublicTest);

router.get('/series', optionalAuthMiddleware, listPublicSeries);
router.get('/series/:id', optionalAuthMiddleware, getPublicSeries);

export default router;
