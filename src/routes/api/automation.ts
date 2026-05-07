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
  getAvailableFolders,
  streamLogs,
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
// SSE: EventSource can't send headers, so we accept token via query param
router.get('/logs', streamLogs);

// Statistics & Monitoring
router.get('/stats', authMiddleware, requireRole('admin'), getProcessingStats);
router.get('/stats/:id', authMiddleware, requireRole('admin'), getBookProcessingDetails);

// Processing record management (called by automation script)
router.post('/record', authMiddleware, createProcessingRecord);
router.put('/record/:id', authMiddleware, updateProcessingRecord);

export default router;
