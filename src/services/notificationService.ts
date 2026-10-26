import Notification from '../models/Notification';
import User from '../models/User';
import SocketService from './SocketService';
import { pushNotifications } from './pushDelivery';
import { INSTITUTE_ACCOUNT_CLAUSE } from '../utils/instituteAudience';

/**
 * Emit a freshly-created notification to the recipient's personal socket room
 * (`user:<id>`) so an open app updates its inbox / badge in real time, without
 * waiting for a push notification or a manual refresh. Safe no-op if the socket
 * server isn't initialised.
 */
function emitRealtimeNotification(userId: unknown, doc: any): void {
  if (!userId || !doc) return;
  try {
    SocketService.emitToUser(String(userId), 'notification', {
      _id: String(doc._id),
      type: doc.type,
      title: doc.title,
      message: doc.message,
      data: doc.data ?? {},
      read: false,
      createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
    });
  } catch (error) {
    console.error('[notificationService] Realtime emit error:', error);
  }
}

// Check if a string is a valid MongoDB ObjectId
function isValidObjectId(id: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(id);
}

function normalizeNotificationData(type: string, data?: any): Record<string, any> {
  const normalized = { ...(data || {}) };
  const resolvedType =
    typeof normalized.type === 'string' && normalized.type.trim().length > 0
      ? normalized.type.trim()
      : type;

  if (resolvedType === 'doubt' || resolvedType === 'doubt_message') {
    normalized.type = 'doubt_message';

    if (normalized.doubtId != null) {
      normalized.doubtId = String(normalized.doubtId);
    }

    const role =
      typeof normalized.role === 'string' && normalized.role.trim().length > 0
        ? normalized.role.trim().toLowerCase()
        : 'student';

    normalized.role = role;

    if (typeof normalized.screen !== 'string' || !normalized.screen.trim()) {
      normalized.screen =
        role === 'teacher' || role === 'admin'
          ? '/(teacher)/doubts'
          : '/(student)/doubts';
    }

    return normalized;
  }

  if (typeof normalized.type !== 'string' || !normalized.type.trim()) {
    normalized.type = type;
  }

  // Safety: strip any screen value that isn't a valid route path.
  // Invalid values like 'Attendance' (no leading '/') can cause deep-link
  // misroutes (e.g. abhigyangurukulapp:///) when the OS processes the
  // notification before the JS handler runs.
  if (typeof normalized.screen === 'string' && !normalized.screen.startsWith('/')) {
    delete normalized.screen;
  }

  return normalized;
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
    // Find ALL matching students (even those without a push token) so we can
    // persist an in-app notification for every student regardless.
    const query: any = { role: 'student', ...INSTITUTE_ACCOUNT_CLAUSE };
    if (classLevel) {
      // Schedules store "11" while students store "Class 11" — match both
      // formats, otherwise the query silently targets zero students.
      const raw = String(classLevel).replace(/^Class\s*/i, '').trim();
      query.classLevel = { $in: [...new Set([String(classLevel), raw, `Class ${raw}`])] };
    }
    // 'All Batches'/'All' are wildcards, not real batch names
    if (batch && !['all batches', 'all'].includes(String(batch).trim().toLowerCase())) {
      query.batch = batch;
    }

    const users = await User.find(query).select('_id pushToken');
    console.log(
      `[sendScheduleNotification] class="${classLevel ?? 'any'}" batch="${batch ?? 'any'}" → ${users.length} students matched`
    );
    if (users.length === 0) return;

    // ── 1. Persist in-app notifications to MongoDB ───────────────────────────
    const scheduleNotifications = await Notification.insertMany(
      users.map(u => ({
        userId: u._id,
        type: 'schedule' as const,
        title,
        message: body,
        data: { type: 'schedule_update' },
        priority: 'medium' as const,
        read: false,
      }))
    ).catch(err => {
      console.error('[sendScheduleNotification] DB insert error:', err);
      return [] as any[];
    });

    // Real-time fan-out to any connected clients
    (scheduleNotifications || []).forEach((doc: any) => emitRealtimeNotification(doc.userId, doc));

    // ── 2. Push: once per stored notification, to every device of each student ─
    await pushNotifications(scheduleNotifications as any[]);
  } catch (error) {
    console.error('[sendScheduleNotification] Error:', error);
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

    // ── Persist in-app notification to MongoDB regardless of push token ──────
    const teacherNotification = await Notification.create({
      userId: teacher._id,
      type: 'leave' as const,
      title,
      message: body,
      data: { type: 'leave', role: 'teacher', screen: '/(teacher)/more' },
      priority: 'medium' as const,
      read: false,
    }).catch(err => {
      console.error('[sendTeacherNotification] DB insert error:', err);
      return null;
    });

    if (teacherNotification) {
      emitRealtimeNotification(teacherNotification.userId, teacherNotification);
    }

    // Push: once, to every device the teacher is signed in on (services/pushDelivery).
    if (teacherNotification)
      await pushNotifications([teacherNotification as any]);
  } catch (error) {
    console.error('[sendTeacherNotification] Error sending teacher notification:', error);
    throw error; // Re-throw to see the full error
  }
}

/**
 * Send push notifications to specific students and persist to DB
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
    
    // Last-mile isolation: even if an upstream audience resolver ever leaked a
    // public-learner id, an INSTITUTE notification must not be delivered to it.
    // Cheap here, and it makes delivery safe independent of every caller.

    // Find by MongoDB ObjectIds
    const mongoStudents = objectIds.length > 0
      ? await User.find({
          _id: { $in: objectIds },
          ...INSTITUTE_ACCOUNT_CLAUSE,
        }).select('_id pushToken')
      : [];

    // Find by Firebase IDs
    const firebaseStudents = firebaseIds.length > 0
      ? await User.find({
          firebaseUid: { $in: firebaseIds },
          ...INSTITUTE_ACCOUNT_CLAUSE,
        }).select('_id pushToken')
      : [];
    
    const allStudents = [...mongoStudents, ...firebaseStudents];
    
    if (allStudents.length === 0) return;

    const notifType = (type || 'general') as any;
    const normalizedData = normalizeNotificationData(notifType, data);

    // ── Persist all notifications to MongoDB ─────────────────────────────────
    const createdNotifications = await Notification.insertMany(
      allStudents.map((s) => ({
        userId: s._id,
        type: notifType,
        title,
        message: body,
        data: normalizedData,
        priority: 'medium',
        read: false,
      }))
    );

    // ── Real-time fan-out: push the new notification straight to each student's
    //    socket room so an open app shows it instantly (homework/material/etc.) ─
    (createdNotifications || []).forEach((doc: any) => emitRealtimeNotification(doc.userId, doc));

    // ── Push: once per stored notification, to every device of each student ──
    await pushNotifications((createdNotifications || []) as any[]);
  } catch (error) {
    console.error('Error sending student notifications:', error);
  }
}

/**
 * Create and send a notification to a specific user (or users).
 * Always persists a Notification document to MongoDB so the in-app
 * notification inbox is populated, then tries to send a push notification.
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
    const notifType = (type || 'general') as any;
    const normalizedData = normalizeNotificationData(notifType, data);

    // ── 1. Resolve MongoDB user ID ──────────────────────────────────────────
    let mongoUser: any = null;
    if (isValidObjectId(userId)) {
      mongoUser = await User.findById(userId).select('_id pushToken');
    } else {
      mongoUser = await User.findOne({ firebaseUid: userId }).select('_id pushToken');
    }

    if (!mongoUser) {
      console.warn(`[createAndSendNotification] User not found: ${userId}`);
      return;
    }

    // ── 2. Persist to MongoDB (notification inbox) ───────────────────────────
    const createdNotification = await Notification.create({
      userId: mongoUser._id,
      type: notifType,
      title,
      message: body,
      data: normalizedData,
      priority: 'medium',
      read: false,
    });

    // ── 2b. Real-time delivery to an open app ────────────────────────────────
    emitRealtimeNotification(createdNotification.userId, createdNotification);

    // ── 3. Push: once, to every device the user is signed in on ─────────────────
    await pushNotifications([createdNotification as any]);
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
