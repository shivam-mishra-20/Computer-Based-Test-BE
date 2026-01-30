import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import {
  bulkImportQuestions,
  getAutomationStatus,
  toggleAutomation,
  getProcessingStats,
  getBookProcessingDetails,
  createProcessingRecord,
  updateProcessingRecord,
  triggerProcessing,
  stopAutomation,
  resetAutomationStatus,
  getSchedule,
  updateSchedule,
  getAvailableFolders
} from '../../controllers/automationController';

const router = Router();

// Bulk import endpoint (can be called by n8n or internal processes)
router.post('/bulk-import-questions', authMiddleware, bulkImportQuestions);

// Supervision & Control endpoints (Admin only)
router.get('/status', authMiddleware, requireRole('admin'), getAutomationStatus);
router.post('/toggle', authMiddleware, requireRole('admin'), toggleAutomation);
router.post('/trigger', authMiddleware, requireRole('admin'), triggerProcessing);
router.post('/stop', authMiddleware, requireRole('admin'), stopAutomation);
router.post('/status/reset', authMiddleware, resetAutomationStatus);
router.get('/folders', authMiddleware, requireRole('admin'), getAvailableFolders);

// Statistics & Monitoring
router.get('/stats', authMiddleware, requireRole('admin'), getProcessingStats);
router.get('/stats/:id', authMiddleware, requireRole('admin'), getBookProcessingDetails);

// Processing record management (called by automation script)
router.post('/record', authMiddleware, createProcessingRecord);
router.put('/record/:id', authMiddleware, updateProcessingRecord);

// Schedule management (Admin only)
router.get('/schedule', authMiddleware, requireRole('admin'), getSchedule);
router.put('/schedule', authMiddleware, requireRole('admin'), updateSchedule);

export default router;
