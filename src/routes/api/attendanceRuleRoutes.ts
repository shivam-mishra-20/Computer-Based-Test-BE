import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import AttendanceRuleController from '../../controllers/AttendanceRuleController';

const router = Router();

// All endpoints require admin authentication
router.use(authMiddleware, requireRole('admin'));

router.get('/', AttendanceRuleController.listRules);
router.get('/user/:userId', AttendanceRuleController.getRuleForUser);
router.post('/upsert', AttendanceRuleController.upsertRule);   // create-or-update by scope
router.post('/', AttendanceRuleController.createRule);
router.put('/:id', AttendanceRuleController.updateRule);
router.delete('/:id', AttendanceRuleController.deleteRule);

export default router;
