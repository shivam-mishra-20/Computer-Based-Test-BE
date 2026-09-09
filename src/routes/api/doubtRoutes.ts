import { Router, Request, Response } from 'express';
import Doubt, { IDoubt } from '../../models/Doubt';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { messageLimiter, uploadLimiter } from '../../middlewares/rateLimiter';
import { IUser } from '../../models/User';
import { upload } from '../../middlewares/upload';
import { 
  uploadDoubtFile, 
  getFileSignedUrl, 
  deleteDoubtFile, 
  getDoubtFiles,
  generateUploadUrl
} from '../../controllers/fileController';
import mongoose from 'mongoose';
import FileMetadata from '../../models/FileMetadata';
import { bucket } from '../../config/firebase';
import SocketService from '../../services/SocketService';
import { createAndSendNotification } from '../../services/notificationService';
import { currentOrgId } from '../../core/tenancy';
import { isLegacyPath, pathBelongsToOrg } from '../../core/storage/paths';
import { INSTITUTE_ACCOUNT_CLAUSE } from '../../utils/instituteAudience';
import {
  canAccessDoubt,
  eligibleTeacherIdsForUnassigned,
  listDoubts,
  unreadCountFor,
  withActivityFields,
  type DoubtViewer,
  type DoubtViewerRole,
} from '../../services/doubtService';

interface AuthRequest extends Request {
  user?: IUser & { _id: any };
}

const router = Router();

/**
 * Tell every eligible teacher about a doubt nobody has claimed yet.
 *
 * Both a notification and a socket update: the socket keeps an open Doubts
 * list current (`emitDoubtUpdate` only reaches the student and the ASSIGNED
 * teacher, so an unassigned thread previously reached neither), and the push
 * covers everyone who does not have the app open.
 *
 * Best-effort by design — a failure here must never fail the student's send.
 * Once any teacher replies the thread becomes assigned and the normal
 * single-teacher path takes over, so this fires only while the doubt is
 * genuinely in the shared pool.
 */
async function notifyUnassignedDoubt(
  doubtId: string,
  senderName: string,
  message: string,
  populated: unknown,
): Promise<void> {
  try {
    const teacherIds = await eligibleTeacherIdsForUnassigned();
    if (teacherIds.length === 0) return;

    for (const teacherId of teacherIds) {
      SocketService.emitToUser(teacherId, 'doubt_updated', populated);
    }

    await Promise.all(
      teacherIds.map((teacherId) =>
        createAndSendNotification({
          userId: teacherId,
          title: `New doubt from ${senderName}`,
          body: message.substring(0, 100),
          type: 'doubt',
          data: {
            doubtId,
            type: 'doubt',
            role: 'teacher',
            screen: '/(teacher)/doubts',
          },
        }).catch((err) =>
          console.error('[UnassignedDoubt] Notification error:', err),
        ),
      ),
    );
  } catch (error) {
    console.error('[UnassignedDoubt] Fan-out failed:', error);
  }
}

/**
 * The caller as the authorization layer sees them.
 *
 * Returns null when the role is not one that participates in doubt chats —
 * a public learner, for instance, who has no teacher relationship at all.
 */
function viewerOf(req: AuthRequest): DoubtViewer | null {
  const id = (req.user?._id || req.user?.id)?.toString();
  const role = req.user?.role;
  if (!id || (role !== 'student' && role !== 'teacher' && role !== 'admin')) {
    return null;
  }
  return { id, role: role as DoubtViewerRole };
}

/**
 * Load a conversation and confirm the caller is a participant.
 *
 * Every `/:id` route funnels through this. Previously several of them —
 * including `GET /:id` and `POST /:id/messages`, the two a notification deep
 * link reaches — loaded the thread by id with no ownership check at all, so
 * any authenticated user could read or post into anyone's conversation just
 * by guessing an id. Deep links are now safe precisely BECAUSE the id alone
 * grants nothing.
 *
 * The rule is shared with the list query (`visibilityFilter`), so what a user
 * can open and what they can list can never drift apart.
 */
async function loadAccessibleDoubt(
  req: AuthRequest,
  res: Response,
  doubtId: string,
): Promise<IDoubt | null> {
  const viewer = viewerOf(req);
  if (!viewer) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }

  if (!mongoose.Types.ObjectId.isValid(doubtId)) {
    res.status(404).json({ error: 'Doubt not found' });
    return null;
  }

  const doubt = await Doubt.findById(doubtId);
  if (!doubt) {
    res.status(404).json({ error: 'Doubt not found' });
    return null;
  }

  if (!canAccessDoubt(doubt as any, viewer)) {
    // 403, not 404: the client distinguishes "this conversation is gone" from
    // "not yours" so a deep link can explain itself instead of bouncing the
    // user to a home screen with no reason given.
    res.status(403).json({ error: 'You do not have access to this conversation' });
    return null;
  }

  return doubt;
}

// GET - Fetch available teachers for student to ask doubts
router.get('/teachers', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const User = require('../../models/User').default;
    const teachers = await User.find({ role: 'teacher' })
      .select('name email profileImage')
      .sort({ name: 1 })
      .lean();
    return res.json({ teachers });
  } catch (error) {
    console.error('Error fetching teachers:', error);
    return res.status(500).json({ error: 'Failed to fetch teachers' });
  }
});

// File upload routes (must come before parameterized routes)
router.post('/upload-url', authMiddleware, uploadLimiter, generateUploadUrl);
router.post('/upload', authMiddleware, uploadLimiter, upload.single('file'), uploadDoubtFile);
router.get('/files/:fileId/url', authMiddleware, getFileSignedUrl);
router.delete('/files/:fileId', authMiddleware, deleteDoubtFile);

// POST - Save Firebase Storage file metadata
router.post('/save-file-metadata', authMiddleware, uploadLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const { fileName, fileType, fileSize, doubtId, storagePath } = req.body;

    if (!fileName || !fileType || !doubtId || !storagePath) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // ── No longer made public ───────────────────────────────────────────
    // This endpoint records metadata for a file the CLIENT uploaded directly,
    // and it used to make that object world-readable as a side effect. A path
    // supplied by the caller is now checked against the caller's organization
    // before it is recorded at all — otherwise a client could register, and
    // then read, an arbitrary object belonging to someone else.
    if (!isLegacyPath(storagePath) && !pathBelongsToOrg(storagePath, currentOrgId())) {
      return res.status(403).json({ error: 'That file does not belong to your organization.' });
    }

    // The stored value is the PATH; it is signed per request on the way out.
    const publicUrl = storagePath;

    // Save metadata to MongoDB
    const fileMetadata = new FileMetadata({
      url: publicUrl,
      storagePath,
      fileName,
      fileType,
      fileSize: fileSize || 0,
      uploadedBy: new mongoose.Types.ObjectId(req.user?._id || req.user?.id),
      relatedDoubtId: new mongoose.Types.ObjectId(doubtId),
    });

    await fileMetadata.save();

    return res.status(201).json({
      success: true,
      file: {
        id: fileMetadata._id,
        url: publicUrl,
        fileName,
        fileType,
        fileSize: fileSize || 0,
        storagePath
      }
    });
  } catch (error) {
    console.error('Error saving file metadata:', error);
    return res.status(500).json({
      error: 'Failed to save file metadata',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});
router.get('/:doubtId/files', authMiddleware, getDoubtFiles);

// GET - Fetch doubts for student
router.get('/student/my-doubts', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const studentId = req.user?._id || req.user?.id;

    if (req.user?.role !== 'student') {
      return res.status(403).json({ error: 'This endpoint is for students only' });
    }

    const viewer = viewerOf(req);
    if (!viewer) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { doubts, total, totalPages, stats } = await listDoubts({
      viewer,
      status: typeof status === 'string' ? status : undefined,
      page: Math.max(1, Number(page) || 1),
      limit: Math.min(100, Math.max(1, Number(limit) || 20)),
    });

    // A thread the student started that no teacher has claimed still shows the
    // teacher who actually replied, taken from the messages. Presentation only
    // — it must never change which threads are RETURNED.
    const doubtsWithTeacher = (doubts as any[]).map(doubt => {
      if (doubt.teacher) return doubt;

      const teacherMessage = doubt.messages?.find(
        (m: any) => (m.senderRole === 'teacher' || m.senderRole === 'admin') && m.sender && typeof m.sender === 'object' && m.sender.name
      );

      if (teacherMessage && teacherMessage.sender) {
        return {
          ...doubt,
          teacher: {
            _id: teacherMessage.sender._id,
            name: teacherMessage.sender.name,
            email: teacherMessage.sender.email || '',
            profileImage: teacherMessage.sender.profileImage
          }
        };
      }

      return { ...doubt, teacher: null };
    });

    for (const doubt of doubtsWithTeacher as any[]) {
      doubt.unreadCount = unreadCountFor(doubt, 'student');
    }

    // Convert to public URLs (no regeneration needed)
    for (const doubt of doubtsWithTeacher as any[]) {
      if (doubt.messages && doubt.messages.length > 0) {
        for (const message of doubt.messages) {
          if (message.attachments && message.attachments.length > 0) {
            for (const attachment of message.attachments) {
              // Ensure URL is public URL format
              if (!attachment.url || !attachment.url.startsWith('https://storage.googleapis.com')) {
                attachment.url = `https://storage.googleapis.com/${bucket.name}/${attachment.storagePath}`;
              }
            }
          }
        }
      }
    }

    return res.json({
      doubts: doubtsWithTeacher,
      total,
      page: Math.max(1, Number(page) || 1),
      totalPages,
      stats
    });
  } catch (error) {
    console.error('Error fetching student doubts:', error);
    return res.status(500).json({ error: 'Failed to fetch doubts' });
  }
});

// GET - Fetch doubts for teacher (with filters)
router.get('/teacher', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { status, batch, subject, page = 1, limit = 20 } = req.query;

    if (req.user?.role !== 'teacher' && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const viewer = viewerOf(req);
    if (!viewer) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { doubts, total, totalPages, stats } = await listDoubts({
      viewer,
      status: typeof status === 'string' ? status : undefined,
      batch: typeof batch === 'string' ? batch : undefined,
      subject: typeof subject === 'string' ? subject : undefined,
      page: Math.max(1, Number(page) || 1),
      limit: Math.min(100, Math.max(1, Number(limit) || 20)),
    });

    for (const doubt of doubts as any[]) {
      doubt.unreadCount = unreadCountFor(doubt, 'teacher');
    }

    // Convert to public URLs (no regeneration needed)
    for (const doubt of doubts as any[]) {
      if (doubt.messages && doubt.messages.length > 0) {
        for (const message of doubt.messages) {
          if (message.attachments && message.attachments.length > 0) {
            for (const attachment of message.attachments) {
              // Ensure URL is public URL format
              if (!attachment.url || !attachment.url.startsWith('https://storage.googleapis.com')) {
                attachment.url = `https://storage.googleapis.com/${bucket.name}/${attachment.storagePath}`;
              }
            }
          }
        }
      }
    }

    return res.json({
      doubts,
      total,
      page: Math.max(1, Number(page) || 1),
      totalPages,
      stats
    });
  } catch (error) {
    console.error('Error fetching doubts:', error);
    return res.status(500).json({ error: 'Failed to fetch doubts' });
  }
});

// POST - Teacher/admin starts (or continues) a conversation with student(s)
router.post('/teacher/start', authMiddleware, messageLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'teacher' && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only teachers can start conversations' });
    }

    const { studentIds, studentId, message, subject } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const rawIds: string[] = Array.isArray(studentIds)
      ? studentIds
      : studentId
        ? [studentId]
        : [];
    const validIds = rawIds.filter((id) => mongoose.Types.ObjectId.isValid(id));

    if (validIds.length === 0) {
      return res.status(400).json({ error: 'At least one valid student is required' });
    }

    const teacherId = (req.user?._id || req.user?.id) as string;
    const teacherObjId = new mongoose.Types.ObjectId(teacherId);
    const senderName = req.user?.name || 'Teacher';
    const senderRole = req.user.role as 'teacher' | 'admin';

    // Only message real INSTITUTE students. Public learners have no teacher
    // relationship and must never be reachable through institute doubt chats.
    const User = require('../../models/User').default;
    const students = await User.find({ _id: { $in: validIds }, role: 'student', ...INSTITUTE_ACCOUNT_CLAUSE })
      .select('_id name classLevel batch')
      .lean();

    if (students.length === 0) {
      return res.status(404).json({ error: 'No valid students found' });
    }

    const createdDoubts: any[] = [];

    for (const student of students) {
      const newMessage = {
        sender: teacherObjId,
        senderRole,
        message: message.trim(),
        attachments: [],
        createdAt: new Date(),
      };

      // Continue an existing thread between this teacher and student, else start one.
      let doubt = await Doubt.findOne({ student: student._id, teacher: teacherObjId });

      if (doubt) {
        doubt.messages.push(newMessage);
        doubt.status = 'in-progress';
        doubt.repliedAt = new Date();
        doubt.updatedAt = new Date();
        await doubt.save();
      } else {
        doubt = new Doubt({
          student: student._id,
          teacher: teacherObjId,
          subject: subject || 'General',
          question: message.trim(),
          batch: student.batch,
          classLevel: student.classLevel,
          status: 'in-progress',
          priority: 'normal',
          repliedAt: new Date(),
          messages: [newMessage],
        });
        await doubt.save();
      }

      const populated = await Doubt.findById(doubt._id)
        .populate('student', 'name email classLevel batch profileImage')
        .populate('teacher', 'name email profileImage')
        .populate('messages.sender', 'name email role profileImage')
        .lean();

      // Real-time update to the student's and teacher's chat lists / open chat.
      SocketService.emitDoubtUpdate(
        (doubt as any)._id.toString(),
        student._id.toString(),
        teacherObjId.toString(),
        'new_message',
        populated
      );

      // Notify the student a teacher reached out.
      createAndSendNotification({
        userId: student._id.toString(),
        title: `New message from ${senderName}`,
        body: message.substring(0, 100),
        type: 'doubt',
        data: {
          doubtId: (doubt as any)._id.toString(),
          type: 'doubt',
          role: 'student',
          screen: '/(student)/doubts',
        },
      }).catch((err) => console.error('Notification error:', err));

      createdDoubts.push(populated);
    }

    return res.status(201).json({ doubts: createdDoubts });
  } catch (error) {
    console.error('[TeacherStartDoubt] Error:', error);
    return res.status(500).json({ error: 'Failed to start conversation' });
  }
});

// GET - Single doubt details
router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    // Authorization first: this is the endpoint a notification deep link hits,
    // so the doubt id in a push payload must prove nothing on its own.
    const allowed = await loadAccessibleDoubt(req, res, req.params.id);
    if (!allowed) return;

    const doubt = await Doubt.findById(req.params.id)
      .populate('student', 'name email classLevel batch phone profileImage')
      .populate('teacher', 'name email profileImage')
      .populate('messages.sender', 'name email role profileImage');

    if (!doubt) {
      return res.status(404).json({ error: 'Doubt not found' });
    }

    // Convert to public URLs (no regeneration needed)
    if (doubt.messages && doubt.messages.length > 0) {
      for (const message of doubt.messages) {
        if (message.attachments && message.attachments.length > 0) {
          for (const attachment of message.attachments) {
            // Ensure URL is public URL format
            if (!attachment.url || !attachment.url.startsWith('https://storage.googleapis.com')) {
              attachment.url = `https://storage.googleapis.com/${bucket.name}/${attachment.storagePath}`;
            }
          }
        }
      }
    }

    return res.json(withActivityFields(doubt.toObject() as unknown as Record<string, unknown>));
  } catch (error) {
    console.error('Error fetching doubt:', error);
    return res.status(500).json({ error: 'Failed to fetch doubt' });
  }
});

// POST - Create doubt (student) - Start or continue conversation
router.post('/', authMiddleware, messageLimiter, async (req: AuthRequest, res: Response) => {
  try {
    console.log('[CreateDoubt] Request body:', JSON.stringify(req.body, null, 2));
    const { teacherId, message } = req.body;
    const studentId = req.user?._id || req.user?.id;

    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Validate and convert teacher ID
    let validTeacherId = null;
    if (teacherId && teacherId !== 'unassigned' && mongoose.Types.ObjectId.isValid(teacherId)) {
      const User = require('../../models/User').default;
      const teacherExists = await User.findById(teacherId).lean();
      if (teacherExists && (teacherExists.role === 'teacher' || teacherExists.role === 'admin')) {
        validTeacherId = new mongoose.Types.ObjectId(teacherId);
      }
    }

    // New Message Object
    const newMessage = {
      sender: new mongoose.Types.ObjectId(studentId),
      senderRole: 'student' as const,
      message: message.trim(),
      attachments: [],
      createdAt: new Date()
    };

    // Check for existing conversation (Doubt) with this teacher
    let doubt = await Doubt.findOne({
      student: studentId,
      teacher: validTeacherId
    });

    if (doubt) {
      console.log('[CreateDoubt] Found existing conversation:', doubt._id);
      // Append message to existing thread
      doubt.messages.push(newMessage);
      doubt.status = 'pending'; // Re-open or keep pending
      doubt.updatedAt = new Date(); // Bump timestamp
      
      // If unassigned doubt is now being assigned (unlikely in this flow, but good practice)
      if (!doubt.teacher && validTeacherId) {
        doubt.teacher = validTeacherId;
      }
      
      await doubt.save();
    } else {
      console.log('[CreateDoubt] Creating new conversation');
      // Create new doubt thread
      doubt = new Doubt({
        student: studentId,
        teacher: validTeacherId,
        subject: 'General', // Could be dynamic if needed
        question: message.trim(), // Keep initial question for reference
        batch: req.user?.batch,
        classLevel: req.user?.classLevel,
        status: 'pending',
        priority: 'normal',
        messages: [newMessage]
      });
      await doubt.save();
    }
    
    // Populate for response
    const populated = await Doubt.findById(doubt._id)
      .populate('student', 'name email classLevel batch profileImage')
      .populate('teacher', 'name email profileImage')
      .populate('messages.sender', 'name email role profileImage')
      .lean();
    
    // Emit socket event for new/updated conversation to user rooms
    SocketService.emitDoubtUpdate(
      (doubt as any)._id.toString(),
      studentId as string,
      validTeacherId ? validTeacherId.toString() : null,
      'new_message',
      populated
    );

    // Notify Teacher if assigned
    if (validTeacherId) {
      const senderName = req.user?.name || 'Student';
      createAndSendNotification({
        userId: validTeacherId.toString(),
        title: `New doubt from ${senderName}`,
        body: message.substring(0, 100),
        type: 'doubt',
        data: { doubtId: (doubt as any)._id.toString(), type: 'doubt', role: 'teacher', screen: '/(teacher)/doubts' }
      }).catch(err => console.error('Notification error:', err));
    } else {
      // Nobody owns this thread yet — page the whole eligible pool, scoped to
      // the student's own organization.
      void notifyUnassignedDoubt(
        (doubt as any)._id.toString(),
        req.user?.name || 'Student',
        message,
        populated,
      );
    }

    return res.status(201).json(populated);
  } catch (error) {
    console.error('[CreateDoubt] Error creating/updating doubt:', error);
    return res.status(500).json({ error: 'Failed to process doubt', details: (error as Error).message });
  }
});

// POST - Add message to doubt thread
router.post('/:id/messages', authMiddleware, messageLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const { message, attachments } = req.body;
    const userId = req.user?._id;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const doubt = await loadAccessibleDoubt(req, res, req.params.id);
    if (!doubt) return;

    // Add new message to the thread
    const sentAt = new Date();
    const newMessage = {
      sender: new mongoose.Types.ObjectId(userId as string),
      senderRole: req.user?.role as 'student' | 'teacher' | 'admin',
      message,
      attachments: attachments || [],
      createdAt: sentAt
    };

    doubt.messages.push(newMessage);
    // Ordering key for every list. Set here as well as in the model hook so a
    // caller reading `doubt` back before the save still sees the new value.
    doubt.lastMessageAt = sentAt;

    // ── Status, including REOPENING a resolved thread ────────────────────────
    // A resolved conversation is a state, not an ending. A new message from
    // either side moves it back into the active flow rather than being
    // rejected or silently appended to a thread nobody looks at again.
    const wasResolved = doubt.status === 'resolved';

    if (req.user?.role === 'student') {
      // If student replies, move back to pending so teacher sees it
      doubt.status = 'pending';
      doubt.studentLastReadAt = sentAt;
    } else if (req.user?.role === 'teacher' || req.user?.role === 'admin') {
      // If teacher replies, mark in-progress and assign
      doubt.status = 'in-progress';
      // Use userId directly - it's already an ObjectId from authMiddleware
      doubt.teacher = userId as any;
      doubt.repliedAt = sentAt;
      doubt.teacherLastReadAt = sentAt;
    }

    if (wasResolved) {
      console.log('[AddMessage] Reopened resolved doubt:', doubt._id.toString());
    }

    await doubt.save();

    const populatedRaw = await Doubt.findById(doubt._id)
      .populate('student', 'name email classLevel batch profileImage')
      .populate('teacher', 'name email profileImage')
      .populate('messages.sender', 'name email role profileImage')
      .lean();
    const populated = populatedRaw
      ? withActivityFields(populatedRaw as Record<string, unknown>)
      : populatedRaw;

    // Convert to public URLs for all attachments before sending via socket
    if (populated && (populated as any).messages) {
      for (const msg of (populated as any).messages) {
        if (msg.attachments && msg.attachments.length > 0) {
          for (const attachment of msg.attachments) {
            if (attachment.storagePath && (!attachment.url || !attachment.url.startsWith('https://storage.googleapis.com'))) {
              attachment.url = `https://storage.googleapis.com/${bucket.name}/${attachment.storagePath}`;
            }
          }
        }
      }
    }

    // Emit socket event to doubt room AND user rooms for real-time chat list updates
    const studentId = doubt.student.toString();
    const teacherIdStr = doubt.teacher ? doubt.teacher.toString() : null;
    SocketService.emitDoubtUpdate(
      doubt._id.toString(), 
      studentId, 
      teacherIdStr, 
      'new_message', 
      populated
    );

    // Send Notification with actual user name
    const senderName = req.user?.name || 'User';
    if (req.user?.role === 'student') {
      // Notify Teacher
      if (doubt.teacher) {
        await createAndSendNotification({
          userId: doubt.teacher.toString(),
          title: `New message from ${senderName}`,
          body: message.substring(0, 100),
          type: 'doubt',
          data: { doubtId: doubt._id, type: 'doubt', role: 'teacher', screen: '/(teacher)/doubts' }
        });
      } else {
        // Still unclaimed — the whole eligible pool needs to know, not nobody.
        void notifyUnassignedDoubt(
          doubt._id.toString(),
          senderName,
          message,
          populated,
        );
      }
    } else {
      // Notify Student
      await createAndSendNotification({
        userId: doubt.student.toString(),
        title: `Reply from ${senderName}`,
        body: message.substring(0, 100),
        type: 'doubt',
        data: { doubtId: doubt._id, type: 'doubt', role: 'student', screen: '/(student)/doubts' }
      });
    }

    return res.status(201).json(populated);
  } catch (error) {
    console.error('Error adding message:', error);
    return res.status(500).json({ error: 'Failed to add message' });
  }
});

// PUT - Reply to doubt (teacher) - Now adds message to thread
router.put('/:id/reply', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { reply, replyImages, attachments } = req.body;
    const teacherId = req.user?._id;

    if (req.user?.role !== 'teacher' && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only teachers can reply to doubts' });
    }

    if (!reply) {
      return res.status(400).json({ error: 'Reply is required' });
    }

    const doubt = await loadAccessibleDoubt(req, res, req.params.id);
    if (!doubt) return;

    // Add new message to the thread
    const sentAt = new Date();
    const newMessage = {
      sender: new mongoose.Types.ObjectId(teacherId as string),
      // Force sender role from token
      senderRole: req.user?.role as 'teacher' | 'admin',
      message: reply,
      attachments: attachments || [],
      createdAt: sentAt
    };

    doubt.messages.push(newMessage);
    doubt.reply = reply; // Keep for backward compatibility
    doubt.replyImages = replyImages || [];
    // Enforce teacher assignment
    doubt.teacher = new mongoose.Types.ObjectId(teacherId as string);
    doubt.repliedAt = sentAt;
    doubt.lastMessageAt = sentAt;
    doubt.teacherLastReadAt = sentAt;
    // Enforce status — a reply to a resolved thread reopens it.
    doubt.status = 'in-progress';

    await doubt.save();

    const populated = await Doubt.findById(doubt._id)
      .populate('student', 'name email classLevel batch profileImage')
      .populate('teacher', 'name email profileImage')
      .populate('messages.sender', 'name email role profileImage');

    // Emit socket event to doubt room AND user rooms for real-time chat list updates
    SocketService.emitDoubtUpdate(
      doubt._id.toString(),
      doubt.student.toString(),
      teacherId as string,
      'new_message',
      populated
    );

    // Notify Student with actual teacher name
    const senderName = req.user?.name || 'Teacher';
    await createAndSendNotification({
      userId: doubt.student.toString(),
      title: `Reply from ${senderName}`,
      body: reply.substring(0, 100),
      type: 'doubt',
      data: { doubtId: doubt._id, type: 'doubt', role: 'student', screen: '/(student)/doubts' }
    });

    return res.json(populated);
  } catch (error) {
    console.error('Error replying to doubt:', error);
    return res.status(500).json({ error: 'Failed to reply to doubt' });
  }
});

// PUT - Mark doubt as resolved
router.put('/:id/resolve', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'teacher' && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only teachers can resolve doubts' });
    }

    const existing = await loadAccessibleDoubt(req, res, req.params.id);
    if (!existing) return;

    // Resolving marks state only. It deliberately does NOT touch
    // `lastMessageAt`: resolving is not conversation activity, and letting it
    // bump the thread to the top of everyone's list would be noise. The thread
    // stays exactly where its last real message put it — and stays visible,
    // because no list filters `resolved` out by default.
    const doubt = await Doubt.findByIdAndUpdate(
      req.params.id,
      {
        status: 'resolved',
        teacher: req.user?._id
      },
      { new: true }
    ).populate('student', 'name email')
     .populate('teacher', 'name email');

    if (!doubt) {
      return res.status(404).json({ error: 'Doubt not found' });
    }

    const payload = withActivityFields(doubt.toObject() as unknown as Record<string, unknown>);

    // Tell both sides the state changed, so a resolve made on one device is
    // reflected on the other without a manual refresh.
    SocketService.emitDoubtUpdate(
      doubt._id.toString(),
      doubt.student._id ? doubt.student._id.toString() : doubt.student.toString(),
      doubt.teacher ? (doubt.teacher._id ?? doubt.teacher).toString() : null,
      'doubt_status',
      payload
    );

    return res.json(payload);
  } catch (error) {
    console.error('Error resolving doubt:', error);
    return res.status(500).json({ error: 'Failed to resolve doubt' });
  }
});

/**
 * PUT /:id/read — mark this conversation read for the caller.
 *
 * Read state is a per-participant timestamp rather than a boolean so it stays
 * correct when new messages arrive after the read: the unread count is derived
 * by comparison, never stored and never used to filter a conversation out of
 * a list.
 */
router.put('/:id/read', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const doubt = await loadAccessibleDoubt(req, res, req.params.id);
    if (!doubt) return;

    const now = new Date();
    if (req.user?.role === 'student') {
      doubt.studentLastReadAt = now;
    } else {
      doubt.teacherLastReadAt = now;
    }
    await doubt.save();

    return res.json({ success: true, readAt: now });
  } catch (error) {
    console.error('Error marking doubt read:', error);
    return res.status(500).json({ error: 'Failed to mark conversation as read' });
  }
});

// DELETE - Permanently delete a doubt chat (teacher/admin)
router.delete('/:id/permanent', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'teacher' && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only teachers or admins can permanently delete chats' });
    }

    const doubt = await loadAccessibleDoubt(req, res, req.params.id);
    if (!doubt) return;

    const storagePaths = new Set<string>();

    // Collect storage paths from embedded message attachments
    if (doubt.messages?.length) {
      for (const msg of doubt.messages) {
        if (msg.attachments?.length) {
          for (const att of msg.attachments) {
            if (att.storagePath) {
              storagePaths.add(att.storagePath);
            }
          }
        }
      }
    }

    // Collect storage paths from metadata documents
    const metadataDocs = await FileMetadata.find({ relatedDoubtId: doubt._id })
      .select('storagePath')
      .lean();

    for (const doc of metadataDocs) {
      if (doc.storagePath) {
        storagePaths.add(doc.storagePath);
      }
    }

    // Best-effort storage cleanup
    await Promise.all(
      Array.from(storagePaths).map(async (path) => {
        try {
          await bucket.file(path).delete({ ignoreNotFound: true });
        } catch (error) {
          console.error('[DoubtDelete] Failed to delete storage object:', path, error);
        }
      })
    );

    await FileMetadata.deleteMany({ relatedDoubtId: doubt._id });
    await doubt.deleteOne();

    SocketService.emitDoubtDeleted(
      req.params.id,
      doubt.student.toString(),
      doubt.teacher ? doubt.teacher.toString() : null,
    );

    return res.json({ message: 'Doubt chat permanently deleted' });
  } catch (error) {
    console.error('Error permanently deleting doubt:', error);
    return res.status(500).json({ error: 'Failed to permanently delete doubt chat' });
  }
});

// DELETE - Delete a specific message (sender can delete their own messages)
router.delete('/:doubtId/messages/:messageId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { doubtId, messageId } = req.params;
    const userId = (req.user?._id || req.user?.id)?.toString();

    const doubt = await loadAccessibleDoubt(req, res, doubtId);
    if (!doubt) return;

    const messageIndex = doubt.messages.findIndex(
      (m) => m._id?.toString() === messageId
    );
    if (messageIndex === -1) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const message = doubt.messages[messageIndex];

    // Only sender or admin can delete
    if (message.sender.toString() !== userId && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'You can only delete your own messages' });
    }

    // Collect attachment paths for cleanup
    const storagePaths: string[] = [];
    if (message.attachments?.length) {
      for (const att of message.attachments) {
        if (att.storagePath) storagePaths.push(att.storagePath);
      }
    }

    // Remove the message
    doubt.messages.splice(messageIndex, 1);
    await doubt.save();

    // Best-effort storage cleanup
    await Promise.all(
      storagePaths.map(async (path) => {
        try {
          await bucket.file(path).delete({ ignoreNotFound: true });
        } catch (err) {
          console.error('[DeleteMessage] Failed to delete storage object:', path, err);
        }
      })
    );
    if (storagePaths.length > 0) {
      await FileMetadata.deleteMany({
        relatedDoubtId: doubt._id,
        storagePath: { $in: storagePaths },
      });
    }

    // Populate and emit updated doubt
    const populated = await Doubt.findById(doubt._id)
      .populate('student', 'name email classLevel batch profileImage')
      .populate('teacher', 'name email profileImage')
      .populate('messages.sender', 'name email role profileImage')
      .lean();

    // Fix attachment URLs
    if (populated && (populated as any).messages) {
      for (const msg of (populated as any).messages) {
        if (msg.attachments?.length) {
          for (const att of msg.attachments) {
            if (att.storagePath && (!att.url || !att.url.startsWith('https://storage.googleapis.com'))) {
              att.url = `https://storage.googleapis.com/${bucket.name}/${att.storagePath}`;
            }
          }
        }
      }
    }

    const studentId = doubt.student.toString();
    const teacherIdStr = doubt.teacher ? doubt.teacher.toString() : null;

    SocketService.emitDoubtUpdate(
      doubt._id.toString(),
      studentId,
      teacherIdStr,
      'new_message',
      populated
    );

    return res.json({ success: true, message: 'Message deleted' });
  } catch (error) {
    console.error('Error deleting message:', error);
    return res.status(500).json({ error: 'Failed to delete message' });
  }
});

// DELETE - Delete doubt (admin only)
router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can delete doubts' });
    }

    const doubt = await Doubt.findByIdAndDelete(req.params.id);
    
    if (!doubt) {
      return res.status(404).json({ error: 'Doubt not found' });
    }

    return res.json({ message: 'Doubt deleted successfully' });
  } catch (error) {
    console.error('Error deleting doubt:', error);
    return res.status(500).json({ error: 'Failed to delete doubt' });
  }
});

export default router;
