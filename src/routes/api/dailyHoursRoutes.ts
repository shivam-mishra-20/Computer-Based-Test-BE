import { requireStaffPermission } from '../../middlewares/requirePermission';
import { Router } from 'express';
import { authMiddleware} from '../../middlewares/authMiddleware';
import DailyHoursController from '../../controllers/dailyHoursController';

const router = Router();

// Teachers and admins both reach this route; the controller pins a teacher to
// their own records so the role check here only decides who may ask at all.
router.get('/', authMiddleware, requireStaffPermission('reports.read'), DailyHoursController.getReport);

export default router;
