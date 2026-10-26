import { Request, Response } from 'express';
import { Expo } from 'expo-server-sdk';
import Notification from '../models/Notification';
import * as notificationService from '../services/notificationService';
import { presentNotification } from '../services/notificationFormat';
import User from '../models/User';
import PushDevice from '../models/PushDevice';
import { pushNotifications } from '../services/pushDelivery';
import { withoutTenantScope } from '../core/tenancy/context';

const expo = new Expo();

// Register push token
export const registerToken = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const pushToken = typeof req.body?.pushToken === 'string' ? req.body.pushToken.trim() : '';

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

    // Ensure one physical device token is bound to only one account at a time.
    // This prevents cross-account notification leakage when users switch accounts.
    const detachResult = await User.updateMany(
      { _id: { $ne: userId }, pushToken },
      { $unset: { pushToken: '' } }
    );

    await User.findByIdAndUpdate(userId, { pushToken });

    const detachedUsers =
      (detachResult as any).modifiedCount ?? (detachResult as any).nModified ?? 0;

    res.json({
      message: 'Push token registered successfully',
      detachedUsers,
    });
  } catch (err) {
    console.error('Error registering push token:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Unregister push token for the authenticated user (used during logout)
export const unregisterToken = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    await User.findByIdAndUpdate(userId, { $unset: { pushToken: '' } });

    res.json({ message: 'Push token unregistered successfully' });
  } catch (err) {
    console.error('Error unregistering push token:', err);
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
    const created = await Notification.create({
      userId: user._id,
      type: 'general',
      title: safeTitle,
      message: safeBody,
      data: { type: 'test' },
      priority: 'high',
      read: false,
    }).catch(() => null); // Don't fail the request if DB insert fails

    // Organization apps register installations (PushDevice): send through the
    // same delivery every real notification uses, and say what Expo answered.
    const devices = await PushDevice.countDocuments({ userId: user._id });
    if (devices > 0) {
      const outcome = created
        ? await pushNotifications([created as any])
        : { claimed: 0, sent: 0 };
      const failing = await PushDevice.find({
        userId: user._id,
        lastError: { $ne: null },
      })
        .select('lastError appId -_id')
        .lean();
      return res.json({
        message:
          outcome.sent > 0
            ? 'Test push accepted by Expo for delivery.'
            : 'Test push was not accepted for any device.',
        devices,
        sent: outcome.sent,
        failing,
      });
    }

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

// ── Organization-app installations (PushDevice) ────────────────────────────
const INSTALLATION_ID = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * POST /notifications/devices  { token, installationId, platform, appId?, projectId? }
 *
 * Binds this installation to the signed-in account, in the account's own
 * organization (the tenancy plugin stamps it). The same physical token or
 * installation is first detached from anyone else, anywhere — that is what
 * stops a phone that changed hands, accounts or organizations from receiving
 * the previous person's notifications.
 */
export const registerDevice = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    const body = (req.body || {}) as Record<string, unknown>;
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const installationId =
      typeof body.installationId === 'string' ? body.installationId.trim() : '';
    const platform =
      body.platform === 'ios'
        ? 'ios'
        : body.platform === 'android'
          ? 'android'
          : null;
    const appId =
      typeof body.appId === 'string'
        ? body.appId.trim().slice(0, 256)
        : undefined;
    const projectId =
      typeof body.projectId === 'string'
        ? body.projectId.trim().slice(0, 64)
        : undefined;

    if (!Expo.isExpoPushToken(token))
      return res
        .status(400)
        .json({ message: 'token must be an Expo push token' });
    if (!INSTALLATION_ID.test(installationId))
      return res.status(400).json({ message: 'installationId is invalid' });
    if (!platform)
      return res
        .status(400)
        .json({ message: 'platform must be android or ios' });

    await withoutTenantScope('push:detach-device', async () => {
      await PushDevice.deleteMany({
        $or: [
          { token, installationId: { $ne: installationId } },
          { installationId, userId: { $ne: userId } },
        ],
      });
      await User.updateMany(
        { _id: { $ne: userId }, pushToken: token },
        { $unset: { pushToken: '' } },
      );
    });

    const device = await PushDevice.findOneAndUpdate(
      { installationId, userId },
      {
        $set: {
          token,
          platform,
          appId,
          projectId,
          lastRegisteredAt: new Date(),
          lastError: null,
          lastErrorAt: null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();

    res.json({
      registered: true,
      installationId: device?.installationId ?? installationId,
    });
  } catch (err) {
    console.error('Error registering push device:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/** DELETE /notifications/devices/:installationId — sign-out: this installation stops receiving this account's pushes. */
export const unregisterDevice = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    const installationId = String(req.params.installationId || '').trim();
    if (!INSTALLATION_ID.test(installationId))
      return res.status(400).json({ message: 'installationId is invalid' });
    const result = await PushDevice.deleteOne({ installationId, userId });
    res.json({
      removed: (result as { deletedCount?: number }).deletedCount ?? 0,
    });
  } catch (err) {
    console.error('Error unregistering push device:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/**
 * POST /notifications/devices/release  { installationId, token }  — NO session.
 *
 * A phone whose session ended without a reachable server (sign-out while
 * offline, a session that expired or was revoked) is still registered, and
 * Android shows a push without asking the app — so the previous person's
 * notifications would keep arriving. The app retries this until it succeeds.
 *
 * It needs no session because it can only ever REMOVE, and only the one
 * registration matching BOTH the installation id and the exact push token —
 * two values that exist together only on that device. It reveals nothing but
 * whether something was removed.
 */
export const releaseDevice = async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const installationId =
      typeof body.installationId === 'string' ? body.installationId.trim() : '';
    if (!Expo.isExpoPushToken(token) || !INSTALLATION_ID.test(installationId)) {
      return res
        .status(400)
        .json({ message: 'installationId and token are required' });
    }
    const result = await withoutTenantScope('push:release-device', () =>
      PushDevice.deleteOne({ installationId, token }),
    );
    res.json({
      released: ((result as { deletedCount?: number }).deletedCount ?? 0) > 0,
    });
  } catch (err) {
    console.error('Error releasing push device:', err);
    res.status(500).json({ message: 'Server error' });
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
      // Legacy rows that carry `body` instead of `message` read the same as the rest.
      notifications: notifications.map((n) =>
        presentNotification(n as unknown as Record<string, unknown>),
      ),
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

