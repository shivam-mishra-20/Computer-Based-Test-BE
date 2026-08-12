import { Router } from 'express';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { getLearnerMe, updateLearnerPreferences } from '../../controllers/learnerController';
import {
  addSave,
  getLearnerHome,
  getLibrary,
  getProgress,
  listSaves,
  removeSave,
  upsertProgress,
} from '../../controllers/learnerLibraryController';
import {
  deleteLearnerAccount,
  getLearnerAnalytics,
} from '../../controllers/learnerAnalyticsController';
import {
  getAttempt,
  getAttemptResult,
  listAttempts,
  saveAnswers,
  startAttempt,
  submitAttempt,
} from '../../controllers/publicAttemptController';

/**
 * Public Learner routes. Every handler re-checks `accountType === 'PUBLIC_LEARNER'`
 * itself, so an institute student's JWT cannot reach learner state even if this
 * router were ever mounted behind a laxer guard.
 *
 * Content served here is subject to the SAME public visibility floor as the
 * guest endpoints — authenticating grants personalization, never wider access.
 */
const router = Router();

// Profile + personalization
router.get('/me', authMiddleware, getLearnerMe);
router.patch('/preferences', authMiddleware, updateLearnerPreferences);

// Personalized home
router.get('/home', authMiddleware, getLearnerHome);

// My Stuff
router.get('/library', authMiddleware, getLibrary);

// Saves
router.get('/saves', authMiddleware, listSaves);
router.post('/saves', authMiddleware, addSave);
router.delete('/saves/:resourceId', authMiddleware, removeSave);

// Progress / resume
router.get('/progress', authMiddleware, getProgress);
router.put('/progress', authMiddleware, upsertProgress);

/**
 * Attempts. Browsing the test catalogue is open to guests under /api/public,
 * but ATTEMPTING is not — every handler below resolves a PUBLIC_LEARNER before
 * doing anything, so a guest gets 401 and an institute student gets 403.
 *
 * Ordering matters: `/attempts/:id/...` sub-paths are declared before nothing
 * that could shadow them, and `/attempts` (list) is a distinct method+path.
 */
router.get('/attempts', authMiddleware, listAttempts);
router.post('/attempts', authMiddleware, startAttempt);
router.get('/attempts/:id', authMiddleware, getAttempt);
router.patch('/attempts/:id/answers', authMiddleware, saveAnswers);
router.post('/attempts/:id/submit', authMiddleware, submitAttempt);
router.get('/attempts/:id/result', authMiddleware, getAttemptResult);

// Analytics — one call for the whole analytics screen.
router.get('/analytics', authMiddleware, getLearnerAnalytics);

// Account removal. Separate from the institute DELETE /api/auth/account so
// learner-owned rows are cascaded and institute code stays untouched.
router.delete('/account', authMiddleware, deleteLearnerAccount);

export default router;
