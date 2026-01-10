// Metrics routes for observability
import { Router, Request, Response } from 'express';
import { getQueueMetrics, getRecentJobs } from '../../services/jobQueue';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { requireRole } from '../../middlewares/authMiddleware';

const router = Router();

// Get queue metrics (admin only)
router.get('/queue', authMiddleware, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const metrics = getQueueMetrics();
    const recentJobs = getRecentJobs(10);
    
    res.json({
      metrics,
      recentJobs: recentJobs.map(job => ({
        id: job.id,
        type: job.type,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        error: job.error
      }))
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
router.get('/health', (req: Request, res: Response) => {
  const metrics = getQueueMetrics();
  
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    queue: {
      pending: metrics.pending,
      processing: metrics.processing
    }
  });
});

export default router;
