/**
 * Platform-staff authentication for /api/platform/*.
 *
 * ── The structural guarantee ────────────────────────────────────────────────
 * This rejects on TOKEN AUDIENCE before touching roles, permissions or the
 * database. A tenant user's token — however privileged inside their own
 * organization, and however broken tenant RBAC might one day be — cannot reach
 * a platform route, because it fails at the door.
 *
 * That is the whole reason platform staff live in a separate collection with a
 * separate audience rather than as a fourth value in the tenant role enum.
 */

import { NextFunction, Request, Response } from 'express';
import { verifyToken, TokenAudienceMismatch } from '../core/auth/tokens';
import { platformCapabilities, satisfiesCapability } from '../models/PlatformUser';

export interface PlatformRequestUser {
  id: string;
  role: string;
  capabilities: string[];
}

export async function platformAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const raw = req.header('Authorization')?.replace('Bearer ', '').trim();

  if (!raw || raw === 'null' || raw === 'undefined' || raw.length < 20) {
    return res.status(401).json({ message: 'Platform credentials required.' });
  }

  let claims: { id: string; role: string; tokenVersion?: number };
  try {
    claims = verifyToken<{ id: string; role: string; tokenVersion?: number; aud?: string }>(
      raw,
      'platform',
    );
  } catch (error) {
    if (error instanceof TokenAudienceMismatch) {
      // 403 rather than 401: the credential is valid, it is simply not valid
      // HERE. Distinguishing the two makes the failure diagnosable while
      // revealing nothing — the caller already knows which token they sent.
      return res.status(403).json({
        message: 'This credential cannot be used for platform administration.',
        code: 'TOKEN_AUDIENCE_MISMATCH',
      });
    }
    return res.status(401).json({ message: 'Invalid or expired platform credentials.' });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const PlatformUser = require('../models/PlatformUser').default;
    const staff = await PlatformUser.findById(claims.id).lean();

    if (!staff || !staff.isActive) {
      return res.status(401).json({ message: 'Platform account not found or disabled.' });
    }

    // Revocation: bumping tokenVersion invalidates every outstanding token for
    // this account immediately, without waiting for expiry.
    if (typeof claims.tokenVersion === 'number' && claims.tokenVersion !== staff.tokenVersion) {
      return res.status(401).json({
        message: 'Credentials have been revoked.',
        code: 'TOKEN_REVOKED',
      });
    }

    (req as Request & { platformUser?: PlatformRequestUser }).platformUser = {
      id: String(staff._id),
      role: staff.role,
      capabilities: platformCapabilities(staff.role),
    };
    return next();
  } catch (error) {
    console.error('[platformAuth] failed:', (error as Error).message);
    return res.status(401).json({ message: 'Platform authentication failed.' });
  }
}

/** Require a specific platform capability, e.g. subscription.manage. */
export function requirePlatformCapability(capability: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const staff = (req as Request & { platformUser?: PlatformRequestUser }).platformUser;
    if (!staff) return res.status(401).json({ message: 'Platform credentials required.' });
    if (!satisfiesCapability(staff.capabilities, capability)) {
      return res.status(403).json({
        message: 'Your platform role does not permit this.',
        code: 'PLATFORM_CAPABILITY_DENIED',
        required: capability,
      });
    }
    return next();
  };
}
