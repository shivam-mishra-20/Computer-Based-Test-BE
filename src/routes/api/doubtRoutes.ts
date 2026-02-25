import { Router, Request, Response } from 'express';
import Doubt, { IDoubt } from '../../models/Doubt';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { messageLimiter } from '../../middlewares/rateLimiter';
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

interface AuthRequest extends Request {
  user?: IUser & { _id: any };
}

const router = Router();

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
router.post('/upload-url', authMiddleware, generateUploadUrl);
router.post('/upload', authMiddleware, upload.single('file'), uploadDoubtFile);
router.get('/files/:fileId/url', authMiddleware, getFileSignedUrl);
router.delete('/files/:fileId', authMiddleware, deleteDoubtFile);

// POST - Save Firebase Storage file metadata
router.post('/save-file-metadata', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { url, fileName, fileType, fileSize, doubtId, storagePath } = req.body;

    if (!url || !fileName || !fileType || !doubtId || !storagePath) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Save metadata to MongoDB
    const fileMetadata = new FileMetadata({
      url, // This might be the signed URL or a public URL
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
        url,
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

    const filter: any = { student: studentId };
    
    if (status) filter.status = status;

    const skip = (Number(page) - 1) * Number(limit);

    const [doubts, total] = await Promise.all([
      Doubt.find(filter)
        .populate('student', 'name email classLevel batch profileImage')
        .populate('teacher', 'name email profileImage')
        .populate('messages.sender', 'name email role profileImage')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Doubt.countDocuments(filter)
    ]);

    console.log('[GET /student/my-doubts] Found doubts:', doubts.length);

    // Ensure teacher field exists in all doubts
    // If doubt.teacher is null, try to extract teacher info from messages
    const doubtsWithTeacher = (doubts as any[]).map(doubt => {
      if (doubt.teacher) {
        console.log(`[GET /student/my-doubts] Doubt ${doubt._id} has teacher:`, doubt.teacher?.name);
        return doubt;
      }
      
      // Debug: Log all messages with their senderRole
      console.log(`[GET /student/my-doubts] Doubt ${doubt._id} has no teacher field, checking ${doubt.messages?.length || 0} messages`);
      doubt.messages?.forEach((m: any, i: number) => {
        console.log(`  Message ${i}: senderRole=${m.senderRole}, sender=${m.sender ? (typeof m.sender === 'object' ? m.sender.name : m.sender) : 'null'}`);
      });
      
      // Find a teacher/admin message with populated sender
      const teacherMessage = doubt.messages?.find(
        (m: any) => (m.senderRole === 'teacher' || m.senderRole === 'admin') && m.sender && typeof m.sender === 'object' && m.sender.name
      );
      
      if (teacherMessage && teacherMessage.sender) {
        console.log(`[GET /student/my-doubts] Found teacher from message: ${teacherMessage.sender.name}`);
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
      
      console.log(`[GET /student/my-doubts] No teacher message found, returning null teacher`);
      return {
        ...doubt,
        teacher: null
      };
    });

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

    // Group doubts by status for dashboard stats
    const stats = await Doubt.aggregate([
      { $match: { student: new mongoose.Types.ObjectId(studentId as string) } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    return res.json({
      doubts: doubtsWithTeacher,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / Number(limit)),
      stats: stats.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {})
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
    const teacherId = req.user?._id || req.user?.id;

    if (req.user?.role !== 'teacher' && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const filter: any = {};
    
    console.log('[GET /teacher] Query:', req.query);
    console.log('[GET /teacher] User ID:', teacherId);
    console.log('[GET /teacher] User role:', req.user?.role);
    
    // Teachers see doubts assigned to them OR where they've participated OR unassigned doubts
    if (req.user?.role === 'teacher') {
      const teacherObjectId = new mongoose.Types.ObjectId(teacherId as string);
      
      filter.$or = [
        { teacher: teacherObjectId },
        { teacher: { $exists: false } },
        { teacher: null },
        { 'messages.sender': teacherObjectId }  // This will match if ANY message has this sender
      ];
      
      console.log('[GET /teacher] Teacher ObjectId:', teacherObjectId);
    }

    if (status) filter.status = status;
    if (batch) filter.batch = batch;
    if (subject) filter.subject = subject;

    console.log('[GET /teacher] Final filter:', JSON.stringify(filter, null, 2));

    const skip = (Number(page) - 1) * Number(limit);
    
    // Debug: Log all doubts for this teacher (regardless of filter)
    const allDoubtsWithTeacher = await Doubt.countDocuments({ teacher: new mongoose.Types.ObjectId(teacherId as string) });
    const allDoubtsWithMessages = await Doubt.countDocuments({ 'messages.sender': new mongoose.Types.ObjectId(teacherId as string) });
    console.log('[GET /teacher] Debug - Doubts with teacher field:', allDoubtsWithTeacher);
    console.log('[GET /teacher] Debug - Doubts with messages from teacher:', allDoubtsWithMessages);

    const [doubts, total] = await Promise.all([
      Doubt.find(filter)
        .populate('student', 'name email classLevel batch profileImage')
        .populate('teacher', 'name email profileImage')
        .populate('messages.sender', 'name email role profileImage')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Doubt.countDocuments(filter)
    ]);

    console.log('[GET /teacher] Found doubts:', doubts.length);
    console.log('[GET /teacher] Total count:', total);
    
    if (doubts.length > 0) {
      console.log('[GET /teacher] First doubt sample:', JSON.stringify({
        _id: doubts[0]._id,
        teacher: doubts[0].teacher,
        student: doubts[0].student,
        messagesCount: doubts[0].messages?.length,
        firstMessageSender: doubts[0].messages?.[0]?.sender
      }, null, 2));
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

    // Group doubts by status for dashboard stats
    const stats = await Doubt.aggregate([
      { $match: filter },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    return res.json({
      doubts,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / Number(limit)),
      stats: stats.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {})
    });
  } catch (error) {
    console.error('Error fetching doubts:', error);
    return res.status(500).json({ error: 'Failed to fetch doubts' });
  }
});

// GET - Single doubt details
router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
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

    return res.json(doubt);
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
        title: `Message from ${senderName}`,
        body: message.substring(0, 100),
        data: { doubtId: (doubt as any)._id.toString(), type: 'doubt_message' }
      }).catch(err => console.error('Notification error:', err));
    } else {
       // logic for unassigned notification could go here
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

    const doubt = await Doubt.findById(req.params.id);
    
    if (!doubt) {
      return res.status(404).json({ error: 'Doubt not found' });
    }

    // Add new message to the thread
    const newMessage = {
      sender: new mongoose.Types.ObjectId(userId as string),
      senderRole: req.user?.role as 'student' | 'teacher' | 'admin',
      message,
      attachments: attachments || [],
      createdAt: new Date()
    };

    doubt.messages.push(newMessage);
    
    // Update status logic
    if (req.user?.role === 'student') {
      // If student replies, move back to pending so teacher sees it
      doubt.status = 'pending';
      console.log('[AddMessage] Student replied, status set to pending');
    } else if (req.user?.role === 'teacher' || req.user?.role === 'admin') {
      // If teacher replies, mark in-progress and assign
      doubt.status = 'in-progress';
      // Use userId directly - it's already an ObjectId from authMiddleware
      doubt.teacher = userId as any;
      doubt.repliedAt = new Date();
      console.log('[AddMessage] Teacher replied, assigning teacher:', userId, 'to doubt:', doubt._id);
    }

    await doubt.save();

    const populated = await Doubt.findById(doubt._id)
      .populate('student', 'name email classLevel batch profileImage')
      .populate('teacher', 'name email profileImage')
      .populate('messages.sender', 'name email role profileImage')
      .lean();
    
    console.log('[AddMessage] After save - Doubt teacher:', doubt.teacher, 'Messages count:', doubt.messages.length);

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
          data: { doubtId: doubt._id, type: 'doubt_message' }
        });
      }
    } else {
      // Notify Student
      await createAndSendNotification({
        userId: doubt.student.toString(),
        title: `Reply from ${senderName}`,
        body: message.substring(0, 100),
        data: { doubtId: doubt._id, type: 'doubt_message' }
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

    const doubt = await Doubt.findById(req.params.id);
    
    if (!doubt) {
      return res.status(404).json({ error: 'Doubt not found' });
    }

    // Add new message to the thread
    const newMessage = {
      sender: new mongoose.Types.ObjectId(teacherId as string),
      // Force sender role from token
      senderRole: req.user?.role as 'teacher' | 'admin',
      message: reply,
      attachments: attachments || [],
      createdAt: new Date()
    };

    doubt.messages.push(newMessage);
    doubt.reply = reply; // Keep for backward compatibility
    doubt.replyImages = replyImages || [];
    // Enforce teacher assignment
    doubt.teacher = new mongoose.Types.ObjectId(teacherId as string);
    doubt.repliedAt = new Date();
    // Enforce status
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
      data: { doubtId: doubt._id, type: 'doubt_message' }
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

    return res.json(doubt);
  } catch (error) {
    console.error('Error resolving doubt:', error);
    return res.status(500).json({ error: 'Failed to resolve doubt' });
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
