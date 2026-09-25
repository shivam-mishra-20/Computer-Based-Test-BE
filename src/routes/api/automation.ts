import { requireLegacyDataOwner } from '../../middlewares/orgScopeGates';
import { requireStaffPermission } from '../../middlewares/requirePermission';
import { NextFunction, Request, Response, Router } from 'express';
import { authMiddleware} from '../../middlewares/authMiddleware';
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
router.get('/status', authMiddleware, requireStaffPermission('org.integrations'), requireLegacyDataOwner('EPUB automation'), getAutomationStatus);
router.post('/toggle', authMiddleware, requireStaffPermission('org.integrations'), requireLegacyDataOwner('EPUB automation'), toggleAutomation);
router.post('/trigger', authMiddleware, requireStaffPermission('org.integrations'), requireLegacyDataOwner('EPUB automation'), triggerProcessing);
router.post('/stop', authMiddleware, requireStaffPermission('org.integrations'), requireLegacyDataOwner('EPUB automation'), stopAutomation);
router.post('/status/reset', authMiddleware, resetAutomationStatus);
router.get('/folders', authMiddleware, requireStaffPermission('org.integrations'), requireLegacyDataOwner('EPUB automation'), getAvailableFolders);
// SSE: EventSource can't send headers, so we accept token via query param
// EventSource cannot set headers, so the log stream takes its token from the
// query string — and is then held to exactly the same checks as every other
// automation route. It used to accept ANY valid token: any organization's
// student could stream the original institute's automation logs.
const tokenFromQuery = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.headers.authorization && typeof req.query.token === 'string') {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
};
router.get('/logs', tokenFromQuery, authMiddleware, requireStaffPermission('org.integrations'), requireLegacyDataOwner('EPUB automation'), streamLogs);

// Statistics & Monitoring
router.get('/stats', authMiddleware, requireStaffPermission('org.integrations'), requireLegacyDataOwner('EPUB automation'), getProcessingStats);
router.get('/stats/:id', authMiddleware, requireStaffPermission('org.integrations'), requireLegacyDataOwner('EPUB automation'), getBookProcessingDetails);

// Processing record management (called by automation script)
router.post('/record', authMiddleware, createProcessingRecord);
router.put('/record/:id', authMiddleware, updateProcessingRecord);

export default router;
