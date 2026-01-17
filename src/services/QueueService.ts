import AttendanceWorker from '../workers/AttendanceWorker';

interface Job {
  id: string;
  data: any;
  timestamp: number;
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
      timestamp: Date.now()
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
        await AttendanceWorker.process(job.data);
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
