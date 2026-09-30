import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import RedisStore from 'rate-limit-redis';
import { isRedisEnabled, redisClient } from '../config/redis';

const envNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Helper function for Redis rate limiting - ioredis type compatibility wrapper
/**
 * A Redis-backed store, or `undefined` to let express-rate-limit use its own
 * in-memory one.
 *
 * Returning undefined is a real fallback, not a failure: per-process limiting
 * still stops abuse, it just isn't shared across workers. That is strictly
 * better than every request waiting on a Redis command timeout — and better
 * than the server dying at boot because `rate-limit-redis` floated its
 * `SCRIPT LOAD` rejection with nothing to catch it.
 */
const createRedisStore = (prefix: string) => {
  if (!isRedisEnabled) return undefined;
  return new RedisStore({
    // @ts-expect-error - ioredis call() returns Promise<unknown>, but rate-limit-redis expects Promise<RedisReply>
    sendCommand: (...args: string[]) =>
      redisClient.call(args[0], ...args.slice(1)).catch((error: Error) => {
        // Surfaced, then rethrown so the limiter's own passOnStoreError path
        // decides what to do. Swallowing it here would make a dead Redis look
        // like a working rate limiter.
        console.error(`⚠️ Rate limit store unavailable (${prefix}):`, error?.message);
        throw error;
      }),
    // The platform runtime counts its own traffic (REDIS_KEY_NAMESPACE, empty
    // for the existing system — its counters keep their names).
    prefix: `${(process.env.REDIS_KEY_NAMESPACE || '').trim()}${prefix}`,
  });
};

// ── Why these limiters look the way they do ─────────────────────────────────
// The app sits behind Railway's proxy (trust proxy = 1), so the rate-limit key
// is the CLIENT'S PUBLIC IP. Whole schools / coaching centres (one office
// Wi-Fi) and mobile carriers (CGNAT) present hundreds of students under a
// SINGLE public IP. A per-IP limit therefore throttles an entire venue/carrier
// at once — which looked like "works on some networks, fails on others".
//
// Fixes applied here:
//  1. passOnStoreError: true  → a Redis blip NEVER 500s the API; rate limiting
//     degrades open instead of taking the whole site down (globalLimiter runs
//     on every request, so a fail-closed store == full outage).
//  2. Limits raised to survive a shared venue, and tunable via env.
//  3. Auth / password-reset are keyed PER-ACCOUNT (ip+email), so one student's
//     failed logins can't lock out everyone else on the same Wi-Fi.
//  4. Upload/message/AI are keyed PER-USER once authenticated (falling back to
//     IP only for the few pre-auth routes).
//  5. Live-exam traffic (attempts/exams/tests/scholarship/practice) is exempt
//     from the global IP limiter so an exam hall is never throttled.

/** Per-user key once authenticated; falls back to IP (+email if present) for
 *  pre-auth routes so a shared venue IP is never a single bucket. */
const userOrIpKey = (req: Request): string => {
  const uid = (req as any).user?.id;
  if (uid) return `u:${uid}`;
  const email = String((req.body && (req.body as any).email) || '').toLowerCase().trim();
  const ip = req.ip || 'unknown';
  return email ? `${ip}|${email}` : ip;
};

/** Account-scoped key for pre-auth flows (login/register/password reset): the
 *  email is the real bucket, so other users on the same IP are unaffected. */
const accountKey = (req: Request): string => {
  const email = String((req.body && (req.body as any).email) || '').toLowerCase().trim();
  const ip = req.ip || 'unknown';
  return email ? `${ip}|${email}` : ip;
};

// Live-exam / test-taking paths must never be throttled by shared-IP limits.
const EXAM_PATH_PREFIXES = ['/api/attempts', '/api/exams', '/api/tests', '/api/scholarship', '/api/practice-tests'];
const isExemptPath = (path: string): boolean =>
  path === '/health' ||
  path === '/api/health' ||
  EXAM_PATH_PREFIXES.some((p) => path.startsWith(p));

/**
 * Global API rate limiter — DDoS/abuse net only. Set high enough that a whole
 * school/coaching-centre behind one NAT IP never trips it during normal use.
 */
export const globalLimiter = rateLimit({
  windowMs: envNumber('GLOBAL_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  max: envNumber('GLOBAL_RATE_LIMIT_MAX', 30000),
  message: 'Too many requests from this network, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:global:'),
  passOnStoreError: true,
  skip: (req) => isExemptPath(req.path),
});

/**
 * Authentication endpoints — stricter, but keyed PER ACCOUNT (ip+email) so a
 * shared venue IP can't lock everyone out. Only failed attempts count.
 */
export const authLimiter = rateLimit({
  windowMs: envNumber('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  max: envNumber('AUTH_RATE_LIMIT_MAX', 30),
  message: 'Too many authentication attempts for this account, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:auth:'),
  passOnStoreError: true,
  skipSuccessfulRequests: true, // Don't count successful logins
  keyGenerator: accountKey,
  validate: false, // custom keyGenerator (ip+email) — suppress IPv6 keygen warning
});

/**
 * Upload endpoints — keyed per-user once authenticated (IP fallback for the
 * one public pre-auth upload route).
 */
export const uploadLimiter = rateLimit({
  windowMs: envNumber('UPLOAD_RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000),
  max: envNumber('UPLOAD_RATE_LIMIT_MAX', 200),
  message: 'Upload limit exceeded, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:upload:'),
  passOnStoreError: true,
  keyGenerator: userOrIpKey,
  validate: false,
});

/**
 * Public (unauthenticated) form submissions — e.g. class requests. Keyed by IP
 * since there is no user. Deliberately tight: a real person submits a handful
 * of these, so a low ceiling blunts scripted spam without affecting anyone.
 */
/**
 * Failed attempts to identify a ward, per device.
 *
 * A parent proves a relationship with a student code and the student's phone
 * number. Each wrong guess is refused with the same message, but without a
 * limit an attacker holding a seating chart could simply try phone numbers.
 * Keyed by IP rather than account, because the attacker chooses the account
 * email and would rotate it. Successful matches do not count, and requests that
 * are not a parent's are not seen at all.
 */
export const guardianVerifyLimiter = rateLimit({
  windowMs: envNumber('GUARDIAN_VERIFY_WINDOW_MS', 60 * 60 * 1000),
  max: envNumber('GUARDIAN_VERIFY_MAX', 10),
  message: { message: 'Too many attempts to verify a student from this device. Please try again later.', code: 'WARD_VERIFY_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:guardian-verify:'),
  passOnStoreError: true,
  skipSuccessfulRequests: true,
  skip: (req) => {
    const role = String((req.body as { role?: unknown } | undefined)?.role ?? '').toLowerCase();
    return !(role === 'parent' || req.path.includes('link-request'));
  },
  validate: false,
});

export const publicFormLimiter = rateLimit({
  windowMs: envNumber('PUBLIC_FORM_RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000),
  max: envNumber('PUBLIC_FORM_RATE_LIMIT_MAX', 20),
  // JSON, not a bare string. express-rate-limit sends a string as text/plain,
  // and every client here reads `data.message` from JSON — so the one message
  // that most needs to be read ("you are rate limited, wait") arrived as an
  // unparseable body and surfaced as the browser's own "Too Many Requests".
  message: { message: 'Too many submissions from this device, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:public-form:'),
  passOnStoreError: true,
  validate: false,
});

/**
 * AGTS registration — the one AGTS route that creates rows (a lead and an
 * attempt with its own question selection).
 *
 * Sized above `publicFormLimiter` on purpose: a school or coaching centre may
 * run AGTS for a whole class from one Wi-Fi address (see the note at the top
 * of this file). The per-phone ceiling in agtsService is the tighter control.
 */
export const agtsRegisterLimiter = rateLimit({
  windowMs: envNumber('AGTS_REGISTER_RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000),
  max: envNumber('AGTS_REGISTER_RATE_LIMIT_MAX', 60),
  message: { message: 'Too many test registrations from this network. Please try again in a little while.', code: 'AGTS_RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:agts-register:'),
  passOnStoreError: true,
  validate: false,
});

/**
 * AGTS answer traffic, keyed by ATTEMPT rather than by IP, so a hall of
 * candidates on one address is never throttled together while a single
 * attempt cannot be hammered. A real candidate saves each answer a handful of
 * times; the ceiling is far above that.
 */
export const agtsAttemptLimiter = rateLimit({
  windowMs: envNumber('AGTS_ATTEMPT_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  max: envNumber('AGTS_ATTEMPT_RATE_LIMIT_MAX', 900),
  message: { message: 'Too many requests for this test. Please slow down.', code: 'AGTS_RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:agts-attempt:'),
  passOnStoreError: true,
  keyGenerator: (req: Request) => `attempt:${String(req.params?.attemptId || '').slice(0, 40)}`,
  validate: false,
});

/**
 * Working on a draft you already hold the token for.
 *
 * ── Why this is not `publicFormLimiter` ─────────────────────────────────────
 * That limiter is sized for a SUBMISSION — "a real person submits a handful of
 * these", which is true of the one-shot class-request and call-back forms it
 * was written for. The institute onboarding application is not a submission;
 * it is a nine-step form that autosaves on every step and re-reads the draft on
 * every page load. One person filling it in once costs about a dozen requests:
 * a create, eight saves, a submit, and a resume for each reload. Against a
 * ceiling of twenty an hour, the SECOND honest attempt from the same address is
 * refused — and on a coaching centre's office Wi-Fi or a CGNAT carrier, that
 * address is shared by everyone in the building. See the note at the top of
 * this file: this is the same failure mode, on the one route that was added
 * after it was written.
 *
 * ── Why a high ceiling here is not a hole ───────────────────────────────────
 * These three routes are guarded by the draft token, not by the limiter. An
 * id without its token gets the same 404 as an id that does not exist, so
 * there is nothing here to spam that possession of a 43-character secret does
 * not already gate. The endpoints that CREATE a row — the call-back form and
 * `POST /organization-applications` — keep the tight ceiling, because that is
 * where the spam actually lands. `globalLimiter` still applies underneath.
 */
export const draftEditLimiter = rateLimit({
  windowMs: envNumber('DRAFT_EDIT_RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000),
  max: envNumber('DRAFT_EDIT_RATE_LIMIT_MAX', 300),
  message: { message: 'Too many changes from this device, please try again in a few minutes' },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:draft-edit:'),
  passOnStoreError: true,
  validate: false,
});

/**
 * Message/Chat endpoints — per-user (all message routes are authenticated).
 */
export const messageLimiter = rateLimit({
  windowMs: envNumber('MESSAGE_RATE_LIMIT_WINDOW_MS', 1 * 60 * 1000),
  max: envNumber('MESSAGE_RATE_LIMIT_MAX', 60),
  message: 'Message rate limit exceeded, slow down',
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:message:'),
  passOnStoreError: true,
  keyGenerator: userOrIpKey,
  validate: false,
});

/**
 * AI/Expensive endpoints — per-user (all AI routes are authenticated).
 */
export const aiLimiter = rateLimit({
  windowMs: envNumber('AI_RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000),
  max: envNumber('AI_RATE_LIMIT_MAX', 60),
  message: 'AI service limit exceeded, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:ai:'),
  passOnStoreError: true,
  keyGenerator: userOrIpKey,
  validate: false,
});

/**
 * Password reset endpoints — keyed per account (ip+email). Responses are
 * intentionally generic (usually 200) so successful requests are still counted.
 */
export const passwordResetLimiter = rateLimit({
  windowMs: envNumber('PASSWORD_RESET_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  max: envNumber('PASSWORD_RESET_RATE_LIMIT_MAX', 15),
  message: 'Too many password reset attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:password-reset:'),
  passOnStoreError: true,
  keyGenerator: accountKey,
  validate: false,
});
