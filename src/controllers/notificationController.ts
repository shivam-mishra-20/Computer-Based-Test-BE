import { Request, Response } from 'express';
import Notification from '../models/Notification';

// Get notifications for the authenticated user
export const getUserNotifications = async (req: Request, res: Response) => {
  try {
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

    const notification = await Notification.create({
      userId,
      type,
      priority: priority || 'medium',
      title,
      message,
      data,
      actionUrl,
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

    const notifications = userIds.map(userId => ({
      userId,
      type,
      priority: priority || 'medium',
      title,
      message,
      data,
      actionUrl,
    }));

    await Notification.insertMany(notifications);

    res.status(201).json({ 
      message: `${notifications.length} notifications created` 
    });
  } catch (err) {
    console.error('Error creating bulk notifications:', err);
    res.status(500).json({ message: 'Server error' });
  }
};
