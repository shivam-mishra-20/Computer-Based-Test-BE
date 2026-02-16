import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redisClient } from '../config/redis';

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
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // 1000 requests per 15 min per IP
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
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per 15 min
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
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // 50 uploads per hour
  message: 'Upload limit exceeded, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:upload:'),
});

/**
 * Message/Chat endpoints - prevent spam
 */
export const messageLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // 30 messages per minute
  message: 'Message rate limit exceeded, slow down',
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:message:'),
});

/**
 * AI/Expensive endpoints - resource protection
 */
export const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 AI requests per hour
  message: 'AI service limit exceeded, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('rl:ai:'),
});
