import { requireStaffPermission } from '../../middlewares/requirePermission';
import { requireExamOwner } from '../../middlewares/examOwnership';
import { Router } from 'express';
import { authMiddleware} from '../../middlewares/authMiddleware';
import { attendanceReport, suspiciousLogs, resultsCsv } from '../../controllers/reportController';

const router = Router();

// An exam's reports: its creator or an admin.
router.get('/exams/:examId/attendance', authMiddleware, requireStaffPermission('reports.read'), requireExamOwner('examId'), attendanceReport);
router.get('/exams/:examId/logs', authMiddleware, requireStaffPermission('reports.read'), requireExamOwner('examId'), suspiciousLogs);
router.get('/exams/:examId/results.csv', authMiddleware, requireStaffPermission('reports.export'), requireExamOwner('examId'), resultsCsv);

export default router;
