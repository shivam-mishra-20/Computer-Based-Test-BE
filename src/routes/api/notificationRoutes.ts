import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import {
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  deleteAllReadNotifications,
  createNotification,
  createBulkNotifications,
} from '../../controllers/notificationController';

const router = Router();

// User notification endpoints
router.get('/', authMiddleware, getUserNotifications);
router.put('/:id/read', authMiddleware, markNotificationAsRead);
router.put('/read-all', authMiddleware, markAllNotificationsAsRead);
router.delete('/:id', authMiddleware, deleteNotification);
router.delete('/read/clear', authMiddleware, deleteAllReadNotifications);

// Admin/System endpoints for creating notifications
router.post('/', authMiddleware, requireRole('admin'), createNotification);
router.post('/bulk', authMiddleware, requireRole('admin'), createBulkNotifications);

export default router;
