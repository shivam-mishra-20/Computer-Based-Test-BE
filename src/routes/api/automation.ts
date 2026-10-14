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

// Bulk import endpoint (called by the automation runner, QuestMl, n8n). It writes
// questions into the bank, so it needs the same permissions as importing them by
// hand; it used to need only a sign-in, so a student could add questions.
// Importing on behalf of another user is checked in the handler.
router.post('/bulk-import-questions', authMiddleware, requireStaffPermission('questions.import', 'questions.create'), bulkImportQuestions);

// Supervision & Control endpoints (Admin only)
router.get('/status', authMiddleware, requireStaffPermission('org.integrations'), requireLegacyDataOwner('EPUB automation'), getAutomationStatus);
router.post('/toggle', authMiddleware, requireStaffPermission('org.integrations'), requireLegacyDataOwner('EPUB automation'), toggleAutomation);
router.post('/trigger', authMiddleware, requireStaffPermission('org.integrations'), requireLegacyDataOwner('EPUB automation'), triggerProcessing);
router.post('/stop', authMiddleware, requireStaffPermission('org.integrations'), requireLegacyDataOwner('EPUB automation'), stopAutomation);
router.post('/status/reset', authMiddleware, requireStaffPermission('org.integrations'), requireLegacyDataOwner('EPUB automation'), resetAutomationStatus);
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

// Processing record management (called by the automation runner with the
// triggering admin's token) — held to the same checks as the routes above.
router.post('/record', authMiddleware, requireStaffPermission('org.integrations'), requireLegacyDataOwner('EPUB automation'), createProcessingRecord);
router.put('/record/:id', authMiddleware, requireStaffPermission('org.integrations'), requireLegacyDataOwner('EPUB automation'), updateProcessingRecord);

export default router;
