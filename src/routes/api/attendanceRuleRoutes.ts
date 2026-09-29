import { Router } from 'express';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { requireStaffPermission } from '../../middlewares/requirePermission';
import AttendanceRuleController from '../../controllers/AttendanceRuleController';

const router = Router();

// Deduction rules are institute attendance policy: attendance.manage, which the
// legacy bridge grants to administrators only.
router.use(authMiddleware, requireStaffPermission('attendance.manage'));

router.get('/', AttendanceRuleController.listRules);
router.get('/user/:userId', AttendanceRuleController.getRuleForUser);
router.post('/upsert', AttendanceRuleController.upsertRule);   // create-or-update by scope
router.post('/', AttendanceRuleController.createRule);
router.put('/:id', AttendanceRuleController.updateRule);
router.delete('/:id', AttendanceRuleController.deleteRule);

export default router;
