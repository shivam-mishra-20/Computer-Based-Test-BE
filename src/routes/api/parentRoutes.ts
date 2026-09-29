/**
 * What a signed-in parent can do — and nothing else.
 *
 * Every route here requires the `parent` role, and every read goes through
 * core/guardians, which re-checks a VERIFIED link in the parent's own
 * organization on each call. The organization comes from the signed token
 * (`req.user.orgId`), never from a parameter. A student id in the URL is a
 * question the server answers only for that parent's verified wards; for any
 * other id — unverified, revoked, from another institute or invented — it
 * answers the same 404.
 *
 * `authMiddleware` confines a parent token to this router (plus its own account
 * and the app-shell context call), so a parent cannot reach the teacher- or
 * student-shaped routes elsewhere even where those branch on role.
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import { guardianVerifyLimiter } from '../../middlewares/rateLimiter';
import {
  findWardByCredentials,
  GuardianLinkError,
  requestLink,
  wardResults,
  wardsOf,
} from '../../core/guardians/guardians';
import { logAudit } from '../../utils/logger';

const router = Router();

const WARD_NOT_VERIFIED =
  "We couldn't verify that student. Check the student code and the student's registered phone number with your institute.";

function sessionOf(req: Request): { id: string; orgId: string } | null {
  const user = (req as Request & { user?: { id?: string; orgId?: string } }).user;
  if (!user?.id || !user.orgId) return null;
  return { id: String(user.id), orgId: String(user.orgId) };
}

router.get('/wards', authMiddleware, requireRole('parent'), async (req: Request, res: Response) => {
  const who = sessionOf(req);
  if (!who) return res.status(403).json({ message: 'This account is not attached to an institute.' });
  try {
    return res.json(await wardsOf(who.orgId, who.id));
  } catch {
    return res.status(500).json({ message: 'Could not load your wards.' });
  }
});

router.get(
  '/wards/:studentId/results',
  authMiddleware,
  requireRole('parent'),
  async (req: Request, res: Response) => {
    const who = sessionOf(req);
    if (!who) return res.status(403).json({ message: 'This account is not attached to an institute.' });
    try {
      return res.json({ results: await wardResults(who.orgId, who.id, req.params.studentId) });
    } catch (err) {
      if (err instanceof GuardianLinkError) {
        return res.status(err.httpStatus).json({ message: err.message, code: err.code });
      }
      return res.status(500).json({ message: 'Could not load results.' });
    }
  },
);

/**
 * Ask to follow another child.
 *
 * Same proof as registration — student code and the student's phone — and the
 * link it creates is PENDING until an administrator verifies it. There is no
 * route that edits an existing link's student.
 */
router.post(
  '/wards/link-request',
  authMiddleware,
  requireRole('parent'),
  guardianVerifyLimiter,
  async (req: Request, res: Response) => {
    const who = sessionOf(req);
    if (!who) return res.status(403).json({ message: 'This account is not attached to an institute.' });
    try {
      const ward = await findWardByCredentials(who.orgId, req.body?.wardCode, req.body?.wardPhone);
      if (!ward) return res.status(400).json({ code: 'WARD_NOT_VERIFIED', message: WARD_NOT_VERIFIED });
      const link = await requestLink({ orgId: who.orgId, parentId: who.id, studentId: ward._id });
      await logAudit(who.id, 'guardian.link.request', String(link._id), { status: link.status });
      return res.status(201).json({
        status: link.status,
        message:
          link.status === 'verified'
            ? 'This student is already linked to your account.'
            : 'Request sent. Your institute will confirm it before the student appears here.',
      });
    } catch {
      return res.status(500).json({ message: 'Could not send the request. Please try again.' });
    }
  },
);

export default router;
