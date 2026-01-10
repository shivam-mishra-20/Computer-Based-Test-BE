import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import Notification, { INotification, NotificationType, NotificationPriority } from '../models/Notification';
import User from '../models/User';

const expo = new Expo();

interface CreateNotificationParams {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  priority?: NotificationPriority;
  data?: any;
  actionUrl?: string;
}

export const sendPushNotification = async (pushToken: string, title: string, body: string, data?: any) => {
  if (!Expo.isExpoPushToken(pushToken)) {
    console.warn(`Push token ${pushToken} is not a valid Expo push token`);
    return;
  }

  const messages: ExpoPushMessage[] = [{
    to: pushToken,
    sound: 'default',
    title,
    body,
    data,
  }];

  try {
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        console.log('Push notification sent:', ticketChunk);
        // NOTE: For production, you should handle receipts to check for errors/invalid tokens
      } catch (error) {
        console.error('Error sending push notification chunk:', error);
      }
    }
  } catch (error) {
    console.error('Error sending push notification:', error);
  }
};

export const createAndSendNotification = async (params: CreateNotificationParams): Promise<INotification> => {
  const { userId, type, title, message, priority = 'medium', data, actionUrl } = params;

  // 1. Create Notification in DB
  const notification = await Notification.create({
    userId,
    type,
    priority,
    title,
    message,
    data,
    actionUrl,
  });

  // 2. Fetch User to get Push Token
  try {
    const user = await User.findById(userId).select('pushToken settings');
    
    // Check if user allows push notifications
    if (user && user.pushToken && user.settings?.pushNotifications !== false) {
      // 3. Send Push Notification
      await sendPushNotification(user.pushToken, title, message, { ...data, notificationId: notification._id });
    }
  } catch (error) {
    console.error(`Error sending push notification for user ${userId}:`, error);
    // Don't throw, we still successfully created the DB notification
  }

  return notification;
};

export const broadcastNotification = async (userIds: string[], params: Omit<CreateNotificationParams, 'userId'>) => {
    // This could be optimized safely with bulk lookup
    const results = await Promise.all(userIds.map(userId => createAndSendNotification({ ...params, userId })));
    return results;
}

export default {
  sendPushNotification,
  createAndSendNotification,
  broadcastNotification
};
