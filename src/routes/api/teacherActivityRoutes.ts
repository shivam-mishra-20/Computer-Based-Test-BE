import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import TeacherActivityController from '../../controllers/teacherActivityController';

const router = Router();

// Teachers and admins both reach these routes; the controller pins a teacher to
// their own records, so the role check here only decides who may ask at all.
// Same arrangement as dailyHoursRoutes, on purpose: the two halves of one
// report must not have two different ideas about who is allowed to read it.
router.get('/summary', authMiddleware, requireRole('teacher', 'admin'), TeacherActivityController.getSummary);
router.get('/detail', authMiddleware, requireRole('teacher', 'admin'), TeacherActivityController.getDetail);

export default router;
