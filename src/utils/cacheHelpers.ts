/**
 * Backend Caching Helpers
 * Provides caching utilities for Express routes
 */

import { Request, Response, NextFunction } from 'express';
import { cacheService } from '../config/redis';

interface CacheOptions {
  /** Cache TTL in seconds */
  ttl?: number;
  /** Cache key generator function */
  keyFn?: (req: Request) => string;
  /** Alias for keyFn — the name route call sites use */
  customKey?: (req: Request) => string;
  /** Condition to enable caching */
  condition?: (req: Request) => boolean;
  /** Invalidate cache on specific patterns */
  invalidateOn?: string[];
}

/**
 * Generate cache key from request
 */
export function generateCacheKey(req: Request, prefix: string = 'api'): string {
  const userId = (req as any).user?.id || 'anonymous';
  const path = req.path;
  const query = JSON.stringify(req.query);
  const body = req.method === 'GET' ? '' : JSON.stringify(req.body);
  
  return `${prefix}:${userId}:${path}:${query}:${body}`;
}

/**
 * Cache middleware for Express routes
 * 
 * Usage:
 * router.get('/courses', cacheMiddleware({ ttl: 300 }), controller)
 */
export function cacheMiddleware(options: CacheOptions = {}) {
  const {
    ttl = 300,
    condition = () => true,
  } = options;
  // Accept either `keyFn` or the `customKey` alias that route call sites use.
  const keyFn = options.keyFn || options.customKey || ((req: Request) => generateCacheKey(req));

  return async (req: Request, res: Response, next: NextFunction) => {
    // Only cache GET requests by default
    if (req.method !== 'GET') {
      return next();
    }

    // Check condition
    if (!condition(req)) {
      return next();
    }

    const cacheKey = keyFn(req);

    try {
      // Try to get from cache
      const cached = await cacheService.get(cacheKey);

      if (cached !== null) {
        console.log(`[Cache] HIT: ${cacheKey}`);
        
        // Add cache header
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cache-Key', cacheKey);
        
        return res.json(cached);
      }

      console.log(`[Cache] MISS: ${cacheKey}`);
      res.setHeader('X-Cache', 'MISS');

      // Store original json method
      const originalJson = res.json.bind(res);

      // Override json method to cache response
      res.json = function(data: any) {
        // Cache the response
        cacheService.set(cacheKey, data, ttl).catch(err => {
          console.error('[Cache] Failed to cache response:', err);
        });

        // Call original json method
        return originalJson(data);
      };

      next();
    } catch (error) {
      console.error('[Cache] Error in cache middleware:', error);
      next();
    }
  };
}

/**
 * Invalidate cache on mutation
 * 
 * Usage:
 * router.post('/courses', invalidateCacheOn(['courses']), controller)
 */
export function invalidateCacheOn(arg: string[] | { patterns?: string[] }) {
  // Route call sites pass `{ patterns: [...] }`; also accept a bare string[].
  const patterns: string[] = Array.isArray(arg) ? arg : arg?.patterns ?? [];
  return async (req: Request, res: Response, next: NextFunction) => {
    // Store original methods
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    const invalidate = async () => {
      for (const pattern of patterns) {
        try {
          await cacheService.delPattern(`*${pattern}*`);
          console.log(`[Cache] Invalidated pattern: ${pattern}`);
        } catch (error) {
          console.error(`[Cache] Failed to invalidate ${pattern}:`, error);
        }
      }
    };

    // Override json method
    res.json = function(data: any) {
      // Only invalidate on successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        invalidate().catch(err => {
          console.error('[Cache] Invalidation error:', err);
        });
      }
      return originalJson(data);
    };

    // Override send method
    res.send = function(data: any) {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        invalidate().catch(err => {
          console.error('[Cache] Invalidation error:', err);
        });
      }
      return originalSend(data);
    };

    next();
  };
}

/**
 * Helper to wrap controller with caching
 */
export function withCache<T>(
  fetcher: () => Promise<T>,
  key: string,
  ttl: number = 300
): Promise<T> {
  return cacheService.get<T>(key).then(async (cached) => {
    if (cached !== null) {
      return cached;
    }

    const data = await fetcher();
    await cacheService.set(key, data, ttl);
    return data;
  });
}

/**
 * User-specific cache key generator
 */
export function userCacheKey(userId: string, resource: string, id?: string): string {
  return id ? `user:${userId}:${resource}:${id}` : `user:${userId}:${resource}`;
}

/**
 * Global cache key generator
 */
export function globalCacheKey(resource: string, id?: string): string {
  return id ? `global:${resource}:${id}` : `global:${resource}`;
}
