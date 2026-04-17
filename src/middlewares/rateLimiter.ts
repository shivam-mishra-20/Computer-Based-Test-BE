import rateLimit from 'express-rate-limit';
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

/**
 * Global API rate limiter - prevents abuse
 */
export const globalLimiter = rateLimit({
  windowMs: envNumber('GLOBAL_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  max: envNumber('GLOBAL_RATE_LIMIT_MAX', 1000),
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:global:'),
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/health' || req.path === '/api/health';
  }
});

/**
 * Authentication endpoints - stricter limiting
 */
export const authLimiter = rateLimit({
  windowMs: envNumber('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  max: envNumber('AUTH_RATE_LIMIT_MAX', 10),
  message: 'Too many authentication attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:auth:'),
  skipSuccessfulRequests: true, // Don't count successful logins
});

/**
 * Upload endpoints - prevent file spam
 */
export const uploadLimiter = rateLimit({
  windowMs: envNumber('UPLOAD_RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000),
  max: envNumber('UPLOAD_RATE_LIMIT_MAX', 50),
  message: 'Upload limit exceeded, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:upload:'),
});

/**
 * Message/Chat endpoints - prevent spam
 */
export const messageLimiter = rateLimit({
  windowMs: envNumber('MESSAGE_RATE_LIMIT_WINDOW_MS', 1 * 60 * 1000),
  max: envNumber('MESSAGE_RATE_LIMIT_MAX', 30),
  message: 'Message rate limit exceeded, slow down',
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:message:'),
});

/**
 * AI/Expensive endpoints - resource protection
 */
export const aiLimiter = rateLimit({
  windowMs: envNumber('AI_RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000),
  max: envNumber('AI_RATE_LIMIT_MAX', 20),
  message: 'AI service limit exceeded, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:ai:'),
});

/**
 * Password reset endpoints should always be counted because responses are
 * intentionally generic and usually return 200 to prevent account enumeration.
 */
export const passwordResetLimiter = rateLimit({
  windowMs: envNumber('PASSWORD_RESET_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  max: envNumber('PASSWORD_RESET_RATE_LIMIT_MAX', 8),
  message: 'Too many password reset attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:password-reset:'),
});
