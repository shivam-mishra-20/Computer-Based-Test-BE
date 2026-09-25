/**
 * Sessions and one-time account links, under /api/auth.
 *
 *   POST /refresh               a refreshable session's next access token
 *   POST /logout-all            sign this account out everywhere
 *   POST /accept-invite         set a password from an invitation link
 *   POST /reset-password-link   set a password from a reset link
 *
 * The three pre-authentication routes are allowlisted (core/tenancy/
 * publicRoutes): each carries its own credential — a refresh token, or a
 * one-time link token — and names exactly one account.
 */

import { Router, Request, Response } from 'express';
import User from '../../models/User';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { authLimiter, passwordResetLimiter } from '../../middlewares/rateLimiter';
import { signSessionPair, verifyRefreshToken } from '../../core/auth/tokens';
import { withoutTenantScope } from '../../core/tenancy/context';
import { orgStateOf } from '../../core/tenancy/orgState';
import { LinkRefused, redeem, revokeSessions } from '../../core/accounts/accountLinks';
import { logAudit } from '../../utils/logger';

const router = Router();

/**
 * Exchange a refresh token for a new pair. The refresh token ROTATES: the old
 * one keeps working until it expires (stateless), but a revocation — any bump
 * of tokenVersion — kills every refresh token at once.
 */
router.post('/refresh', authLimiter, async (req: Request, res: Response) => {
  let claims: { id: string; tv?: number; orgId?: string };
  try {
    claims = verifyRefreshToken(String(req.body?.refreshToken ?? ''));
  } catch {
    return res.status(401).json({ message: 'Please sign in again.', code: 'REFRESH_INVALID' });
  }
  const user = (await withoutTenantScope('auth:refresh', async () =>
    User.findById(claims.id).select('role status orgId tokenVersion').lean(),
  )) as { _id: unknown; role?: string; status?: string; orgId?: string; tokenVersion?: number } | null;
  const version = Number(user?.tokenVersion ?? 0) || 0;
  if (!user || claims.tv !== version || user.status !== 'approved') {
    return res.status(401).json({ message: 'Please sign in again.', code: 'SESSION_REVOKED' });
  }
  if (user.orgId) {
    const state = await orgStateOf(String(user.orgId));
    if (!state.exists || state.deleting) {
      return res.status(401).json({ message: 'Please sign in again.', code: 'ORG_UNAVAILABLE' });
    }
  }
  return res.json(
    signSessionPair({ id: String(user._id), role: user.role, orgId: user.orgId ?? null, tokenVersion: version }),
  );
});

router.post('/logout-all', authMiddleware, async (req: Request, res: Response) => {
  const current = (req as Request & { user?: { id?: string } }).user;
  if (!current?.id) return res.status(401).json({ message: 'Unauthorized' });
  await revokeSessions(current.id);
  await logAudit(current.id, 'auth.sessions.revoke-all', current.id, {});
  return res.json({ message: 'Signed out everywhere.' });
});

function refusal(res: Response, err: unknown) {
  if (err instanceof LinkRefused) return res.status(err.httpStatus).json({ message: err.message, code: err.code });
  console.error('[account-link] failed:', (err as Error).message);
  return res.status(500).json({ message: 'Could not complete this. Please try again.' });
}

router.post('/accept-invite', passwordResetLimiter, async (req: Request, res: Response) => {
  try {
    const { email } = await redeem('invite', req.body?.token, req.body?.password);
    return res.json({ message: 'Your password is set. You can sign in now.', email });
  } catch (err) {
    return refusal(res, err);
  }
});

router.post('/reset-password-link', passwordResetLimiter, async (req: Request, res: Response) => {
  try {
    const { email } = await redeem('reset', req.body?.token, req.body?.password);
    return res.json({ message: 'Your password was changed. Please sign in again.', email });
  } catch (err) {
    return refusal(res, err);
  }
});

export default router;
