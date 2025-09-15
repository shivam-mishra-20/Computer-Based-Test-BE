import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import { adminCreateUser, adminListUsers, adminGetUser, adminUpdateUser, adminDeleteUser, adminDashboard } from '../../controllers/userController';

const router = Router();

// Admin-only dashboard
router.get('/dashboard', authMiddleware, requireRole('admin'), adminDashboard);

// Admin-only user management
router.post('/', authMiddleware, requireRole('admin'), adminCreateUser);
router.get('/', authMiddleware, requireRole('admin'), adminListUsers);
router.get('/:id', authMiddleware, requireRole('admin'), adminGetUser);
router.put('/:id', authMiddleware, requireRole('admin'), adminUpdateUser);
router.delete('/:id', authMiddleware, requireRole('admin'), adminDeleteUser);

export default router;
