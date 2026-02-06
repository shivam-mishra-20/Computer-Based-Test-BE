import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import User from '../models/User';

// Initialize Expo SDK
const expo = new Expo();

// Check if a string is a valid MongoDB ObjectId
function isValidObjectId(id: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(id);
}

/**
 * Send push notifications to users based on class/batch
 */
export async function sendScheduleNotification(
  title: string,
  body: string,
  classLevel?: string,
  batch?: string
) {
  try {
    // Find users who match criteria and have push tokens
    const query: any = {
      role: 'student',
      pushToken: { $exists: true, $ne: null }
    };
    
    if (classLevel) {
      query.classLevel = classLevel;
    }
    if (batch) {
      query.batch = batch;
    }
    
    const users = await User.find(query).select('pushToken');
    const pushTokens = users.map(u => u.pushToken).filter(t => Expo.isExpoPushToken(t));
    
    if (pushTokens.length === 0) return;
    
    // Create messages
    const messages: ExpoPushMessage[] = [];
    for (const pushToken of pushTokens) {
      messages.push({
        to: pushToken,
        sound: 'default',
        title: title,
        body: body,
        data: { type: 'schedule_update' },
        priority: 'high',
        channelId: 'default',
      });
    }
    
    // Chunk and send
    const chunks = expo.chunkPushNotifications(messages);
    const tickets = [];
    
    for (const chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      } catch (error) {
        console.error('Error sending push notification chunk:', error);
      }
    }
    
    return tickets;
  } catch (error) {
    console.error('Error sending schedule notifications:', error);
  }
}

/**
 * Send push notification to a specific teacher
 * Supports both MongoDB ObjectId and Firebase document ID
 */
export async function sendTeacherNotification(
  teacherId: string,
  title: string,
  body: string
) {
  try {
    console.log('[sendTeacherNotification] Looking for teacher:', teacherId);
    let teacher = null;
    
    // Try to find by MongoDB ObjectId first
    if (isValidObjectId(teacherId)) {
      console.log('[sendTeacherNotification] Searching by MongoDB ObjectId');
      teacher = await User.findById(teacherId).select('pushToken name email');
    }
    
    // If not found, try to find by firebaseUid field
    if (!teacher) {
      console.log('[sendTeacherNotification] Searching by firebaseUid');
      teacher = await User.findOne({ firebaseUid: teacherId }).select('pushToken name email');
    }
    
    if (!teacher) {
      console.error(`[sendTeacherNotification] Teacher ${teacherId} not found in database`);
      return;
    }

    console.log('[sendTeacherNotification] Teacher found:', {
      id: teacher._id,
      name: teacher.name,
      email: teacher.email,
      hasPushToken: !!teacher.pushToken,
      pushToken: teacher.pushToken ? `${teacher.pushToken.substring(0, 20)}...` : 'none'
    });
    
    if (!teacher?.pushToken) {
      console.error(`[sendTeacherNotification] Teacher ${teacherId} (${teacher.name}) has no push token`);
      return;
    }

    if (!Expo.isExpoPushToken(teacher.pushToken)) {
      console.error(`[sendTeacherNotification] Invalid push token format for teacher ${teacherId}: ${teacher.pushToken}`);
      return;
    }
    
    const message: ExpoPushMessage = {
      to: teacher.pushToken,
      sound: 'default',
      title,
      body,
      data: { type: 'leave_update', screen: 'Leaves' },
      priority: 'high',
      channelId: 'default',
    };
    
    console.log('[sendTeacherNotification] Sending push notification:', {
      to: `${teacher.pushToken.substring(0, 20)}...`,
      title,
      body: body.substring(0, 50)
    });
    
    const tickets = await expo.sendPushNotificationsAsync([message]);
    console.log('[sendTeacherNotification] Notification sent, tickets:', tickets);
  } catch (error) {
    console.error('[sendTeacherNotification] Error sending teacher notification:', error);
    throw error; // Re-throw to see the full error
  }
}

/**
 * Send push notifications to specific students
 * Supports both MongoDB ObjectIds and Firebase document IDs
 */
export async function sendStudentNotifications(
  studentIds: string[],
  title: string,
  body: string,
  data?: any,
  type?: string
) {
  try {
    // Separate MongoDB ObjectIds from Firebase IDs
    const objectIds = studentIds.filter(isValidObjectId);
    const firebaseIds = studentIds.filter(id => !isValidObjectId(id));
    
    // Find by MongoDB ObjectIds
    const mongoStudents = objectIds.length > 0 
      ? await User.find({
          _id: { $in: objectIds },
          pushToken: { $exists: true, $ne: null }
        }).select('pushToken')
      : [];
    
    // Find by Firebase IDs
    const firebaseStudents = firebaseIds.length > 0
      ? await User.find({
          firebaseUid: { $in: firebaseIds },
          pushToken: { $exists: true, $ne: null }
        }).select('pushToken')
      : [];
    
    const allStudents = [...mongoStudents, ...firebaseStudents];
    const pushTokens = allStudents.map(s => s.pushToken).filter(t => Expo.isExpoPushToken(t));
    
    if (pushTokens.length === 0) return;
    
    const messages: ExpoPushMessage[] = pushTokens.map(token => ({
      to: token,
      sound: 'default' as const,
      title,
      priority: 'high',
      channelId: 'default',
      body,
      data: data || { type: type || 'schedule_update' },
    }));
    
    const chunks = expo.chunkPushNotifications(messages);
    
    for (const chunk of chunks) {
      try {
        await expo.sendPushNotificationsAsync(chunk);
      } catch (error) {
        console.error('Error sending student notification chunk:', error);
      }
    }
  } catch (error) {
    console.error('Error sending student notifications:', error);
  }
}

/**
 * Create and send a notification to a specific user (or users)
 * This acts as a wrapper to unify notification logic if needed
 */
export async function createAndSendNotification(payload: {
  userId: string;
  title: string;
  body: string;
  type?: string;
  data?: any;
}) {
  try {
    const { userId, title, body, data, type } = payload;
    
    // Determine if userId is MongoDB or Firebase
    if (isValidObjectId(userId)) {
       const user = await User.findById(userId).select('pushToken');
       if (user?.pushToken && Expo.isExpoPushToken(user.pushToken)) {
         await expo.sendPushNotificationsAsync([{
           to: user.pushToken,
           sound: 'default',
           title,
           body,
           data: data || { type: type || 'general' },
           priority: 'high',
           channelId: 'default',
         }]);
       }
    } else {
       // Should implement Firebase ID logic here if needed, similar to other functions
       // For now reuse sendTeacher/Student logic or simple find
       const user = await User.findOne({ firebaseUid: userId }).select('pushToken');
       if (user?.pushToken && Expo.isExpoPushToken(user.pushToken)) {
         await expo.sendPushNotificationsAsync([{
            to: user.pushToken,
            sound: 'default',
            title,
            body,
            data: data || { type: type || 'general' },
            priority: 'high',
            channelId: 'default',
         }]);
       }
    }
  } catch (error) {
    console.error('Error in createAndSendNotification:', error);
  }
}

/**
 * Broadcast notification to a list of user IDs
 */
export async function broadcastNotification(userIds: string[], payload: {
  title: string;
  body: string;
  data?: any;
  type?: string;
}) {
  await sendStudentNotifications(userIds, payload.title, payload.body, payload.data, payload.type);
}
