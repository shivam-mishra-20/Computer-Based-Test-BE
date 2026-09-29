import { Router } from 'express';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { requireStaffPermission } from '../../middlewares/requirePermission';
import { requireLegacyDataOwner } from '../../middlewares/orgScopeGates';
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

router.use(authMiddleware);

const manageSettings = requireStaffPermission('org.settings');
const readAudit = requireStaffPermission('audit.read');
// Firestore is ONE institute's store with no organization dimension: the
// module gate says "may use integrations", this says "the data is yours".
const firebase = [requireStaffPermission('org.integrations'), requireLegacyDataOwner('Firebase sync')];

// Settings management
router.get('/settings', manageSettings, listSettings);
router.post('/settings', manageSettings, upsertSetting);
router.delete('/settings/:key', manageSettings, deleteSetting);

// Audit logs
router.get('/audit-logs', readAudit, listAuditLogs);

// Firebase sync endpoints
router.get('/firebase/stats', ...firebase, getFirebaseSyncStats);
router.get('/firebase/users', ...firebase, getFirebaseUsers);
router.get('/firebase/batches', ...firebase, getFirebaseBatches);
router.get('/firebase/classes', ...firebase, getFirebaseClasses);
router.post('/firebase/sync/students', ...firebase, syncStudents);
router.post('/firebase/sync/teachers', ...firebase, syncTeachers);
router.post('/firebase/sync/batches', ...firebase, syncBatches);
router.post('/firebase/sync/all', ...firebase, syncAllData);

export default router;
