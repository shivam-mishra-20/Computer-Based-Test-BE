/**
 * An organization's administrators reviewing parent ↔ student links.
 *
 * The organization is the administrator's OWN, from the signed token — there is
 * no parameter that names one — so an administrator of one institute cannot
 * see, verify or revoke another's links. Verifying a link also approves the
 * parent's pending account (see core/guardians `verifyLink`).
 */

import { requireStaffPermission } from '../../middlewares/requirePermission';
import { Router, Request, Response } from 'express';
import { authMiddleware} from '../../middlewares/authMiddleware';
import { GuardianLinkError, listLinks, revokeLink, verifyLink } from '../../core/guardians/guardians';
import { logAudit } from '../../utils/logger';

const router = Router();

function adminOf(req: Request): { id: string; orgId: string } | null {
  const user = (req as Request & { user?: { id?: string; orgId?: string } }).user;
  if (!user?.id || !user.orgId) return null;
  return { id: String(user.id), orgId: String(user.orgId) };
}

router.get('/', authMiddleware, requireStaffPermission('guardians.manage'), async (req: Request, res: Response) => {
  const who = adminOf(req);
  if (!who) return res.status(403).json({ message: 'This account is not attached to an institute.' });
  return res.json({ links: await listLinks(who.orgId, String(req.query.status ?? '')) });
});

function decide(action: 'verify' | 'revoke') {
  return async (req: Request, res: Response) => {
    const who = adminOf(req);
    if (!who) return res.status(403).json({ message: 'This account is not attached to an institute.' });
    try {
      const actor = { id: who.id, kind: 'org-admin' as const };
      const link =
        action === 'verify'
          ? await verifyLink(who.orgId, req.params.id, actor)
          : await revokeLink(who.orgId, req.params.id, actor);
      await logAudit(who.id, `guardian.link.${action}`, String(link._id), { status: link.status });
      return res.json({ id: String(link._id), status: link.status });
    } catch (err) {
      if (err instanceof GuardianLinkError) {
        return res.status(err.httpStatus).json({ message: err.message, code: err.code });
      }
      return res.status(500).json({ message: 'Could not update the link.' });
    }
  };
}

router.post('/:id/verify', authMiddleware, requireStaffPermission('guardians.manage'), decide('verify'));
router.post('/:id/revoke', authMiddleware, requireStaffPermission('guardians.manage'), decide('revoke'));

export default router;
