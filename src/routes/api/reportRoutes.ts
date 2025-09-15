import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import { attendanceReport, suspiciousLogs, resultsCsv } from '../../controllers/reportController';

const router = Router();

router.get('/exams/:examId/attendance', authMiddleware, requireRole('teacher', 'admin'), attendanceReport);
router.get('/exams/:examId/logs', authMiddleware, requireRole('teacher', 'admin'), suspiciousLogs);
router.get('/exams/:examId/results.csv', authMiddleware, requireRole('teacher', 'admin'), resultsCsv);

export default router;
