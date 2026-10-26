/**
 * Two-factor sign-in for platform staff, end to end over HTTP against the real
 * app (routes/api/platformMfaRoutes, middlewares/platformAuth).
 *
 * Loopback MongoDB only — this suite refuses any other host, scratch-marked or
 * not, because it creates platform staff accounts:
 *
 *   SCRATCH_DB_NAME=iso_platform_scratch_mfa SCRATCH_ALLOW_NEW_DB=true \
 *     npx ts-node --transpile-only scripts/safety/platform-mfa.e2e.test.ts
 *
 * (run through the isolated environment, which points MONGO_URI at a local
 * replica set and sets CONFIG_ENCRYPTION_KEY to a throwaway key).
 */

import { Checks, bootScratchApp, request, scratchUriFor } from './e2eHarness';
import { requireEnv } from './lib';
import { base32Decode, hotp, totpStep } from '../../src/core/auth/totp';
import { signPlatformSession } from '../../src/core/auth/tokens';

const c = new Checks();

function hostOf(uri: string): string {
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/);
  return (m?.[1] ?? '').toLowerCase();
}

function codeFor(secret: string, offsetSteps = 0): string {
  return hotp(base32Decode(secret), totpStep() + offsetSteps);
}

async function main() {
  const target = scratchUriFor(requireEnv('MONGO_URI'));
  const hosts = hostOf(target).split(',');
  if (
    !hosts.every((h) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h))
  ) {
    throw new Error(
      `Refusing to run: this suite creates staff accounts and runs on a loopback MongoDB only (got ${hosts.join(',')}).`,
    );
  }
  if (!process.env.CONFIG_ENCRYPTION_KEY)
    throw new Error(
      'CONFIG_ENCRYPTION_KEY must be set (a throwaway key) for this suite.',
    );

  const app = await bootScratchApp({ PLATFORM_MFA_REQUIRED: 'privileged' });
  const api = (
    method: string,
    path: string,
    opts: Parameters<typeof request>[3] = {},
  ) => request(app.port, method, `/api/platform${path}`, opts);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const PlatformUser = require('../../src/models/PlatformUser').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const PlatformAudit = require('../../src/models/PlatformAudit').default;

  try {
    const stamp = Date.now();
    const pw = `Mfa-${stamp}-pass`;
    const owner = await PlatformUser.create({
      name: 'MFA Owner',
      email: `mfa-owner-${stamp}@iso.test`,
      password: pw,
      role: 'owner',
    });
    const support = await PlatformUser.create({
      name: 'MFA Support',
      email: `mfa-support-${stamp}@iso.test`,
      password: pw,
      role: 'support',
    });
    const owner2 = await PlatformUser.create({
      name: 'MFA Owner 2',
      email: `mfa-owner2-${stamp}@iso.test`,
      password: pw,
      role: 'owner',
    });

    c.section(
      `Required role, not enrolled (PLATFORM_MFA_REQUIRED=privileged, db ${app.dbName})`,
    );
    let r = await api('POST', '/login', {
      body: { email: owner.email, password: pw },
    });
    c.check(
      'owner password login returns an enrollment token and NO session',
      r.status === 200 &&
        r.json.mfaEnrollmentRequired === true &&
        !!r.json.enrollToken &&
        !r.json.token &&
        !r.json.refreshToken,
      r.raw,
    );
    const enrollToken = r.json.enrollToken as string;
    r = await api('POST', '/login', {
      body: { email: owner.email, password: 'wrong' },
    });
    c.check(
      'a wrong password is still the one generic 401',
      r.status === 401 && r.json.message === 'Invalid credentials.',
    );
    r = await api('GET', '/dashboard', { token: enrollToken });
    c.check(
      'the enrollment token is not a console session (403 TOKEN_AUDIENCE_MISMATCH)',
      r.status === 403 && r.json.code === 'TOKEN_AUDIENCE_MISMATCH',
      r.raw,
    );
    r = await api('GET', '/mfa/status', { token: enrollToken });
    c.check(
      '…but it reaches /mfa/status: required, not enabled, available',
      r.status === 200 &&
        r.json.required === true &&
        r.json.enabled === false &&
        r.json.available === true,
      r.raw,
    );

    // A session issued before the requirement existed (signed directly).
    const preexisting = signPlatformSession({
      id: String(owner._id),
      role: 'owner',
      tokenVersion: 0,
    }).token;
    r = await api('GET', '/dashboard', { token: preexisting });
    c.check(
      'a pre-existing owner session is confined: 403 MFA_ENROLLMENT_REQUIRED',
      r.status === 403 && r.json.code === 'MFA_ENROLLMENT_REQUIRED',
      r.raw,
    );
    r = await api('GET', '/mfa/status', { token: preexisting });
    c.check(
      '…and may still reach enrollment',
      r.status === 200 && r.json.required === true,
    );

    c.section('Enrollment');
    r = await api('POST', '/mfa/enroll/start', { token: enrollToken });
    c.check(
      'enroll/start returns a base32 secret and an otpauth:// URI',
      r.status === 200 &&
        /^[A-Z2-7]{32}$/.test(r.json.secret) &&
        String(r.json.otpauthUrl).startsWith('otpauth://totp/'),
      r.raw,
    );
    const secret = r.json.secret as string;
    let doc = await PlatformUser.findById(owner._id).select('+mfa').lean();
    c.check(
      'the pending secret is stored sealed, not in plaintext',
      !!doc.mfa?.pendingSecret &&
        !JSON.stringify(doc.mfa).includes(secret) &&
        doc.mfa.enabled === false,
    );
    r = await api('POST', '/mfa/enroll/confirm', {
      token: enrollToken,
      body: { code: codeFor(secret, 5) },
    });
    c.check(
      'a wrong code does not confirm',
      r.status === 401 && r.json.code === 'MFA_CODE_INVALID',
      r.raw,
    );
    const enrollStep = codeFor(secret);
    r = await api('POST', '/mfa/enroll/confirm', {
      token: enrollToken,
      body: { code: enrollStep },
    });
    c.check(
      'the current code confirms: 10 recovery codes + a session',
      r.status === 200 &&
        Array.isArray(r.json.recoveryCodes) &&
        r.json.recoveryCodes.length === 10 &&
        !!r.json.token &&
        !!r.json.refreshToken,
      r.raw,
    );
    const recoveryCodes = r.json.recoveryCodes as string[];
    const ownerSession = r.json.token as string;
    doc = await PlatformUser.findById(owner._id).select('+mfa').lean();
    c.check(
      'stored: enabled, sealed secret, no pending, 10 hashed codes, tokenVersion bumped',
      doc.mfa.enabled === true &&
        !!doc.mfa.secret &&
        !doc.mfa.pendingSecret &&
        doc.mfa.recoveryCodeHashes.length === 10 &&
        doc.mfa.recoveryCodeHashes.every((h: string) =>
          /^[0-9a-f]{64}$/.test(h),
        ) &&
        !JSON.stringify(doc.mfa).includes(secret) &&
        doc.tokenVersion === 1,
    );
    c.check(
      'finishing required setup from sign-in counts as signing in (lastLoginAt set)',
      !!doc.lastLoginAt,
    );
    r = await api('GET', '/dashboard', { token: preexisting });
    c.check(
      'the password-only session from before enrollment is revoked',
      r.status === 401,
      `${r.status}`,
    );
    r = await api('GET', '/dashboard', { token: ownerSession });
    c.check(
      'the new session works on the console',
      r.status === 200,
      `${r.status} ${r.raw.slice(0, 200)}`,
    );
    r = await api('POST', '/mfa/enroll/start', { token: ownerSession });
    c.check('enrolling again is refused while enabled', r.status === 409);
    r = await api('GET', '/me', { token: ownerSession });
    c.check(
      '/me never carries the MFA record',
      r.status === 200 &&
        !('mfa' in (r.json.user ?? r.json)) &&
        !r.raw.includes('recoveryCodeHashes'),
      r.raw,
    );

    c.section('Signing in with a code');
    r = await api('POST', '/login', {
      body: { email: owner.email, password: pw },
    });
    c.check(
      'an enrolled owner gets a code-step token and NO session',
      r.status === 200 &&
        r.json.mfaRequired === true &&
        !!r.json.mfaToken &&
        !r.json.token,
      r.raw,
    );
    const mfaToken = r.json.mfaToken as string;
    r = await api('GET', '/dashboard', { token: mfaToken });
    c.check(
      'the code-step token is not a console session (403 TOKEN_AUDIENCE_MISMATCH)',
      r.status === 403 && r.json.code === 'TOKEN_AUDIENCE_MISMATCH',
      r.raw,
    );
    r = await api('POST', '/login/mfa', {
      body: { mfaToken, code: enrollStep },
    });
    c.check(
      'the code already used at enrollment is refused (replay)',
      r.status === 401 && r.json.code === 'MFA_CODE_INVALID',
      r.raw,
    );
    r = await api('POST', '/login/mfa', {
      body: { mfaToken: 'not-a-token', code: codeFor(secret, 1) },
    });
    c.check(
      'a forged step token is refused',
      r.status === 401 && r.json.code === 'MFA_STEP_INVALID',
    );
    r = await api('POST', '/login/mfa', {
      body: { mfaToken: enrollToken, code: codeFor(secret, 1) },
    });
    c.check(
      'an enrollment token cannot stand in for the code-step token',
      r.status === 401 && r.json.code === 'MFA_STEP_INVALID',
    );
    r = await api('POST', '/login/mfa', { body: { mfaToken } });
    c.check(
      'no code → 400',
      r.status === 400 && r.json.code === 'MFA_CODE_REQUIRED',
    );
    const nextCode = codeFor(secret, 1); // one step of drift ahead — a later step than enrollment's
    r = await api('POST', '/login/mfa', { body: { mfaToken, code: nextCode } });
    c.check(
      'a fresh code signs in',
      r.status === 200 && !!r.json.token && r.json.user?.role === 'owner',
      r.raw,
    );
    r = await api('POST', '/login/mfa', { body: { mfaToken, code: nextCode } });
    c.check(
      '…and the same code a second time is refused (replay)',
      r.status === 401 && r.json.code === 'MFA_CODE_INVALID',
    );
    r = await api('POST', '/login/mfa', {
      body: { mfaToken, recoveryCode: recoveryCodes[0].toUpperCase() },
    });
    c.check(
      'a recovery code signs in',
      r.status === 200 && !!r.json.token,
      r.raw,
    );
    const recoverySession = r.json.token as string;
    r = await api('POST', '/login/mfa', {
      body: { mfaToken, recoveryCode: recoveryCodes[0] },
    });
    c.check(
      '…once only',
      r.status === 401 && r.json.code === 'MFA_CODE_INVALID',
    );
    r = await api('GET', '/mfa/status', { token: recoverySession });
    c.check(
      'nine recovery codes remain',
      r.status === 200 &&
        r.json.recoveryCodesRemaining === 9 &&
        r.json.enabled === true,
      r.raw,
    );
    r = await api('POST', '/mfa/disable', {
      token: recoverySession,
      body: { code: codeFor(secret, 0) },
    });
    c.check(
      'an owner cannot turn MFA off while policy requires it',
      r.status === 403 && r.json.code === 'MFA_REQUIRED_BY_POLICY',
    );
    r = await api('GET', '/staff', { token: recoverySession });
    const listed = (r.json.staff ?? []) as Array<{
      _id: string;
      mfaEnabled?: boolean;
      mfa?: unknown;
    }>;
    c.check(
      'the staff list says whether MFA is on — and carries nothing of the record',
      r.status === 200 &&
        listed.find((x) => String(x._id) === String(owner._id))?.mfaEnabled ===
          true &&
        listed.find((x) => String(x._id) === String(support._id))
          ?.mfaEnabled === false &&
        listed.every((x) => !('mfa' in x)) &&
        !r.raw.includes('recoveryCodeHashes') &&
        !r.raw.includes('pendingSecret'),
      r.raw.slice(0, 300),
    );
    r = await api('POST', '/staff/' + String(owner._id) + '/mfa/reset', {
      token: recoverySession,
    });
    c.check(
      'an owner cannot reset their own MFA',
      r.status === 403 && r.json.code === 'MFA_SELF_RESET',
    );

    c.section('Optional role (support)');
    r = await api('POST', '/login', {
      body: { email: support.email, password: pw },
    });
    c.check(
      'support (not required) signs in with the password as before',
      r.status === 200 && !!r.json.token && !r.json.mfaRequired,
      r.raw,
    );
    let supportSession = r.json.token as string;
    r = await api('GET', '/mfa/status', { token: supportSession });
    c.check(
      'support status: not required, not enabled',
      r.status === 200 && r.json.required === false && r.json.enabled === false,
    );
    r = await api('POST', '/mfa/enroll/start', { token: supportSession });
    const supportSecret = r.json.secret as string;
    r = await api('POST', '/mfa/enroll/confirm', {
      token: supportSession,
      body: { code: codeFor(supportSecret) },
    });
    c.check(
      'support may enroll voluntarily',
      r.status === 200 && r.json.recoveryCodes?.length === 10,
    );
    supportSession = r.json.token as string;
    r = await api('POST', '/mfa/recovery-codes', {
      token: supportSession,
      body: { code: codeFor(supportSecret, 1) },
    });
    c.check(
      'recovery codes can be regenerated with a fresh code',
      r.status === 200 && r.json.recoveryCodes?.length === 10,
    );
    r = await api('POST', `/staff/${String(owner2._id)}/mfa/reset`, {
      token: supportSession,
    });
    c.check(
      'support cannot reset anyone (needs staff.manage)',
      r.status === 403,
      `${r.status}`,
    );

    c.section('Owner resets a lost device');
    r = await api('POST', `/staff/${String(support._id)}/mfa/reset`, {
      token: recoverySession,
    });
    c.check(
      "an owner resets support's MFA",
      r.status === 200 && r.json.reset === true,
      r.raw,
    );
    r = await api('GET', '/mfa/status', { token: supportSession });
    c.check("…which revokes support's sessions", r.status === 401);
    r = await api('POST', '/login', {
      body: { email: support.email, password: pw },
    });
    c.check(
      '…and support signs in with the password alone again',
      r.status === 200 && !!r.json.token && !r.json.mfaRequired,
    );
    supportSession = r.json.token as string;
    r = await api('POST', '/mfa/disable', {
      token: supportSession,
      body: { code: '123456' },
    });
    c.check(
      'disable when not enabled → 400',
      r.status === 400 && r.json.code === 'MFA_NOT_ENABLED',
    );

    c.section('Audit trail');
    const audits = await PlatformAudit.find({
      entityId: { $in: [String(owner._id), String(support._id)] },
    }).lean();
    const actions = audits.map(
      (a: { action: string; metadata?: { method?: string } }) =>
        `${a.action}${a.metadata?.method ? `:${a.metadata.method}` : ''}`,
    );
    c.check(
      'enabled, logins by method (password / totp / recovery-code), reset — all recorded',
      [
        'platform.mfa.enabled',
        'platform.login:totp-enrollment',
        'platform.login:totp',
        'platform.login:recovery-code',
        'platform.login:password',
        'platform.mfa.reset',
        'platform.mfa.recovery-codes',
      ].every((a) => actions.includes(a)),
      actions.join(', '),
    );
    c.check(
      'no audit entry carries a secret or a recovery code',
      !JSON.stringify(audits).includes(secret) &&
        !recoveryCodes.some((code) => JSON.stringify(audits).includes(code)),
    );

    c.section('Without CONFIG_ENCRYPTION_KEY');
    const key = process.env.CONFIG_ENCRYPTION_KEY;
    delete process.env.CONFIG_ENCRYPTION_KEY;
    r = await api('POST', '/login', {
      body: { email: owner2.email, password: pw },
    });
    const owner2Enroll = r.json.enrollToken as string;
    r = await api('POST', '/mfa/enroll/start', { token: owner2Enroll });
    c.check(
      'enrollment is refused (503 MFA_UNAVAILABLE) — never stored in plaintext',
      r.status === 503 && r.json.code === 'MFA_UNAVAILABLE',
      r.raw,
    );
    r = await api('GET', '/mfa/status', { token: owner2Enroll });
    c.check(
      '…and status says so',
      r.status === 200 && r.json.available === false,
    );
    process.env.CONFIG_ENCRYPTION_KEY = key;

    c.section('PLATFORM_MFA_REQUIRED unset');
    delete process.env.PLATFORM_MFA_REQUIRED;
    r = await api('POST', '/login', {
      body: { email: owner2.email, password: pw },
    });
    c.check(
      'an unenrolled owner signs in with the password as before',
      r.status === 200 && !!r.json.token && !r.json.mfaEnrollmentRequired,
      r.raw,
    );
    r = await api('POST', '/login', {
      body: { email: owner.email, password: pw },
    });
    c.check(
      'an enrolled owner is still asked for a code',
      r.status === 200 && r.json.mfaRequired === true && !r.json.token,
    );
  } finally {
    await app.close();
  }
  c.report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
