import { requireStaffPermission } from '../../middlewares/requirePermission';
import { Router } from 'express';
import { authMiddleware} from '../../middlewares/authMiddleware';
import { deviceReleaseLimiter } from '../../middlewares/rateLimiter';
import {
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  deleteAllReadNotifications,
  createNotification,
  createBulkNotifications,
  registerToken,
  unregisterToken,
  registerDevice,
  unregisterDevice,
  releaseDevice,
  sendTestPush,
} from '../../controllers/notificationController';

const router = Router();

// User notification endpoints
router.get('/', authMiddleware, getUserNotifications);
router.put('/read-all', authMiddleware, markAllNotificationsAsRead);
router.put('/:id/read', authMiddleware, markNotificationAsRead);
router.delete('/read/clear', authMiddleware, deleteAllReadNotifications);

// Register push token
router.post('/register-token', authMiddleware, registerToken);
router.delete('/unregister-token', authMiddleware, unregisterToken);

// Organization apps: one registration per installation (PushDevice)
router.post('/devices', authMiddleware, registerDevice);
router.delete('/devices/:installationId', authMiddleware, unregisterDevice);
// No session by design — see releaseDevice: removal only, proven by installation id + token.
router.post('/devices/release', deviceReleaseLimiter, releaseDevice);
// Debug: send a test push to the authenticated user
router.post('/test-push', authMiddleware, sendTestPush);

// Keep this dynamic route after static delete routes.
router.delete('/:id', authMiddleware, deleteNotification);

// Admin/System endpoints for creating notifications
router.post('/', authMiddleware, requireStaffPermission('notifications.send'), createNotification);
router.post('/bulk', authMiddleware, requireStaffPermission('notifications.send'), createBulkNotifications);

export default router;
