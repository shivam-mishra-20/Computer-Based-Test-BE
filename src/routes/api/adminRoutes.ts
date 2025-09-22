import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import { deleteSetting, listAuditLogs, listSettings, upsertSetting } from '../../controllers/adminController';

const router = Router();

router.use(authMiddleware, requireRole('admin'));

// Settings management
router.get('/settings', listSettings);
router.post('/settings', upsertSetting);
router.delete('/settings/:key', deleteSetting);

// Audit logs
router.get('/audit-logs', listAuditLogs);

export default router;
