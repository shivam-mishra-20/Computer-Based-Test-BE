/**
 * Production-readiness fixes from the 2026-10-16 audit — no database, no
 * network, no Redis.
 *
 *   npx ts-node --transpile-only scripts/safety/ops-hardening.test.ts
 *
 * 1. Readiness (`GET /api/health/ready`): ready only with a connected database
 *    and, where one is started, a listening platform runtime; never reports a
 *    host, port or key. `/api/health` is unchanged.
 * 2. The session-less push-device release route carries its own rate limiter.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { readinessOf } from '../../src/core/health/readiness';
import {
  REQUEST_ID_HEADER,
  requestId,
  requestIdFor,
} from '../../src/middlewares/requestId';
import { errorHandler } from '../../src/middlewares/errorHandler';
import {
  corsPolicyFromEnv,
  corsVerdict,
  isAcceptableSuffix,
} from '../../src/core/http/corsPolicy';
import jwt from 'jsonwebtoken';
import { signSessionPair, signSessionToken } from '../../src/core/auth/tokens';
import {
  legacyTokenNotBefore,
  platformNonRefreshTtl,
  platformRequiresRefresh,
  refusesLongLivedToken,
} from '../../src/core/auth/platformSessionPolicy';
import {
  base32Decode,
  base32Encode,
  hotp,
  newTotpSecret,
  otpauthUri,
  totpStep,
  verifyTotp,
} from '../../src/core/auth/totp';
import {
  hashRecoveryCode,
  isEnrollmentPath,
  matchRecoveryCode,
  mfaRequiredFor,
  mfaRequirement,
  newRecoveryCodes,
  signMfaStepToken,
  verifyMfaStepToken,
} from '../../src/core/auth/platformMfa';
import { signPlatformSession, verifyToken } from '../../src/core/auth/tokens';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

console.log('\nReadiness');
const up = readinessOf({
  mongoReadyState: 1,
  platform: { configured: true, listening: true },
});
check(
  'connected database + listening platform runtime → ready',
  up.ready && up.checks.database === 'up' && up.checks.platform === 'up',
);
check(
  'a process that starts no runtime is ready on the database alone',
  readinessOf({
    mongoReadyState: 1,
    platform: { configured: false, listening: false },
  }).ready,
);
const restarting = readinessOf({
  mongoReadyState: 1,
  platform: { configured: true, listening: false },
});
check(
  'a platform runtime that is starting or crash-looping → NOT ready',
  !restarting.ready && restarting.checks.platform === 'starting',
);
for (const [state, word] of [
  [0, 'down'],
  [2, 'starting'],
  [3, 'down'],
  [99, 'down'],
] as const) {
  const r = readinessOf({
    mongoReadyState: state,
    platform: { configured: false, listening: false },
  });
  check(
    `database readyState ${state} → not ready (${word})`,
    !r.ready && r.checks.database === word,
  );
}
check(
  'the verdict names states only — no host, port, URI or key',
  !/\d{2,5}|mongodb|redis|key|:\/\//i.test(JSON.stringify(up)),
);

const app = readFileSync(join(__dirname, '../../src/app.ts'), 'utf8');
check(
  "/api/health keeps its shape (status 'healthy', timestamp, uptime)",
  /app\.get\('\/api\/health', \(_req, res\) => \{\s*res\.json\(\{\s*status: 'healthy',\s*timestamp: new Date\(\)\.toISOString\(\),\s*uptime: process\.uptime\(\)/.test(
    app,
  ),
);
check(
  '/api/health/ready answers 503 when not ready',
  /app\.get\('\/api\/health\/ready'[\s\S]{0,600}res\.status\(verdict\.ready \? 200 : 503\)/.test(
    app,
  ),
);
const limiter = readFileSync(
  join(__dirname, '../../src/middlewares/rateLimiter.ts'),
  'utf8',
);
check(
  'the readiness probe is exempt from the global limiter, like /api/health',
  /path === '\/api\/health\/ready'/.test(limiter),
);

console.log('\nPush device release');
const routes = readFileSync(
  join(__dirname, '../../src/routes/api/notificationRoutes.ts'),
  'utf8',
);
check(
  'POST /devices/release is rate limited',
  /router\.post\('\/devices\/release',\s*deviceReleaseLimiter,\s*releaseDevice\)/.test(
    routes,
  ),
);
check(
  '…by its own limiter (not shared with sign-in or forms)',
  /export const deviceReleaseLimiter = rateLimit\(\{[\s\S]{0,400}createRedisStore\('rl:device-release:'\)/.test(
    limiter,
  ),
);

console.log('\nCORS — explicitly configured origins only');
const prod = corsPolicyFromEnv({
  NODE_ENV: 'production',
  CORS_ORIGIN: 'https://admin.example.com, https://console.example.com',
  CORS_PREVIEW_SUFFIXES: '-acme-team.vercel.app,.vercel.app',
} as NodeJS.ProcessEnv);
check(
  'a listed origin is allowed',
  corsVerdict('https://admin.example.com', prod) === 'allow',
);
check(
  '…exactly: another scheme or port of it is not',
  corsVerdict('http://admin.example.com', prod) !== 'allow' &&
    corsVerdict('https://admin.example.com:8443', prod) !== 'allow',
);
check(
  'an arbitrary *.vercel.app page is NOT allowed',
  !['allow', 'allow-legacy'].includes(
    corsVerdict('https://evil.vercel.app', prod),
  ),
);
check(
  'an arbitrary *.railway.app page is NOT allowed',
  !['allow', 'allow-legacy'].includes(
    corsVerdict('https://x.up.railway.app', prod),
  ),
);
check(
  "a team's own preview namespace is allowed (https only)",
  corsVerdict('https://app-git-main-acme-team.vercel.app', prod) === 'allow' &&
    corsVerdict('http://app-git-main-acme-team.vercel.app', prod) === 'deny',
);
check(
  'a bare platform suffix is refused as a preview suffix',
  !isAcceptableSuffix('.vercel.app') &&
    !isAcceptableSuffix('railway.app') &&
    isAcceptableSuffix('-acme-team.vercel.app'),
);
check(
  'localhost is refused in production',
  corsVerdict('http://localhost:3000', prod) === 'deny',
);
check(
  'localhost is allowed outside production',
  corsVerdict(
    'http://localhost:4000',
    corsPolicyFromEnv({ NODE_ENV: 'development' } as NodeJS.ProcessEnv),
  ) === 'allow',
);
check(
  'an unknown https origin is left to the organization-domain check',
  corsVerdict('https://learn.someschool.in', prod) === 'check-org-domain',
);
check(
  'a non-http origin is denied',
  corsVerdict('file://x', prod) === 'deny' &&
    corsVerdict('not a url', prod) === 'deny',
);
const transition = corsPolicyFromEnv({
  NODE_ENV: 'production',
  CORS_ORIGIN: 'https://admin.example.com',
  CORS_LEGACY_WILDCARDS: 'true',
} as NodeJS.ProcessEnv);
check(
  'the rollout switch lets the old wildcard through, marked as legacy',
  corsVerdict('https://old-frontend.vercel.app', transition) === 'allow-legacy',
);
const defaults = corsPolicyFromEnv({
  NODE_ENV: 'production',
} as NodeJS.ProcessEnv);
check(
  'with CORS_ORIGIN unset, the historical explicit list still applies',
  corsVerdict('https://abhigyangurukul.com', defaults) === 'allow' &&
    corsVerdict('https://examease-pi.vercel.app', defaults) === 'allow',
);
check(
  'app.ts no longer allows the platform suffixes itself',
  !app.includes("hostname.endsWith('.vercel.app')") &&
    app.includes('corsVerdict(origin, corsPolicy)'),
);

console.log('\nPlatform sessions — no new ten-year tokens');
process.env.JWT_SECRET = 'ops-hardening-test-secret-not-a-real-key-0123456789';
const lifetime = (token: string) => {
  const c = jwt.decode(token) as { iat: number; exp: number };
  return c.exp - c.iat;
};
const DAY = 86400;
process.env.SERVICE_REALM = '';
check(
  '/api (existing realm) keeps the historical 10-year non-refresh token',
  lifetime(signSessionToken({ id: 'u1', role: 'student', tokenVersion: 0 })) ===
    3650 * DAY,
);
check(
  '/api admin sessions stay capped at 30 days',
  lifetime(signSessionToken({ id: 'u1', role: 'admin', tokenVersion: 0 })) ===
    30 * DAY,
);
process.env.SERVICE_REALM = 'platform';
delete process.env.PLATFORM_NONREFRESH_TOKEN_TTL;
check(
  'the platform issues a non-refresh token for 30 days, not ten years',
  lifetime(
    signSessionToken({
      id: 'u1',
      role: 'student',
      orgId: 'o1',
      tokenVersion: 0,
    }),
  ) ===
    30 * DAY,
);
process.env.PLATFORM_NONREFRESH_TOKEN_TTL = '7d';
check(
  '…configurable shorter',
  lifetime(signSessionToken({ id: 'u1', role: 'student', tokenVersion: 0 })) ===
    7 * DAY,
);
process.env.PLATFORM_NONREFRESH_TOKEN_TTL = '3650d';
check(
  '…but never longer than 90 days: an out-of-range value falls back to 30d',
  lifetime(signSessionToken({ id: 'u1', role: 'student', tokenVersion: 0 })) ===
    30 * DAY,
);
process.env.PLATFORM_NONREFRESH_TOKEN_TTL = 'banana';
check('…and a typo falls back to 30d', platformNonRefreshTtl() === '30d');
delete process.env.PLATFORM_NONREFRESH_TOKEN_TTL;
const pair = signSessionPair({
  id: 'u1',
  role: 'student',
  orgId: 'o1',
  tokenVersion: 2,
});
check(
  'the refresh flow is unchanged: 15-minute access + 30-day refresh',
  lifetime(pair.token) === 15 * 60 &&
    lifetime(pair.refreshToken) === 30 * DAY &&
    pair.expiresIn === 900,
);
process.env.SERVICE_REALM = '';
check(
  'refusing non-refresh logins is opt-in (PLATFORM_REQUIRE_REFRESH)',
  !platformRequiresRefresh({} as NodeJS.ProcessEnv) &&
    platformRequiresRefresh({
      PLATFORM_REQUIRE_REFRESH: 'true',
    } as NodeJS.ProcessEnv),
);
const cutoff = Date.parse('2026-11-01T00:00:00Z');
const old10y = {
  iat: Date.parse('2026-10-01T00:00:00Z') / 1000,
  exp: Date.parse('2036-10-01T00:00:00Z') / 1000,
};
check(
  'no cutoff configured: old ten-year tokens are still honoured',
  !refusesLongLivedToken(old10y, legacyTokenNotBefore({} as NodeJS.ProcessEnv)),
);
check(
  'with a cutoff, a ten-year token issued before it is refused',
  refusesLongLivedToken(old10y, cutoff),
);
check(
  '…a capped 30-day token issued before it is not (it lapses on its own)',
  !refusesLongLivedToken(
    { iat: old10y.iat, exp: old10y.iat + 30 * DAY },
    cutoff,
  ),
);
check(
  '…a long token issued AFTER the cutoff is not refused',
  !refusesLongLivedToken(
    { iat: cutoff / 1000 + 60, exp: cutoff / 1000 + 3650 * DAY },
    cutoff,
  ),
);
check(
  '…tokens with an audience (access, refresh) are never caught by it',
  !refusesLongLivedToken(
    { aud: 'tenant', iat: old10y.iat, exp: old10y.exp },
    cutoff,
  ),
);
check(
  '…an unreadable cutoff means no cutoff',
  legacyTokenNotBefore({
    PLATFORM_LEGACY_TOKEN_NOT_BEFORE: 'soon',
  } as NodeJS.ProcessEnv) === null,
);
check(
  'the cutoff is applied in both auth middlewares, platform realm only',
  (
    readFileSync(
      join(__dirname, '../../src/middlewares/authMiddleware.ts'),
      'utf8',
    ).match(/serviceRealm\(\) === 'platform' && refusesLongLivedToken/g) ?? []
  ).length === 2,
);

console.log('\nTwo-factor sign-in for platform staff (TOTP)');
// RFC 6238 Appendix B, SHA-1 seed "12345678901234567890", 8 digits.
const rfcSeed = Buffer.from('12345678901234567890', 'ascii');
const rfcVectors: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];
check(
  'RFC 6238 Appendix B test vectors (SHA-1, 8 digits) all match',
  rfcVectors.every(
    ([t, want]) => hotp(rfcSeed, totpStep(t * 1000), 8) === want,
  ),
  rfcVectors
    .map(
      ([t, want]) =>
        `${t}: ${hotp(rfcSeed, totpStep(t * 1000), 8)} want ${want}`,
    )
    .join(', '),
);
check(
  'RFC 4226 Appendix D: HOTP counter 0 → 755224, counter 9 → 520489',
  hotp(rfcSeed, 0) === '755224' && hotp(rfcSeed, 9) === '520489',
);
const rfcB32 = base32Encode(rfcSeed);
check(
  'base32 round-trips (RFC seed encodes to GEZDGNBVGY3TQOJQ…)',
  rfcB32 === 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' &&
    base32Decode(rfcB32).equals(rfcSeed),
);
const fresh = newTotpSecret();
check(
  'a new secret is 160 bits of base32',
  /^[A-Z2-7]{32}$/.test(fresh) && base32Decode(fresh).length === 20,
);
const t0 = Date.parse('2026-10-16T10:00:15Z');
const codeAt = (ms: number) => hotp(rfcSeed, totpStep(ms));
check(
  'verifyTotp returns the step a current code matches',
  verifyTotp(rfcB32, codeAt(t0), t0) === totpStep(t0),
);
check(
  '…accepts one step of clock drift either side, not two',
  verifyTotp(rfcB32, codeAt(t0 - 30_000), t0) === totpStep(t0) - 1 &&
    verifyTotp(rfcB32, codeAt(t0 + 30_000), t0) === totpStep(t0) + 1 &&
    verifyTotp(rfcB32, codeAt(t0 - 60_000), t0) === null,
);
const wrong = String((Number(codeAt(t0)) + 1) % 1_000_000).padStart(6, '0');
check(
  '…refuses a wrong code',
  verifyTotp(rfcB32, wrong, t0) === null ||
    [codeAt(t0 - 30_000), codeAt(t0 + 30_000)].includes(wrong),
);
check(
  '…refuses malformed input',
  verifyTotp(rfcB32, '12345', t0) === null &&
    verifyTotp(rfcB32, 'abcdef', t0) === null &&
    verifyTotp(rfcB32, '', t0) === null,
);
check(
  '…tolerates the space an app shows mid-code',
  verifyTotp(rfcB32, `${codeAt(t0).slice(0, 3)} ${codeAt(t0).slice(3)}`, t0) ===
    totpStep(t0),
);
const uri = otpauthUri(rfcB32, 'ops@example.com', 'Central Management');
check(
  'otpauth URI names issuer and account and carries the default parameters',
  uri.startsWith('otpauth://totp/Central%20Management%3Aops%40example.com?') &&
    /secret=GEZDGNBVGY3TQOJQ/.test(uri) &&
    /algorithm=SHA1/.test(uri) &&
    /digits=6/.test(uri) &&
    /period=30/.test(uri),
  uri,
);

console.log('\nTwo-factor sign-in: policy, recovery codes and step tokens');
check(
  'PLATFORM_MFA_REQUIRED unset → nothing required',
  mfaRequirement({} as NodeJS.ProcessEnv) === 'none' &&
    !mfaRequiredFor('owner', 'none'),
);
check(
  '=privileged → owner and billing only',
  mfaRequirement({
    PLATFORM_MFA_REQUIRED: 'privileged',
  } as NodeJS.ProcessEnv) === 'privileged' &&
    mfaRequiredFor('owner', 'privileged') &&
    mfaRequiredFor('billing', 'privileged') &&
    !mfaRequiredFor('support', 'privileged') &&
    !mfaRequiredFor('viewer', 'privileged'),
);
check(
  '=all → every role',
  mfaRequirement({ PLATFORM_MFA_REQUIRED: 'all' } as NodeJS.ProcessEnv) ===
    'all' && mfaRequiredFor('viewer', 'all'),
);
check(
  'an unknown value requires nothing (never locks everyone out by typo)',
  mfaRequirement({
    PLATFORM_MFA_REQUIRED: 'yes please',
  } as NodeJS.ProcessEnv) === 'none',
);
const codes = newRecoveryCodes();
check(
  'ten recovery codes, xxxxx-xxxxx, all different',
  codes.length === 10 &&
    codes.every((c) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c)) &&
    new Set(codes).size === 10,
);
const hashes = codes.map(hashRecoveryCode);
check(
  'stored as SHA-256 hashes, never the codes',
  hashes.every((h) => /^[0-9a-f]{64}$/.test(h) && !codes.includes(h)),
);
check(
  'a code matches its own hash (case and spaces ignored)',
  matchRecoveryCode(codes[3].toUpperCase(), hashes) === 3 &&
    matchRecoveryCode(` ${codes[7]} `, hashes) === 7,
);
check(
  'an unknown code matches nothing',
  matchRecoveryCode('aaaaa-aaaaa', hashes) === -1 &&
    matchRecoveryCode('', hashes) === -1,
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ops-hardening-test-secret';
const stepToken = signMfaStepToken('platform-mfa', {
  id: 'staff1',
  tokenVersion: 4,
});
const enrollToken = signMfaStepToken('platform-mfa-enroll', {
  id: 'staff1',
  tokenVersion: 4,
});
const throws = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
check(
  'a code-step token verifies for its own audience',
  verifyMfaStepToken(stepToken, 'platform-mfa').tokenVersion === 4,
);
check(
  '…lives 5 minutes; the enrollment token 15',
  lifetime(stepToken) === 5 * 60 && lifetime(enrollToken) === 15 * 60,
);
check(
  'a code-step token is not an enrollment token, nor the reverse',
  throws(() => verifyMfaStepToken(stepToken, 'platform-mfa-enroll')) &&
    throws(() => verifyMfaStepToken(enrollToken, 'platform-mfa')),
);
check(
  'neither step token is a console session',
  throws(() => verifyToken(stepToken, 'platform')) &&
    throws(() => verifyToken(enrollToken, 'platform')),
);
const realSession = signPlatformSession({
  id: 'staff1',
  role: 'owner',
  tokenVersion: 4,
});
check(
  'a console session is not a step token',
  throws(() => verifyMfaStepToken(realSession.token, 'platform-mfa')) &&
    throws(() => verifyMfaStepToken(realSession.token, 'platform-mfa-enroll')),
);
check(
  'enrollment paths: /api/platform/mfa/* only (as the gateway rewrites /platform-api)',
  isEnrollmentPath('/api/platform/mfa/status') &&
    isEnrollmentPath('/api/platform/mfa/enroll/start?x=1') &&
    !isEnrollmentPath('/api/platform/organizations') &&
    !isEnrollmentPath('/api/platform/mfaX') &&
    !isEnrollmentPath('/api/platform/staff/1/mfa/reset'),
);
const platformRoutesSrc = readFileSync(
  join(__dirname, '../../src/routes/api/platformRoutes.ts'),
  'utf8',
);
const appSrc = readFileSync(join(__dirname, '../../src/app.ts'), 'utf8');
const mfaRoutesSrc = readFileSync(
  join(__dirname, '../../src/routes/api/platformMfaRoutes.ts'),
  'utf8',
);
check(
  'the MFA router is mounted ahead of platformRoutes (whose console guard would refuse the code step)',
  appSrc.indexOf(
    "app.use('/api/platform', requirePlatformDeployment, platformMfaRoutes)",
  ) > -1 &&
    appSrc.indexOf(
      "app.use('/api/platform', requirePlatformDeployment, platformMfaRoutes)",
    ) <
      appSrc.indexOf(
        "app.use('/api/platform', requirePlatformDeployment, platformRoutes)",
      ),
);
// Whitespace-insensitive: a formatter may put each argument on its own line.
const declaresGuards = (method: string, path: string, guards: string[]) => {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(
    `router\\.${method}\\(\\s*'${esc(path)}',\\s*${guards.map(esc).join(',\\s*')},`,
  ).test(mfaRoutesSrc);
};
check(
  'every MFA route names its own guard (nothing inherited)',
  declaresGuards('post', '/login/mfa', ['authLimiter']) &&
    declaresGuards('get', '/mfa/status', ['platformMfaEnrollmentAuth']) &&
    declaresGuards('post', '/mfa/enroll/start', ['platformMfaEnrollmentAuth']) &&
    declaresGuards('post', '/mfa/enroll/confirm', [
      'authLimiter',
      'platformMfaEnrollmentAuth',
    ]) &&
    declaresGuards('post', '/mfa/recovery-codes', [
      'authLimiter',
      'platformAuthMiddleware',
    ]) &&
    declaresGuards('post', '/mfa/disable', ['authLimiter', 'platformAuthMiddleware']) &&
    declaresGuards('post', '/staff/:id/mfa/reset', [
      'platformAuthMiddleware',
      "requirePlatformCapability('staff.manage')",
    ]),
);
check(
  'password login hands out no session to an enrolled or required-but-unenrolled account',
  /if \(staff\.mfa\?\.enabled\) \{\s*return res\.json\(\{\s*mfaRequired: true/.test(
    platformRoutesSrc,
  ) &&
    /if \(mfaRequiredFor\(staff\.role\)\) \{\s*return res\.json\(\{\s*mfaEnrollmentRequired: true/.test(
      platformRoutesSrc,
    ),
);
check(
  'the console guard confines a required-but-unenrolled session to enrollment',
  /mfaRequiredFor\(staff\.role\) && !staff\.mfa\?\.enabled && !isEnrollmentPath/.test(
    readFileSync(
      join(__dirname, '../../src/middlewares/platformAuth.ts'),
      'utf8',
    ),
  ),
);

console.log(
  '\nMonitoring: request ids, structured server errors, crash-loop visibility',
);
check(
  'a well-formed inbound request id is kept',
  requestIdFor('lb-1234abcd') === 'lb-1234abcd',
);
check(
  'a missing, short, long or odd one is replaced with a UUID',
  [
    undefined,
    '',
    'short',
    'x'.repeat(65),
    'has space here',
    '<script>alert(1)</script>',
  ].every((v) => /^[0-9a-f-]{36}$/.test(requestIdFor(v as string | undefined))),
);
{
  const headers: Record<string, string> = {};
  const req = {
    header: (n: string) =>
      n === REQUEST_ID_HEADER ? 'gateway-abc12345' : undefined,
    headers: {} as Record<string, string>,
  };
  const res = { setHeader: (k: string, v: string) => (headers[k] = v) };
  let nextCalled = false;
  requestId(req as never, res as never, () => (nextCalled = true));
  check(
    'the middleware echoes the id and writes it onto the request (the gateway forwards it)',
    nextCalled &&
      headers[REQUEST_ID_HEADER] === 'gateway-abc12345' &&
      req.headers['x-request-id'] === 'gateway-abc12345' &&
      (req as unknown as { requestId: string }).requestId ===
        'gateway-abc12345',
  );
}
{
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) =>
    logged.push(args.map(String).join(' '));
  let status = 0;
  let body: Record<string, unknown> = {};
  const req = {
    method: 'POST',
    path: '/api/exams',
    originalUrl: '/api/exams?token=SECRET',
    requestId: 'req-12345678',
  };
  const res = {
    status: (n: number) => (
      (status = n),
      { json: (b: Record<string, unknown>) => (body = b) }
    ),
  };
  try {
    errorHandler(
      new TypeError('boom'),
      req as never,
      res as never,
      () => undefined,
    );
  } finally {
    console.error = original;
  }
  const line = logged
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .find(Boolean) as Record<string, unknown> | undefined;
  check(
    'a 500 answers with the request id',
    status === 500 && body.requestId === 'req-12345678',
    JSON.stringify(body),
  );
  check(
    '…and logs ONE JSON line: level, requestId, realm, method, path, error',
    !!line &&
      line.level === 'error' &&
      line.requestId === 'req-12345678' &&
      line.method === 'POST' &&
      line.path === '/api/exams' &&
      line.status === 500 &&
      line.error === 'TypeError' &&
      typeof line.realm === 'string',
    JSON.stringify(line),
  );
  check(
    '…without the query string (no tokens in structured logs)',
    !!line && !JSON.stringify(line).includes('SECRET'),
  );
  let status4 = 0;
  const logged4: string[] = [];
  console.error = (...args: unknown[]) => logged4.push(String(args[0]));
  try {
    errorHandler(
      Object.assign(new Error('nope'), { status: 404 }),
      req as never,
      {
        status: (n: number) => ((status4 = n), { json: () => undefined }),
      } as never,
      () => undefined,
    );
  } finally {
    console.error = original;
  }
  check(
    'a 4xx is answered as before and not logged as a server error',
    status4 === 404 && logged4.length === 0,
  );
}
check(
  'readiness reports consecutive platform-runtime restarts (a crash loop is visible)',
  readinessOf({
    mongoReadyState: 1,
    platform: { configured: true, listening: false, restarts: 4 },
  }).checks.platformRestarts === 4 &&
    readinessOf({
      mongoReadyState: 1,
      platform: { configured: true, listening: true, restarts: 0 },
    }).checks.platformRestarts === 0,
);
check(
  '…and omits it where no runtime is started',
  !(
    'platformRestarts' in
    readinessOf({
      mongoReadyState: 1,
      platform: { configured: false, listening: false },
    }).checks
  ),
);
check(
  'the request id is mounted before the gateway and exposed to browsers',
  (() => {
    const app = readFileSync(join(__dirname, '../../src/app.ts'), 'utf8');
    return (
      app.indexOf('app.use(requestId);') > -1 &&
      app.indexOf('app.use(requestId);') <
        app.indexOf("app.use('/platform-api', createPlatformGateway") &&
      /exposedHeaders: \[[^\]]*'X-Request-Id'/.test(app)
    );
  })(),
);

console.log(`\n  ${checks - failures}/${checks} checks passed.\n`);
process.exit(failures ? 1 : 0);
