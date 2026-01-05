import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import {
  addResult,
  addBulkResults,
  getStudentResults,
  getAllResults,
  updateResult,
  deleteResult,
  getResultStats
} from '../../controllers/resultController';

const router = Router();

// Teacher/Admin routes - add results
router.post('/add', authMiddleware, requireRole('teacher', 'admin'), addResult);
router.post('/bulk-add', authMiddleware, requireRole('teacher', 'admin'), addBulkResults);

// View results - students can view their own, teachers/admin can view all
router.get('/student', authMiddleware, getStudentResults);
router.get('/all', authMiddleware, requireRole('teacher', 'admin'), getAllResults);

// Statistics - teachers/admin only
router.get('/stats', authMiddleware, requireRole('teacher', 'admin'), getResultStats);

// Update and delete - teachers/admin only
router.put('/:id', authMiddleware, requireRole('teacher', 'admin'), updateResult);
router.delete('/:id', authMiddleware, requireRole('teacher', 'admin'), deleteResult);

export default router;
