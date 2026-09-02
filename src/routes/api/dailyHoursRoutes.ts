import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import DailyHoursController from '../../controllers/dailyHoursController';

const router = Router();

// Teachers and admins both reach this route; the controller pins a teacher to
// their own records so the role check here only decides who may ask at all.
router.get('/', authMiddleware, requireRole('teacher', 'admin'), DailyHoursController.getReport);

export default router;
