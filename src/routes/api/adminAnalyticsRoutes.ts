import { requireStaffPermission } from '../../middlewares/requirePermission';
import { Router } from 'express';
import { authMiddleware} from '../../middlewares/authMiddleware';
import { getStudentReport } from '../../controllers/adminAnalyticsController';

const router = Router();

// Combined per-student performance report (online + offline) with filters.
// Admin sees all exams; teacher is scoped to exams they created.
router.get(
  '/students/:studentId/report',
  authMiddleware,
  requireStaffPermission('analytics.read'),
  getStudentReport
);

export default router;
