// Simple in-memory job queue for background tasks
// For production, consider Bull (Redis-based) or Agenda.js

import { logger } from '../utils/logger';

export type JobStatus = 'pending' | 'processing' | 'done' | 'failed';
export type JobType = 'youtube_meta_fetch';

export interface Job<T = any> {
  id: string;
  type: JobType;
  payload: T;
  status: JobStatus;
  createdAt: Date;
  updatedAt: Date;
  error?: string;
  retryCount: number;
}

export interface YouTubeMetaJobPayload {
  videoId: string;
  courseId: string;
  moduleIndex: number;
  lectureIndex: number;
}

// In-memory job storage
const jobs: Map<string, Job> = new Map();
let jobIdCounter = 0;

// Job handlers registry
const jobHandlers: Map<JobType, (payload: any) => Promise<void>> = new Map();

export function registerJobHandler(type: JobType, handler: (payload: any) => Promise<void>): void {
  jobHandlers.set(type, handler);
  logger.info('Job handler registered', { type });
}

export function enqueue<T>(type: JobType, payload: T): string {
  const id = `job_${Date.now()}_${++jobIdCounter}`;
  const job: Job<T> = {
    id,
    type,
    payload,
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
    retryCount: 0
  };
  
  jobs.set(id, job);
  logger.info('Job enqueued', { id, type });
  
  // Process immediately in background
  setImmediate(() => processJob(id));
  
  return id;
}

async function processJob(id: string): Promise<void> {
  const job = jobs.get(id);
  if (!job || job.status !== 'pending') return;
  
  const handler = jobHandlers.get(job.type);
  if (!handler) {
    logger.error('No handler for job type', { type: job.type });
    job.status = 'failed';
    job.error = 'No handler registered';
    job.updatedAt = new Date();
    return;
  }
  
  job.status = 'processing';
  job.updatedAt = new Date();
  logger.info('Processing job', { id: job.id, type: job.type });
  
  try {
    await handler(job.payload);
    job.status = 'done';
    job.updatedAt = new Date();
    logger.info('Job completed', { id: job.id, type: job.type });
  } catch (error: any) {
    job.retryCount++;
    job.error = error.message;
    job.updatedAt = new Date();
    
    if (job.retryCount < 3) {
      job.status = 'pending';
      logger.warn('Job failed, will retry', { id: job.id, retryCount: job.retryCount, error: error.message });
      // Retry after delay
      setTimeout(() => processJob(id), 5000 * job.retryCount);
    } else {
      job.status = 'failed';
      logger.error('Job failed permanently', { id: job.id, error: error.message });
    }
  }
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export interface QueueMetrics {
  pending: number;
  processing: number;
  done: number;
  failed: number;
  total: number;
}

export function getQueueMetrics(): QueueMetrics {
  const metrics: QueueMetrics = {
    pending: 0,
    processing: 0,
    done: 0,
    failed: 0,
    total: jobs.size
  };
  
  for (const job of jobs.values()) {
    metrics[job.status]++;
  }
  
  return metrics;
}

export function getRecentJobs(limit: number = 20): Job[] {
  return Array.from(jobs.values())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}

// Cleanup old completed jobs (run periodically)
export function cleanupOldJobs(maxAgeMins: number = 60): number {
  const cutoff = Date.now() - maxAgeMins * 60 * 1000;
  let removed = 0;
  
  for (const [id, job] of jobs.entries()) {
    if (job.status === 'done' && job.updatedAt.getTime() < cutoff) {
      jobs.delete(id);
      removed++;
    }
  }
  
  if (removed > 0) {
    logger.info('Cleaned up old jobs', { removed });
  }
  
  return removed;
}

// Start periodic cleanup
setInterval(() => cleanupOldJobs(60), 30 * 60 * 1000);
