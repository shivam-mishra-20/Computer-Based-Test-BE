import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

// Redis Configuration for Socket.IO adapter and caching
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Publisher client for Socket.IO adapter
export const redisPublisher = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 2000);
    console.log(`Redis reconnect attempt ${times}, delay: ${delay}ms`);
    return delay;
  },
  lazyConnect: false,
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true; // Reconnect 
    }
    return 1; // Always reconnect
  }
});

// Subscriber client for Socket.IO adapter (separate connection required)
export const redisSubscriber = redisPublisher.duplicate();

// General purpose Redis client for caching + rate limiting.
// commandTimeout ensures a stalled Redis can't hang the per-request rate-limit
// check (globalLimiter runs on every request). Paired with the limiters'
// passOnStoreError:true, a slow/broken Redis degrades OPEN instead of 500ing
// the whole API. Only this client is tuned — the pub/sub clients used by the
// Socket.IO adapter keep their defaults. (For TLS Redis, use a rediss:// URL —
// ioredis enables TLS automatically from the scheme.)
export const redisClient = redisPublisher.duplicate({
  commandTimeout: Number(process.env.REDIS_COMMAND_TIMEOUT_MS) || 5000,
  maxRetriesPerRequest: 3,
});

// Connection event handlers
redisPublisher.on('connect', () => console.log('✅ Redis Publisher connected'));
redisPublisher.on('error', (err) => console.error('❌ Redis Publisher error:', err));

redisSubscriber.on('connect', () => console.log('✅ Redis Subscriber connected'));
redisSubscriber.on('error', (err) => console.error('❌ Redis Subscriber error:', err));

redisClient.on('connect', () => console.log('✅ Redis Client connected'));
redisClient.on('error', (err) => console.error('❌ Redis Client error:', err));

// Graceful shutdown
export const closeRedis = async () => {
  await Promise.all([
    redisPublisher.quit(),
    redisSubscriber.quit(),
    redisClient.quit(),
  ]);
  console.log('Redis connections closed');
};

// Cache helper functions
export const cacheService = {
  /**
   * Get cached value with automatic JSON parsing
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await redisClient.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error(`Cache GET error for key ${key}:`, error);
      return null;
    }
  },

  /**
   * Set cache with TTL (in seconds)
   */
  async set(key: string, value: any, ttl: number = 300): Promise<void> {
    try {
      await redisClient.setex(key, ttl, JSON.stringify(value));
    } catch (error) {
      console.error(`Cache SET error for key ${key}:`, error);
    }
  },

  /**
   * Delete cache key
   */
  async del(key: string): Promise<void> {
    try {
      await redisClient.del(key);
    } catch (error) {
      console.error(`Cache DEL error for key ${key}:`, error);
    }
  },

  /**
   * Delete all keys matching pattern
   */
  async delPattern(pattern: string): Promise<void> {
    try {
      const keys = await redisClient.keys(pattern);
      if (keys.length > 0) {
        await redisClient.del(...keys);
      }
    } catch (error) {
      console.error(`Cache DEL pattern error for ${pattern}:`, error);
    }
  },

  /**
   * Check if key exists
   */
  async exists(key: string): Promise<boolean> {
    try {
      return (await redisClient.exists(key)) === 1;
    } catch (error) {
      console.error(`Cache EXISTS error for key ${key}:`, error);
      return false;
    }
  },
};

export default redisClient;
