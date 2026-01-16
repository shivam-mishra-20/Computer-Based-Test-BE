import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import { deleteSetting, listAuditLogs, listSettings, upsertSetting } from '../../controllers/adminController';
import { 
  getFirebaseSyncStats,
  getFirebaseUsers,
  getFirebaseBatches,
  getFirebaseClasses,
  syncStudents,
  syncTeachers,
  syncBatches,
  syncAllData
} from '../../controllers/firebaseSyncController';

const router = Router();

router.use(authMiddleware, requireRole('admin'));

// Settings management
router.get('/settings', listSettings);
router.post('/settings', upsertSetting);
router.delete('/settings/:key', deleteSetting);

// Audit logs
router.get('/audit-logs', listAuditLogs);

// Firebase sync endpoints
router.get('/firebase/stats', getFirebaseSyncStats);
router.get('/firebase/users', getFirebaseUsers);
router.get('/firebase/batches', getFirebaseBatches);
router.get('/firebase/classes', getFirebaseClasses);
router.post('/firebase/sync/students', syncStudents);
router.post('/firebase/sync/teachers', syncTeachers);
router.post('/firebase/sync/batches', syncBatches);
router.post('/firebase/sync/all', syncAllData);

export default router;
