import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import { studentProgressOverTime, examInsights, getStudentAnalytics } from '../../services/analyticsService';

const router = Router();

// Student can view own progress (Detailed Analytics)
router.get('/me/progress', authMiddleware, requireRole('student'), async (req, res) => {
  try {
    const mode: any = req.query.mode || (req.query.includeOffline === 'true' ? 'combined' : 'online');
    const data = await getStudentAnalytics((req as any).user.id, mode);
    res.json(data);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to fetch analytics' });
  }
});

// Teacher/Admin can view exam insights
router.get('/exams/:examId/insights', authMiddleware, requireRole('teacher', 'admin'), async (req, res) => {
  try {
    const data = await examInsights(req.params.examId);
    res.json(data);
  } catch (err: any) {
    res.status(400).json({ message: err.message || 'Failed to compute insights' });
  }
});

export default router;
