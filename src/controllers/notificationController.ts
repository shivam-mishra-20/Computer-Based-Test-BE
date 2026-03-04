import { Request, Response } from 'express';
import { Expo } from 'expo-server-sdk';
import Notification from '../models/Notification';
import * as notificationService from '../services/notificationService';
import User from '../models/User';

const expo = new Expo();

// Register push token
export const registerToken = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const { pushToken } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!pushToken) {
      return res.status(400).json({ message: 'Push token is required' });
    }

    if (!Expo.isExpoPushToken(pushToken)) {
      return res.status(400).json({
        message: 'Invalid push token format (expected Expo push token)',
      });
    }

    await User.findByIdAndUpdate(userId, { pushToken });

    res.json({ message: 'Push token registered successfully' });
  } catch (err) {
    console.error('Error registering push token:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Send a test push notification to the authenticated user
export const sendTestPush = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { title, body } = (req.body || {}) as { title?: string; body?: string };
    const safeTitle = (title && String(title).trim()) || 'Test notification';
    const safeBody = (body && String(body).trim()) || 'If you see this, push notifications are working.';

    const user = await User.findById(userId).select('_id pushToken').lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Persist an in-app notification too
    await Notification.create({
      userId: user._id,
      type: 'general',
      title: safeTitle,
      message: safeBody,
      data: { type: 'test' },
      priority: 'high',
      read: false,
    }).catch(() => {
      // Don't fail the request if DB insert fails
    });

    if (!user.pushToken) {
      return res.status(400).json({
        message: 'No push token registered for this user. Log in on a physical device and allow notifications.',
      });
    }

    if (!Expo.isExpoPushToken(user.pushToken)) {
      return res.status(400).json({
        message: 'Stored push token is not a valid Expo push token',
      });
    }

    const tickets = await expo.sendPushNotificationsAsync([
      {
        to: user.pushToken,
        sound: 'default',
        title: safeTitle,
        body: safeBody,
        data: { type: 'test' },
        priority: 'high',
        channelId: 'default',
      },
    ]);

    res.json({
      message: 'Test push sent (ticket returned by Expo).',
      tickets,
    });
  } catch (err: any) {
    console.error('Error sending test push:', err);
    res.status(500).json({ message: 'Server error', error: err?.message });
  }
};

// Get notifications for the authenticated user
export const getUserNotifications = async (req: Request, res: Response) => {
  try {
    // Disable caching so new notifications always show up
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    const userId = (req as any).user?.id;
    const { read, type, limit = 50, skip = 0 } = req.query;

    const query: any = { userId };
    if (read !== undefined) {
      query.read = read === 'true';
    }
    if (type) {
      query.type = type;
    }

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1 })
        .limit(Number(limit))
        .skip(Number(skip))
        .lean(),
      Notification.countDocuments(query),
      Notification.countDocuments({ userId, read: false }),
    ]);

    res.json({
      notifications,
      total,
      unreadCount,
      hasMore: total > Number(skip) + notifications.length,
    });
  } catch (err) {
    console.error('Error fetching notifications:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Mark notification as read
export const markNotificationAsRead = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const { id } = req.params;

    const notification = await Notification.findOneAndUpdate(
      { _id: id, userId },
      { read: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.json({ message: 'Notification marked as read', notification });
  } catch (err) {
    console.error('Error marking notification as read:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Mark all notifications as read
export const markAllNotificationsAsRead = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;

    await Notification.updateMany(
      { userId, read: false },
      { read: true }
    );

    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error('Error marking all notifications as read:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Delete notification
export const deleteNotification = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const { id } = req.params;

    const notification = await Notification.findOneAndDelete({
      _id: id,
      userId,
    });

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.json({ message: 'Notification deleted' });
  } catch (err) {
    console.error('Error deleting notification:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Delete all read notifications
export const deleteAllReadNotifications = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;

    await Notification.deleteMany({ userId, read: true });

    res.json({ message: 'All read notifications deleted' });
  } catch (err) {
    console.error('Error deleting read notifications:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Create notification (for system/admin use)
export const createNotification = async (req: Request, res: Response) => {
  try {
    const { userId, type, priority, title, message, data, actionUrl } = req.body;

    if (!userId || !type || !title || !message) {
      return res.status(400).json({ 
        message: 'userId, type, title, and message are required' 
      });
    }

    const notification = await notificationService.createAndSendNotification({
      userId,
      type,
      title,
      body: message,
      data: { ...data, priority, actionUrl },
    });

    res.status(201).json({ 
      message: 'Notification created', 
      notification 
    });
  } catch (err) {
    console.error('Error creating notification:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Bulk create notifications (for broadcasts)
export const createBulkNotifications = async (req: Request, res: Response) => {
  try {
    const { userIds, type, priority, title, message, data, actionUrl } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ message: 'userIds array is required' });
    }

    if (!type || !title || !message) {
      return res.status(400).json({ 
        message: 'type, title, and message are required' 
      });
    }

    // Use broadcast service to send push notifications too
    // Note: optimization for valid tokens might be needed for large broadcasts
    await notificationService.broadcastNotification(userIds, {
      type,
      title,
      body: message,
      data: { ...data, priority, actionUrl }
    });

    res.status(201).json({ 
      message: `${userIds.length} notifications queued for creation` 
    });
  } catch (err) {
    console.error('Error creating bulk notifications:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

