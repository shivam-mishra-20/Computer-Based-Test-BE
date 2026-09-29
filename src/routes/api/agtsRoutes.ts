/**
 * /api/agts — AGTS, Abhigyan Gurukul Test Series.
 *
 * Public (no account; listed in core/tenancy/publicRoutes):
 *   GET  /tests                               the class-wise papers that can start
 *   GET  /tests/:ref                          one test by share slug or id
 *   POST /register                            details + consent → lead + attempt
 *   GET  /attempts/:attemptId                 the paper, without answers   [key]
 *   POST /attempts/:attemptId/answer          save one answer              [key]
 *   POST /attempts/:attemptId/submit          final flush + grade          [key]
 *   GET  /attempts/:attemptId/result          the performance report       [key]
 *   POST /attempts/:attemptId/guidance        ask for academic guidance    [key]
 *   GET  /shared/:token                       an admin-shared result link
 *
 *   [key] = `X-AGTS-Attempt-Key` (or the legacy `X-Scholarship-Attempt-Key`).
 *
 * Staff (`enquiries.manage` — admins and front desk):
 *   GET   /admin/leads                        search, filters, pagination, counts
 *   GET   /admin/leads/:leadId                lead + AGTS history
 *   GET   /admin/leads/:leadId/attempts/:attemptId   complete analysis + answers
 *   PATCH /admin/leads/:leadId/status
 *   POST  /admin/leads/:leadId/notes
 *   PATCH /admin/leads/:leadId/follow-up
 *   POST  /admin/leads/:leadId/contact        record a call / WhatsApp opened
 *
 * Every handler reads an explicit allow-list of body fields. Scores, status,
 * owner and organization are never taken from a request.
 */

import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { requireStaffPermission } from '../../middlewares/requirePermission';
import { TenantContextMissing } from '../../core/tenancy';
import { agtsAttemptLimiter, agtsRegisterLimiter, publicFormLimiter } from '../../middlewares/rateLimiter';
import {
  AgtsError,
  adminAttemptDetail,
  getPlayerView,
  getPublicTest,
  getResult,
  getSharedResult,
  listPublicTests,
  registerAndStart,
  requestGuidance,
  saveAnswer,
  submitAttempt,
} from '../../services/agts/agtsService';
import {
  AgtsValidationError,
  parseContactChannel,
  parseFollowUp,
  parseLeadListQuery,
  parseLeadStatus,
  parseNote,
  validateRegistration,
} from '../../services/agts/agtsValidation';
import {
  LeadNotFound,
  addLeadNote,
  assertAttemptOfLead,
  getLead,
  listLeads,
  logLeadContact,
  setLeadFollowUp,
  updateLeadStatus,
} from '../../services/agts/leadService';

const router = Router();

const keyOf = (req: Request) =>
  String(req.header('x-agts-attempt-key') || req.header('x-scholarship-attempt-key') || '').trim().slice(0, 128);

const actorOf = (req: Request) => {
  const user = (req as Request & { user?: { id?: string; name?: string } }).user;
  return { id: user?.id, name: user?.name };
};

function fail(res: Response, err: unknown, fallback: string) {
  if (err instanceof AgtsValidationError) {
    return res.status(400).json({ message: err.message, code: 'AGTS_VALIDATION', errors: err.errors });
  }
  if (err instanceof AgtsError) {
    return res.status(err.status).json({ message: err.message, code: err.code, ...(err.errors ? { errors: err.errors } : {}) });
  }
  if (err instanceof LeadNotFound) return res.status(404).json({ message: err.message, code: err.code });
  const e = err as { status?: number; code?: string; message?: string };
  if (e?.status === 404) return res.status(404).json({ message: e.message || 'Not found', code: e.code || 'NOT_FOUND' });
  if (err instanceof TenantContextMissing) {
    return res.status(403).json({ message: 'No organization context for this request.', code: 'TENANT_REQUIRED' });
  }
  console.error(`[agts] ${fallback}:`, (err as Error)?.message);
  return res.status(500).json({ message: fallback, code: 'AGTS_ERROR' });
}

// Results and attempts are per-candidate; never let an intermediary cache them.
const noStore = (_req: Request, res: Response, next: () => void) => {
  res.set('Cache-Control', 'no-store');
  next();
};

// ── Public ──────────────────────────────────────────────────────────────────

router.get('/tests', async (_req, res) => {
  try {
    res.json(await listPublicTests());
  } catch (err) {
    fail(res, err, 'Failed to load AGTS tests');
  }
});

router.get('/tests/:ref', async (req, res) => {
  try {
    const ref = String(req.params.ref || '').slice(0, 120);
    if (!/^[a-z0-9-]{1,120}$/i.test(ref)) return res.status(404).json({ message: 'This AGTS test link is no longer active.', code: 'AGTS_TEST_UNAVAILABLE' });
    res.json(await getPublicTest(ref));
  } catch (err) {
    fail(res, err, 'Failed to load the test');
  }
});

router.post('/register', agtsRegisterLimiter, noStore, async (req, res) => {
  try {
    const input = validateRegistration(req.body);
    const started = await registerAndStart(input);
    res.status(started.created ? 201 : 200).json(started);
  } catch (err) {
    fail(res, err, 'Failed to start the test');
  }
});

router.get('/attempts/:attemptId', agtsAttemptLimiter, noStore, async (req, res) => {
  try {
    res.json(await getPlayerView(req.params.attemptId, keyOf(req)));
  } catch (err) {
    fail(res, err, 'Failed to load the test');
  }
});

router.post('/attempts/:attemptId/answer', agtsAttemptLimiter, noStore, async (req, res) => {
  try {
    const body = req.body || {};
    res.json(
      await saveAnswer(req.params.attemptId, keyOf(req), {
        questionId: body.questionId,
        answer: body.answer,
        chosenOptionId: body.chosenOptionId,
        textAnswer: body.textAnswer,
        markedForReview: body.markedForReview,
      }),
    );
  } catch (err) {
    fail(res, err, 'Failed to save the answer');
  }
});

router.post('/attempts/:attemptId/submit', agtsAttemptLimiter, noStore, async (req, res) => {
  try {
    const body = req.body || {};
    res.json(await submitAttempt(req.params.attemptId, keyOf(req), { answers: body.answers, reason: body.reason }));
  } catch (err) {
    fail(res, err, 'Failed to submit the test');
  }
});

router.get('/attempts/:attemptId/result', agtsAttemptLimiter, noStore, async (req, res) => {
  try {
    res.json(await getResult(req.params.attemptId, keyOf(req)));
  } catch (err) {
    fail(res, err, 'Failed to load the result');
  }
});

router.post('/attempts/:attemptId/guidance', publicFormLimiter, noStore, async (req, res) => {
  try {
    const body = req.body || {};
    res.json(await requestGuidance(req.params.attemptId, keyOf(req), { preferredTime: body.preferredTime, message: body.message }));
  } catch (err) {
    fail(res, err, 'Failed to send your request');
  }
});

router.get('/shared/:token', noStore, async (req, res) => {
  try {
    res.json(await getSharedResult(req.params.token));
  } catch (err) {
    fail(res, err, 'Failed to load the result');
  }
});

// ── Staff ───────────────────────────────────────────────────────────────────

const staff = [authMiddleware, requireStaffPermission('enquiries.manage'), noStore];

router.get('/admin/leads', ...staff, async (req, res) => {
  try {
    res.json(await listLeads(parseLeadListQuery(req.query as Record<string, unknown>)));
  } catch (err) {
    fail(res, err, 'Failed to load leads');
  }
});

router.get('/admin/leads/:leadId', ...staff, async (req, res) => {
  try {
    res.json(await getLead(req.params.leadId));
  } catch (err) {
    fail(res, err, 'Failed to load the lead');
  }
});

router.get('/admin/leads/:leadId/attempts/:attemptId', ...staff, async (req, res) => {
  try {
    const { attempt } = await assertAttemptOfLead(req.params.leadId, req.params.attemptId);
    res.json(await adminAttemptDetail(attempt));
  } catch (err) {
    fail(res, err, 'Failed to load the attempt');
  }
});

router.patch('/admin/leads/:leadId/status', ...staff, async (req, res) => {
  try {
    const status = parseLeadStatus(req.body?.status);
    const note = parseNote(req.body?.note, 'note', false);
    res.json(await updateLeadStatus(req.params.leadId, status, note, actorOf(req)));
  } catch (err) {
    fail(res, err, 'Failed to update the status');
  }
});

router.post('/admin/leads/:leadId/notes', ...staff, async (req, res) => {
  try {
    res.status(201).json(await addLeadNote(req.params.leadId, parseNote(req.body?.text), actorOf(req)));
  } catch (err) {
    fail(res, err, 'Failed to add the note');
  }
});

router.patch('/admin/leads/:leadId/follow-up', ...staff, async (req, res) => {
  try {
    const followUpAt = parseFollowUp(req.body?.followUpAt);
    const note = parseNote(req.body?.note, 'note', false);
    res.json(await setLeadFollowUp(req.params.leadId, followUpAt, note, actorOf(req)));
  } catch (err) {
    fail(res, err, 'Failed to set the follow-up');
  }
});

router.post('/admin/leads/:leadId/contact', ...staff, async (req, res) => {
  try {
    res.json(await logLeadContact(req.params.leadId, parseContactChannel(req.body?.channel), actorOf(req)));
  } catch (err) {
    fail(res, err, 'Failed to record the contact');
  }
});

export default router;
