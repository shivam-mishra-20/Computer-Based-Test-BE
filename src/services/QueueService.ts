import AttendanceWorker from '../workers/AttendanceWorker';
import { currentOrgId, runWithTenant } from '../core/tenancy';

interface Job {
  id: string;
  data: any;
  timestamp: number;
  /**
   * The organization this job belongs to, captured when it was ENQUEUED.
   *
   * A job is processed later, on a different tick, from a queue drain loop that
   * has no request behind it. Whatever context happens to be open at that
   * moment belongs to some other request entirely — inheriting it would
   * attribute Tenant A's attendance sync to whoever happened to trigger the
   * drain. The owning tenant therefore travels WITH the job.
   */
  orgId: string | null;
}

class QueueService {
  private static instance: QueueService;
  private queue: Job[] = [];
  private isProcessing = false;

  private constructor() {}

  public static getInstance(): QueueService {
    if (!QueueService.instance) {
      QueueService.instance = new QueueService();
    }
    return QueueService.instance;
  }

  public async add(data: any): Promise<void> {
    const job: Job = {
      id: Math.random().toString(36).substring(7),
      data,
      timestamp: Date.now(),
      // Captured HERE, at enqueue time, while the caller's context is still open.
      orgId: currentOrgId(),
    };
    this.queue.push(job);
    console.log(`Job added to queue: ${job.id}`);
    
    // Trigger processing if idle
    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  private async processQueue() {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      return;
    }

    this.isProcessing = true;
    const job = this.queue.shift();

    if (job) {
      try {
        console.log(`Processing job: ${job.id}`);
        // Simulate async processing
        await new Promise(resolve => setTimeout(resolve, 100));
        // A FRESH context from the job's own orgId — never the ambient one.
        // When orgId is null the job predates tenancy (or was enqueued before
        // Org 001 existed); running it uncontextualized preserves exactly
        // today's behaviour, and under enforce it will throw, which is the
        // correct signal that the backfill has to finish first.
        if (job.orgId) {
          await runWithTenant(
            { orgId: job.orgId, source: 'job' },
            () => AttendanceWorker.process(job.data),
          );
        } else {
          await AttendanceWorker.process(job.data);
        }
        console.log(`Job completed: ${job.id}`);
      } catch (error) {
        console.error(`Job failed: ${job.id}`, error);
        // Simple retry logic: push back to end of queue if it's a transient error?
        // For now, just log to AuditLog (handled inside Worker usually)
      }
    }

    // Process next job immediately
    setImmediate(() => this.processQueue());
  }
}

export default QueueService.getInstance();
