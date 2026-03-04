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
  registerToken,
  sendTestPush,
} from '../../controllers/notificationController';

const router = Router();

// User notification endpoints
router.get('/', authMiddleware, getUserNotifications);
router.put('/:id/read', authMiddleware, markNotificationAsRead);
router.put('/read-all', authMiddleware, markAllNotificationsAsRead);
router.delete('/:id', authMiddleware, deleteNotification);
router.delete('/read/clear', authMiddleware, deleteAllReadNotifications);

// Register push token
router.post('/register-token', authMiddleware, registerToken);

// Debug: send a test push to the authenticated user
router.post('/test-push', authMiddleware, sendTestPush);

// Admin/System endpoints for creating notifications
router.post('/', authMiddleware, requireRole('admin'), createNotification);
router.post('/bulk', authMiddleware, requireRole('admin'), createBulkNotifications);

export default router;
