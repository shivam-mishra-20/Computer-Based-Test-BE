import { Router, Request, Response } from 'express';
import {
  authMiddleware,
  optionalAuthMiddleware,
  requireRole,
} from '../../middlewares/authMiddleware';
import { publicFormLimiter } from '../../middlewares/rateLimiter';
import {
  ClassRequestValidationError,
  createPublicClassRequest,
  getPublicOptions,
  listClassRequests,
  listMyClassRequests,
  updateClassRequestStatus,
} from '../../services/classRequestService';
import type { ClassRequestSource } from '../../models/ClassRequest';

const router = Router();

/**
 * Decide the request source SERVER-SIDE. The body is never consulted, so a
 * client cannot mislabel where a request came from.
 *
 * The mobile app sends an explicit `X-Client-Platform: app` header (see
 * lib/classRequestApi.ts); anything else — including a browser — is WEB. The
 * User-Agent check is a fallback for the Expo/React-Native fetch stack.
 */
const resolveSource = (req: Request): ClassRequestSource => {
  const header = String(req.headers['x-client-platform'] || '').toLowerCase();
  if (header === 'app' || header === 'mobile') return 'APP';
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (
    ua.includes('okhttp') ||
    ua.includes('expo') ||
    ua.includes('react-native')
  )
    return 'APP';
  return 'WEB';
};

const handleError = (res: Response, err: unknown, fallback: string) => {
  if (err instanceof ClassRequestValidationError) {
    return res.status(400).json({ message: err.message, field: err.field });
  }
  console.error(fallback, err);
  return res.status(500).json({ message: fallback });
};

// ============ Public Routes ============

/**
 * GET /api/class-requests/options
 * Minimal class/batch/subject lists for the public form. No counts, no user
 * data, no internal ids.
 *
 * Declared BEFORE the admin `GET /` so it is never shadowed.
 */
router.get('/options', async (_req: Request, res: Response) => {
  try {
    const options = await getPublicOptions();
    res.json(options);
  } catch (err) {
    handleError(res, err, 'Failed to load class request options');
  }
});

/**
 * POST /api/class-requests
 * Public submission. Rate limited; every privileged field is server-set.
 */
router.post(
  '/',
  publicFormLimiter,
  // Optional: guests submit with no token at all. When a token IS present and
  // valid (a teacher raising a request in-app), the row is attributed to them.
  // A bad token degrades to "guest" and can never escalate.
  optionalAuthMiddleware,
  async (req: Request, res: Response) => {
    try {
      // Explicit field pick — unknown keys in the body are ignored outright, so
      // status/reviewedBy/assignedTeacher can never be mass-assigned.
      const created = await createPublicClassRequest(
        {
          name: req.body?.name,
          classValue: req.body?.classValue,
          batchName: req.body?.batchName,
          batchNames: req.body?.batchNames,
          studentIds: req.body?.studentIds,
          subject: req.body?.subject,
          preferredTiming: req.body?.preferredTiming,
          preferredAt: req.body?.preferredAt,
          reason: req.body?.reason,
        },
        {
          source: resolveSource(req),
          ip: req.ip,
          requestedBy: (
            req as Request & { user?: { id: string; role?: string } }
          ).user,
        },
      );

      // Echo back only what the submitter needs to see a confirmation.
      res.status(201).json({
        message: 'Class request submitted successfully',
        request: {
          id: created._id,
          name: created.name,
          classValue: created.classValue,
          batchName: created.batchName,
          subject: created.subject,
          preferredTiming: created.preferredTiming,
          status: created.status,
          createdAt: created.createdAt,
        },
      });
    } catch (err) {
      handleError(res, err, 'Failed to submit class request');
    }
  },
);

// ============ Authenticated (own data) ============

/**
 * GET /api/class-requests/mine
 * The caller's own requests + their status. Any signed-in role; scoped to the
 * session, so a user can only ever see what they themselves submitted.
 *
 * Declared before the admin `GET /` so the path is never shadowed.
 */
router.get('/mine', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { user?: { id: string } }).user?.id;
    const items = await listMyClassRequests(String(userId));
    res.json(items);
  } catch (err) {
    handleError(res, err, 'Failed to load your class requests');
  }
});

// ============ Admin Routes ============

/**
 * GET /api/class-requests
 * Admin queue — search, status/source/date filters, pagination, status counts.
 */
router.get(
  '/',
  authMiddleware,
  requireRole('admin', 'developer'),
  async (req: Request, res: Response) => {
    try {
      const result = await listClassRequests({
        status: req.query.status as string | undefined,
        source: req.query.source as string | undefined,
        search: req.query.search as string | undefined,
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        page: Number(req.query.page) || 1,
        limit: Number(req.query.limit) || 25,
      });
      res.json(result);
    } catch (err) {
      handleError(res, err, 'Failed to load class requests');
    }
  },
);

/**
 * PATCH /api/class-requests/:id/status
 * Admin status transition + optional remarks / teacher assignment.
 * `reviewedAt`/`reviewedBy` are stamped by the service, not the client.
 */
router.patch(
  '/:id/status',
  authMiddleware,
  requireRole('admin', 'developer'),
  async (req: Request, res: Response) => {
    try {
      const reviewerId = (req as Request & { user?: { id: string } }).user?.id;
      const updated = await updateClassRequestStatus(
        req.params.id,
        {
          status: req.body?.status,
          remarks: req.body?.remarks,
          assignedTeacher: req.body?.assignedTeacher,
        },
        reviewerId,
      );

      if (!updated)
        return res.status(404).json({ message: 'Class request not found' });
      res.json(updated);
    } catch (err) {
      handleError(res, err, 'Failed to update class request');
    }
  },
);

export default router;
