import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import { studentProgressOverTime, examInsights } from '../../services/analyticsService';

const router = Router();

// Student can view own progress
router.get('/me/progress', authMiddleware, requireRole('student'), async (req, res) => {
  const data = await studentProgressOverTime((req as any).user.id);
  res.json(data);
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
