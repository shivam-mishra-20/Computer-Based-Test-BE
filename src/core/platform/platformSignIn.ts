/**
 * Finishing a console sign-in — one definition for the password step (no MFA)
 * and the code step (MFA), so both issue the same session, record the same
 * audit entry and return the same body.
 */

import type { Request, Response } from 'express';
import { signPlatformSession } from '../auth/tokens';
import { recordPlatformAction } from './audit';
import { platformCapabilities } from '../../models/PlatformUser';
import type { PlatformRequestUser } from '../../middlewares/platformAuth';

interface StaffDoc {
  _id: unknown;
  name: string;
  email: string;
  role: string;
  tokenVersion?: number;
  lastLoginAt?: Date;
  save: () => Promise<unknown>;
}

export function platformSessionBody(staff: {
  _id: unknown;
  name: string;
  email: string;
  role: string;
  tokenVersion?: number;
}) {
  const session = signPlatformSession({
    id: String(staff._id),
    role: staff.role,
    tokenVersion: staff.tokenVersion,
  });
  // No password, no hash, no tokenVersion, nothing of the MFA record.
  return {
    token: session.token,
    refreshToken: session.refreshToken,
    expiresIn: session.expiresIn,
    user: {
      id: String(staff._id),
      name: staff.name,
      email: staff.email,
      role: staff.role,
      capabilities: platformCapabilities(staff.role),
    },
  };
}

export async function completePlatformSignIn(
  req: Request,
  res: Response,
  staff: StaffDoc,
  method: 'password' | 'totp' | 'recovery-code',
) {
  const body = platformSessionBody(staff);
  staff.lastLoginAt = new Date();
  await staff.save();
  // The guard did not run on sign-in routes; authentication has just
  // succeeded, so this IS who acted.
  (req as Request & { platformUser?: PlatformRequestUser }).platformUser = {
    id: String(staff._id),
    role: staff.role,
    capabilities: platformCapabilities(staff.role),
  };
  await recordPlatformAction(req, {
    action: 'platform.login',
    entity: 'PlatformUser',
    entityId: String(staff._id),
    metadata: { method },
  });
  return res.json(body);
}
