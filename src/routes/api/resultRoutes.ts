import { requireStaffPermission } from '../../middlewares/requirePermission';
import { Router } from 'express';
import { authMiddleware} from '../../middlewares/authMiddleware';
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
router.post('/add', authMiddleware, requireStaffPermission('results.publish'), addResult);
router.post('/bulk-add', authMiddleware, requireStaffPermission('results.publish'), addBulkResults);

// View results - students can view their own, teachers/admin can view all
router.get('/student', authMiddleware, getStudentResults);
router.get('/all', authMiddleware, requireStaffPermission('results.read'), getAllResults);

// Statistics - teachers/admin only
router.get('/stats', authMiddleware, requireStaffPermission('results.read'), getResultStats);

// Update and delete - teachers/admin only
router.put('/:id', authMiddleware, requireStaffPermission('results.override'), updateResult);
router.delete('/:id', authMiddleware, requireStaffPermission('results.override'), deleteResult);

export default router;
