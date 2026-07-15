import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import RedisStore from 'rate-limit-redis';
import { redisClient } from '../config/redis';

const envNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Helper function for Redis rate limiting - ioredis type compatibility wrapper
const createRedisStore = (prefix: string) => {
  return new RedisStore({
    // @ts-expect-error - ioredis call() returns Promise<unknown>, but rate-limit-redis expects Promise<RedisReply>
    sendCommand: (...args: string[]) => redisClient.call(args[0], ...args.slice(1)),
    prefix,
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
