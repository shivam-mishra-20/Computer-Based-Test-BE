/**
 * Two-factor sign-in routes for platform staff (core/auth/platformMfa).
 *
 *   POST /login/mfa                 code step: { mfaToken, code | recoveryCode } → session
 *   GET  /mfa/status                enrolled? required? recovery codes left?
 *   POST /mfa/enroll/start          a new secret (pending) and its otpauth:// URI
 *   POST /mfa/enroll/confirm        { code } → enabled, recovery codes (once), new session
 *   POST /mfa/recovery-codes        { code } → a fresh set of recovery codes
 *   POST /mfa/disable               { code } → disabled (refused when policy requires MFA)
 *   POST /staff/:id/mfa/reset       another staff member's MFA, for a lost device (staff.manage)
 *
 * Its own router, mounted at /api/platform BEFORE platformRoutes (app.ts):
 * platformRoutes guards everything after /login with the console session, and
 * the code step has no session yet, while enrollment may be reached with the
 * short enrollment token a required-but-unenrolled login returns. So every
 * route here names its own guard — nothing is inherited.
 */

import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { authLimiter } from '../../middlewares/rateLimiter';
import {
  platformAuthMiddleware,
  requirePlatformCapability,
  type PlatformRequestUser,
} from '../../middlewares/platformAuth';
import PlatformUserModel, {
  platformCapabilities,
} from '../../models/PlatformUser';
import { recordPlatformAction } from '../../core/platform/audit';
import {
  completePlatformSignIn,
  platformSessionBody,
} from '../../core/platform/platformSignIn';
import {
  decryptSecret,
  encryptionAvailable,
  encryptSecret,
} from '../../core/config/secrets';
import { newTotpSecret, otpauthUri, verifyTotp } from '../../core/auth/totp';
import {
  hashRecoveryCode,
  matchRecoveryCode,
  MFA_ISSUER,
  MFA_UNAVAILABLE,
  mfaRequiredFor,
  newRecoveryCodes,
  verifyMfaStepToken,
} from '../../core/auth/platformMfa';

type StaffRequest = Request & {
  platformUser?: PlatformRequestUser;
  viaEnrollToken?: boolean;
};

const INVALID_CODE = {
  message:
    'That code is not valid. Check the time on your device and try again.',
  code: 'MFA_CODE_INVALID',
};

async function loadStaff(id: string) {
  return PlatformUserModel.findById(id).select('+mfa');
}

/** A session, OR the short enrollment token a required-but-unenrolled login returns. */
export function platformMfaEnrollmentAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const raw = (req.header('Authorization') || '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  let claims: { id: string; tokenVersion: number } | null = null;
  try {
    claims = verifyMfaStepToken(raw, 'platform-mfa-enroll');
  } catch {
    claims = null;
  }
  if (!claims) return platformAuthMiddleware(req, res, next);
  const { id, tokenVersion } = claims;
  return PlatformUserModel.findById(id)
    .lean()
    .then((staff) => {
      if (
        !staff ||
        !staff.isActive ||
        (Number(staff.tokenVersion ?? 0) || 0) !== tokenVersion
      ) {
        return res
          .status(401)
          .json({ message: 'Please sign in again.', code: 'MFA_STEP_INVALID' });
      }
      (req as StaffRequest).platformUser = {
        id: String(staff._id),
        role: staff.role,
        capabilities: platformCapabilities(staff.role),
      };
      (req as StaffRequest).viaEnrollToken = true;
      return next();
    })
    .catch(() =>
      res
        .status(401)
        .json({ message: 'Please sign in again.', code: 'MFA_STEP_INVALID' }),
    );
}

/** Verify a TOTP code against a sealed secret, refusing a step already used. */
function acceptCode(
  sealed: unknown,
  code: string,
  lastUsedStep: number,
): number | null {
  if (!sealed) return null;
  const step = verifyTotp(decryptSecret(sealed as never), code);
  if (step === null || step <= lastUsedStep) return null;
  return step;
}

const router = Router();

// ── The code step of sign-in ─────────────────────────────────────────────
router.post('/login/mfa', authLimiter, async (req: Request, res: Response) => {
  let claims: { id: string; tokenVersion: number };
  try {
    claims = verifyMfaStepToken(
      String(req.body?.mfaToken ?? ''),
      'platform-mfa',
    );
  } catch {
    return res
      .status(401)
      .json({
        message: 'Your sign-in expired. Enter your email and password again.',
        code: 'MFA_STEP_INVALID',
      });
  }
  try {
    const staff = await loadStaff(claims.id);
    if (
      !staff ||
      !staff.isActive ||
      (Number(staff.tokenVersion ?? 0) || 0) !== claims.tokenVersion ||
      !staff.mfa?.enabled
    ) {
      return res
        .status(401)
        .json({
          message: 'Your sign-in expired. Enter your email and password again.',
          code: 'MFA_STEP_INVALID',
        });
    }
    const code = String(req.body?.code ?? '').trim();
    const recovery = String(req.body?.recoveryCode ?? '').trim();
    if (code) {
      const step = acceptCode(
        staff.mfa.secret,
        code,
        Number(staff.mfa.lastUsedStep ?? 0),
      );
      if (step === null) return res.status(401).json(INVALID_CODE);
      staff.mfa.lastUsedStep = step;
      staff.markModified('mfa');
      return completePlatformSignIn(req, res, staff, 'totp');
    }
    if (recovery) {
      const hashes = staff.mfa.recoveryCodeHashes ?? [];
      const index = matchRecoveryCode(recovery, hashes);
      if (index < 0) return res.status(401).json(INVALID_CODE);
      staff.mfa.recoveryCodeHashes = hashes.filter((_, i) => i !== index);
      staff.markModified('mfa');
      return completePlatformSignIn(req, res, staff, 'recovery-code');
    }
    return res
      .status(400)
      .json({
        message: 'Enter the 6-digit code or a recovery code.',
        code: 'MFA_CODE_REQUIRED',
      });
  } catch (error) {
    console.error('[platform/login/mfa] failed:', (error as Error).message);
    return res.status(500).json({ message: 'Sign-in failed.' });
  }
});

// ── Enrollment and management of one's own MFA ───────────────────────────
router.get(
  '/mfa/status',
  platformMfaEnrollmentAuth,
  async (req: Request, res: Response) => {
    const actor = (req as StaffRequest).platformUser!;
    const staff = await loadStaff(actor.id);
    if (!staff) return res.status(404).json({ message: 'Account not found.' });
    return res.json({
      enabled: Boolean(staff.mfa?.enabled),
      required: mfaRequiredFor(staff.role),
      recoveryCodesRemaining: (staff.mfa?.recoveryCodeHashes ?? []).length,
      available: encryptionAvailable(),
    });
  },
);

router.post(
  '/mfa/enroll/start',
  platformMfaEnrollmentAuth,
  async (req: Request, res: Response) => {
    if (!encryptionAvailable())
      return res
        .status(MFA_UNAVAILABLE.status)
        .json({ message: MFA_UNAVAILABLE.message, code: MFA_UNAVAILABLE.code });
    const actor = (req as StaffRequest).platformUser!;
    const staff = await loadStaff(actor.id);
    if (!staff) return res.status(404).json({ message: 'Account not found.' });
    if (staff.mfa?.enabled)
      return res
        .status(409)
        .json({
          message: 'Two-factor sign-in is already on.',
          code: 'MFA_ALREADY_ENABLED',
        });
    const secret = newTotpSecret();
    staff.mfa = {
      ...(staff.mfa ?? { enabled: false }),
      enabled: false,
      pendingSecret: encryptSecret(secret),
      pendingAt: new Date(),
    };
    staff.markModified('mfa');
    await staff.save();
    return res.json({
      secret,
      otpauthUrl: otpauthUri(secret, staff.email, MFA_ISSUER),
      issuer: MFA_ISSUER,
      account: staff.email,
    });
  },
);

router.post(
  '/mfa/enroll/confirm',
  authLimiter,
  platformMfaEnrollmentAuth,
  async (req: Request, res: Response) => {
    const actor = (req as StaffRequest).platformUser!;
    const staff = await loadStaff(actor.id);
    if (!staff) return res.status(404).json({ message: 'Account not found.' });
    if (staff.mfa?.enabled)
      return res
        .status(409)
        .json({
          message: 'Two-factor sign-in is already on.',
          code: 'MFA_ALREADY_ENABLED',
        });
    const pending = staff.mfa?.pendingSecret;
    if (!pending)
      return res
        .status(400)
        .json({ message: 'Start setup again.', code: 'MFA_NOT_STARTED' });
    const step = acceptCode(pending, String(req.body?.code ?? ''), 0);
    if (step === null) return res.status(401).json(INVALID_CODE);
    const recoveryCodes = newRecoveryCodes();
    staff.mfa = {
      enabled: true,
      secret: pending,
      pendingSecret: null,
      pendingAt: null,
      lastUsedStep: step,
      recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
      enabledAt: new Date(),
    };
    staff.markModified('mfa');
    // Every session signed in with the password alone ends now.
    staff.tokenVersion = (Number(staff.tokenVersion ?? 0) || 0) + 1;
    // Reached from sign-in (the enrollment token), this IS the sign-in: the
    // session below is the first this account gets.
    const signingIn = Boolean((req as StaffRequest).viaEnrollToken);
    if (signingIn) staff.lastLoginAt = new Date();
    await staff.save();
    await recordPlatformAction(req, {
      action: 'platform.mfa.enabled',
      entity: 'PlatformUser',
      entityId: String(staff._id),
    });
    if (signingIn) {
      await recordPlatformAction(req, {
        action: 'platform.login',
        entity: 'PlatformUser',
        entityId: String(staff._id),
        metadata: { method: 'totp-enrollment' },
      });
    }
    return res.json({ recoveryCodes, ...platformSessionBody(staff) });
  },
);

router.post(
  '/mfa/recovery-codes',
  authLimiter,
  platformAuthMiddleware,
  async (req: Request, res: Response) => {
    const actor = (req as StaffRequest).platformUser!;
    const staff = await loadStaff(actor.id);
    if (!staff?.mfa?.enabled)
      return res
        .status(400)
        .json({
          message: 'Two-factor sign-in is not on.',
          code: 'MFA_NOT_ENABLED',
        });
    const step = acceptCode(
      staff.mfa.secret,
      String(req.body?.code ?? ''),
      Number(staff.mfa.lastUsedStep ?? 0),
    );
    if (step === null) return res.status(401).json(INVALID_CODE);
    const recoveryCodes = newRecoveryCodes();
    staff.mfa.lastUsedStep = step;
    staff.mfa.recoveryCodeHashes = recoveryCodes.map(hashRecoveryCode);
    staff.markModified('mfa');
    await staff.save();
    await recordPlatformAction(req, {
      action: 'platform.mfa.recovery-codes',
      entity: 'PlatformUser',
      entityId: String(staff._id),
    });
    return res.json({ recoveryCodes });
  },
);

router.post(
  '/mfa/disable',
  authLimiter,
  platformAuthMiddleware,
  async (req: Request, res: Response) => {
    const actor = (req as StaffRequest).platformUser!;
    const staff = await loadStaff(actor.id);
    if (!staff?.mfa?.enabled)
      return res
        .status(400)
        .json({
          message: 'Two-factor sign-in is not on.',
          code: 'MFA_NOT_ENABLED',
        });
    if (mfaRequiredFor(staff.role)) {
      return res
        .status(403)
        .json({
          message: 'Your role requires two-factor sign-in.',
          code: 'MFA_REQUIRED_BY_POLICY',
        });
    }
    const step = acceptCode(
      staff.mfa.secret,
      String(req.body?.code ?? ''),
      Number(staff.mfa.lastUsedStep ?? 0),
    );
    if (step === null) return res.status(401).json(INVALID_CODE);
    staff.mfa = {
      enabled: false,
      secret: null,
      pendingSecret: null,
      pendingAt: null,
      lastUsedStep: 0,
      recoveryCodeHashes: [],
      enabledAt: null,
    };
    staff.markModified('mfa');
    staff.tokenVersion = (Number(staff.tokenVersion ?? 0) || 0) + 1;
    await staff.save();
    await recordPlatformAction(req, {
      action: 'platform.mfa.disabled',
      entity: 'PlatformUser',
      entityId: String(staff._id),
    });
    return res.json({ disabled: true, ...platformSessionBody(staff) });
  },
);

// ── Resetting ANOTHER staff member's MFA (a lost device) ─────────────────
router.post(
  '/staff/:id/mfa/reset',
  platformAuthMiddleware,
  requirePlatformCapability('staff.manage'),
  async (req: Request, res: Response) => {
    const actor = (req as StaffRequest).platformUser!;
    if (String(req.params.id) === actor.id) {
      return res
        .status(403)
        .json({
          message:
            'Ask another administrator to reset your two-factor sign-in.',
          code: 'MFA_SELF_RESET',
        });
    }
    const staff = await loadStaff(String(req.params.id)).catch(() => null);
    if (!staff)
      return res.status(404).json({ message: 'Staff account not found.' });
    staff.mfa = {
      enabled: false,
      secret: null,
      pendingSecret: null,
      pendingAt: null,
      lastUsedStep: 0,
      recoveryCodeHashes: [],
      enabledAt: null,
    };
    staff.markModified('mfa');
    staff.tokenVersion = (Number(staff.tokenVersion ?? 0) || 0) + 1;
    await staff.save();
    await recordPlatformAction(req, {
      action: 'platform.mfa.reset',
      entity: 'PlatformUser',
      entityId: String(staff._id),
    });
    return res.json({ reset: true });
  },
);

export default router;
