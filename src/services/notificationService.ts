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
    let teacher = null;
    
    // Try to find by MongoDB ObjectId first
    if (isValidObjectId(teacherId)) {
      teacher = await User.findById(teacherId).select('pushToken');
    }
    
    // If not found, try to find by firebaseUid field
    if (!teacher) {
      teacher = await User.findOne({ firebaseUid: teacherId }).select('pushToken');
    }
    
    if (!teacher?.pushToken || !Expo.isExpoPushToken(teacher.pushToken)) {
      console.log(`Teacher ${teacherId} has no valid push token`);
      return;
    }
    
    const message: ExpoPushMessage = {
      to: teacher.pushToken,
      sound: 'default',
      title,
      body,
      data: { type: 'schedule_update' },
    };
    
    await expo.sendPushNotificationsAsync([message]);
  } catch (error) {
    console.error('Error sending teacher notification:', error);
  }
}

/**
 * Send push notifications to specific students
 * Supports both MongoDB ObjectIds and Firebase document IDs
 */
export async function sendStudentNotifications(
  studentIds: string[],
  title: string,
  body: string
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
      body,
      data: { type: 'schedule_update' },
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
