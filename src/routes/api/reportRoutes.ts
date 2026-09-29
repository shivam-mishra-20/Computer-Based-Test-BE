import { requireStaffPermission } from '../../middlewares/requirePermission';
import { Router } from 'express';
import { authMiddleware} from '../../middlewares/authMiddleware';
import { attendanceReport, suspiciousLogs, resultsCsv } from '../../controllers/reportController';

const router = Router();

router.get('/exams/:examId/attendance', authMiddleware, requireStaffPermission('reports.read'), attendanceReport);
router.get('/exams/:examId/logs', authMiddleware, requireStaffPermission('reports.read'), suspiciousLogs);
router.get('/exams/:examId/results.csv', authMiddleware, requireStaffPermission('reports.export'), resultsCsv);

export default router;
