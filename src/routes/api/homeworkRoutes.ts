import { Router, Request, Response } from 'express';
import multer from 'multer';
import Homework from '../../models/Homework';
import StudentProgress from '../../models/StudentProgress';
import User from '../../models/User';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { uploadLimiter } from '../../middlewares/rateLimiter';
import { sendStudentNotifications } from '../../services/notificationService';
import { getFirestoreUserProfile, uploadToFirebase } from '../../services/firebaseService';
import { attachmentFileFilter, resolveContentType } from '../../utils/uploadFileTypes';
import { INSTITUTE_ACCOUNT_CLAUSE } from '../../utils/instituteAudience';

const router = Router();

// Configure multer for memory storage. Accept PDFs/images by mimetype OR extension
// so files the app lets teachers pick (HEIC photos, Drive PDFs sent as
// application/octet-stream, image/jpg) are not rejected. See uploadFileTypes.ts.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
  fileFilter: attachmentFileFilter,
});
const normalizeClassValue = (value: unknown): string =>
  typeof value === 'string'
    ? value.replace(/Class\s*/i, '').trim()
    : '';

const buildClassVariants = (values: unknown): string[] => {
  const list = Array.isArray(values) ? values : [values];
  const variants = new Set<string>();

  list.forEach((value) => {
    if (value === null || value === undefined) return;
    const raw = String(value).trim();
    if (!raw) return;

    const normalized = normalizeClassValue(raw);
    if (normalized) {
      variants.add(normalized);
      variants.add(`Class ${normalized}`);
    }
    variants.add(raw);
  });

  return Array.from(variants);
};

const normalizeBatchList = (values: unknown): string[] => {
  const list = Array.isArray(values)
    ? values
    : typeof values === 'string'
      ? values.split(',')
      : [];

  return list
    .map((value) => String(value || '').trim())
    .filter(Boolean);
};

// Helper to get assigned student IDs based on homework assignment type
async function getAssignedStudentIds(homework: any): Promise<string[]> {
  if (homework.assignmentType === 'students') {
    return (homework.assignedStudents || []).map((id: any) => id.toString());
  }

  const query: any = { role: 'student', ...INSTITUTE_ACCOUNT_CLAUSE };
  const classScope = buildClassVariants(
    homework.assignmentType === 'class'
      ? homework.assignedClasses
      : [homework.classLevel, ...(homework.assignedClasses || [])]
  );

  if (homework.assignmentType === 'class') {
    if (classScope.length === 0) return [];
    query.classLevel = { $in: classScope };
  } else if (homework.assignmentType === 'batch') {
    const batchScope = normalizeBatchList(homework.assignedBatches);
    if (batchScope.length === 0) return [];
    if (classScope.length > 0) {
      query.classLevel = { $in: classScope };
    }
    query.batch = { $in: batchScope };
  } else {
    // 'all' should still be scoped to the homework's class level
    if (classScope.length === 0) return [];
    query.classLevel = { $in: classScope };
  }

  const students = await User.find(query).select('_id').lean();
  return students.map(s => s._id.toString());
}

// Get homework list (filtered by user role)
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { status, subject, classLevel, page = 1, limit = 20 } = req.query;
    
    let query: any = {};
    
    if (user.role === 'teacher') {
      // Teachers see homework they created
      query.createdBy = user.id;
      if (status) query.status = status;
    } else if (user.role === 'student') {
      // Fetch student's full data from DB (JWT may not include classLevel/batch)
      const studentData = await User.findById(user.id).select('classLevel batch firebaseUid').lean();
      let userClassLevel = studentData?.classLevel || '';
      let userBatch = studentData?.batch || '';
      
      // If not in User DB, try Firestore as fallback
      if ((!userClassLevel || !userBatch) && studentData?.firebaseUid) {
        const firestoreProfile = await getFirestoreUserProfile(studentData.firebaseUid);
        if (firestoreProfile) {
          userClassLevel = userClassLevel || firestoreProfile.classLevel || '';
          userBatch = userBatch || firestoreProfile.batch || '';
        }
      }
      
      // Normalize classLevel format
      const classNum = userClassLevel.replace(/Class\s*/i, '').trim();
      const classLevelVariants = [classNum, `Class ${classNum}`, userClassLevel].filter(v => v && v !== 'Class ');
      
      console.log('[Homework] Student query:', { userId: user.id, classLevelVariants, userBatch });
      
      // Students see published homework assigned to them
      query.status = 'published';

      // Build $or conditions — always scope to the student's own class to prevent
      // cross-class leakage when batch names or "all" assignments overlap.
      const orConditions: any[] = [
        // "all" type: only if the homework's classLevel matches the student's class
        { assignmentType: 'all', classLevel: { $in: classLevelVariants } },
        // "class" type: homework explicitly targeting this student's class
        { assignmentType: 'class', assignedClasses: { $in: classLevelVariants } },
        // "students" type: homework targeting this student directly (no class filter needed)
        { assignmentType: 'students', assignedStudents: user.id },
      ];

      // Only add batch condition when the student actually has a batch assigned —
      // AND scope it to the student's class so same-named batches across classes don't bleed.
      if (userBatch) {
        orConditions.push({
          assignmentType: 'batch',
          classLevel: { $in: classLevelVariants },
          assignedBatches: userBatch,
        });
      }

      query.$or = orConditions;
    } else if (user.role === 'admin') {
      // Admin sees all
      if (status) query.status = status;
    }
    
    if (subject) query.subject = subject;
    if (classLevel) query.classLevel = classLevel;
    
    const skip = (Number(page) - 1) * Number(limit);
    
    const [homework, total] = await Promise.all([
      Homework.find(query)
        .populate('createdBy', 'name')
        .populate('material', 'title type fileUrl')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Homework.countDocuments(query)
    ]);
    
    // For students, include their progress status
    if (user.role === 'student') {
      const homeworkIds = homework.map(h => h._id);
      const progress = await StudentProgress.find({
        student: user.id,
        targetType: 'homework',
        targetId: { $in: homeworkIds }
      }).lean();
      
      const progressMap = new Map(progress.map(p => [p.targetId.toString(), p]));
      
      const homeworkWithProgress = homework.map(h => ({
        ...h,
        myProgress: progressMap.get(h._id.toString()) || { status: 'not_started' }
      }));
      
      return res.json({ homework: homeworkWithProgress, total, page: Number(page), limit: Number(limit) });
    }
    
    res.json({ homework, total, page: Number(page), limit: Number(limit) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get single homework details
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const homework = await Homework.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('material')
      .lean();
    
    if (!homework) {
      return res.status(404).json({ error: 'Homework not found' });
    }
    
    // For students, verify access and include their progress
    if (user.role === 'student') {
      // Validate the student is actually allowed to see this homework
      const studentData = await User.findById(user.id).select('classLevel batch firebaseUid').lean();
      let userClassLevel = studentData?.classLevel || '';
      let userBatch = studentData?.batch || '';

      if ((!userClassLevel || !userBatch) && studentData?.firebaseUid) {
        const firestoreProfile = await getFirestoreUserProfile(studentData.firebaseUid);
        if (firestoreProfile) {
          userClassLevel = userClassLevel || firestoreProfile.classLevel || '';
          userBatch = userBatch || firestoreProfile.batch || '';
        }
      }

      const classNum = userClassLevel.replace(/Class\s*/i, '').trim();
      const classLevelVariants = [classNum, `Class ${classNum}`, userClassLevel].filter(v => v && v !== 'Class ');

      const hw = homework as any;
      const isAllowed =
        (hw.assignmentType === 'all' && classLevelVariants.includes(hw.classLevel)) ||
        (hw.assignmentType === 'class' && hw.assignedClasses?.some((c: string) => classLevelVariants.includes(c))) ||
        (hw.assignmentType === 'batch' && userBatch && classLevelVariants.includes(hw.classLevel) && hw.assignedBatches?.includes(userBatch)) ||
        (hw.assignmentType === 'students' && hw.assignedStudents?.map((id: any) => id.toString()).includes(user.id));

      if (!isAllowed) {
        return res.status(403).json({ error: 'You are not assigned this homework' });
      }

      const progress = await StudentProgress.findOne({
        student: user.id,
        targetType: 'homework',
        targetId: homework._id
      }).lean();
      
      return res.json({ ...homework, myProgress: progress || { status: 'not_started' } });
    }
    
    // For teachers, include submission stats
    if (user.role === 'teacher' || user.role === 'admin') {
      const studentIds = await getAssignedStudentIds(homework);
      const progressStats = await StudentProgress.aggregate([
        { $match: { targetType: 'homework', targetId: homework._id } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);
      
      const statsMap = Object.fromEntries(progressStats.map(s => [s._id, s.count]));
      
      return res.json({
        ...homework,
        stats: {
          totalAssigned: studentIds.length,
          notStarted: studentIds.length - (await StudentProgress.countDocuments({ targetType: 'homework', targetId: homework._id })),
          viewed: statsMap['viewed'] || 0,
          inProgress: statsMap['in_progress'] || 0,
          completed: statsMap['completed'] || 0,
          submitted: statsMap['submitted'] || 0
        }
      });
    }
    
    res.json(homework);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create homework (teachers/admin only)
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const homework = new Homework({
      ...req.body,
      createdBy: user.id
    });
    
    await homework.save();
    
    // Send notifications if published
    if (homework.status === 'published') {
      const studentIds = await getAssignedStudentIds(homework);
      if (studentIds.length > 0) {
        sendStudentNotifications(
          studentIds,
          'New Homework Assigned',
          `${homework.title} - Due: ${homework.dueDate ? new Date(homework.dueDate).toLocaleDateString() : 'No due date'}`,
          { type: 'homework', homeworkId: homework._id },
          'homework'
        );
      }
    }
    
    res.status(201).json(homework);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update homework
router.put('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const homework = await Homework.findById(req.params.id);
    if (!homework) {
      return res.status(404).json({ error: 'Homework not found' });
    }
    
    // Only creator or admin can update
    if (user.role !== 'admin' && homework.createdBy.toString() !== user.id) {
      return res.status(403).json({ error: 'Not authorized to update this homework' });
    }
    
    const wasPublished = homework.status === 'published';
    
    Object.assign(homework, req.body);
    await homework.save();
    
    // Notify if just published
    if (!wasPublished && homework.status === 'published') {
      const studentIds = await getAssignedStudentIds(homework);
      if (studentIds.length > 0) {
        sendStudentNotifications(
          studentIds,
          'New Homework Assigned',
          `${homework.title} - Due: ${homework.dueDate ? new Date(homework.dueDate).toLocaleDateString() : 'No due date'}`,
          { type: 'homework', homeworkId: homework._id },
          'homework'
        );
      }
    }
    
    res.json(homework);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete homework
router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const homework = await Homework.findById(req.params.id);
    if (!homework) {
      return res.status(404).json({ error: 'Homework not found' });
    }
    
    if (user.role !== 'admin' && homework.createdBy.toString() !== user.id) {
      return res.status(403).json({ error: 'Not authorized to delete this homework' });
    }
    
    // Delete associated progress records
    await StudentProgress.deleteMany({ targetType: 'homework', targetId: homework._id });
    await homework.deleteOne();
    
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get student submissions for a homework (teacher view)
router.get('/:id/submissions', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const submissions = await StudentProgress.find({
      targetType: 'homework',
      targetId: req.params.id
    })
      .populate('student', 'name email classLevel batch profileImage')
      .sort({ submittedAt: -1 })
      .lean();
    
    res.json(submissions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Grade a submission
router.post('/:id/grade/:studentId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { grade, feedback } = req.body;
    
    const progress = await StudentProgress.findOneAndUpdate(
      {
        targetType: 'homework',
        targetId: req.params.id,
        student: req.params.studentId
      },
      {
        grade,
        feedback,
        gradedBy: user.id,
        gradedAt: new Date()
      },
      { new: true }
    );
    
    if (!progress) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    
    // Notify student
    sendStudentNotifications(
      [req.params.studentId],
      'Homework Graded',
      `Your homework has been graded. Grade: ${grade}`,
      { type: 'homework_graded', homeworkId: req.params.id },
      'homework'
    );
    
    res.json(progress);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Upload attachment to homework (teachers/admin only)
router.post('/:id/upload', authMiddleware, uploadLimiter, upload.single('file'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const homework = await Homework.findById(req.params.id);
    if (!homework) {
      return res.status(404).json({ error: 'Homework not found' });
    }
    
    // Check ownership
    if (user.role !== 'admin' && homework.createdBy.toString() !== user.id) {
      return res.status(403).json({ error: 'Not authorized to modify this homework' });
    }
    
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    
    // Normalize the content type: the picker may report a generic/missing mimetype
    // (e.g. application/octet-stream for a PDF picked from Drive). Infer it from the
    // file extension so the object stores and serves with the correct type.
    const contentType = resolveContentType(file.mimetype, file.originalname);

    console.log('[Homework] Uploading file:', file.originalname, file.mimetype, '->', contentType, file.size);

    // Upload to Firebase Storage
    const storagePath = `homework/${homework._id}/${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const fileUrl = await uploadToFirebase(file.buffer, storagePath, contentType);

    // Add attachment to homework
    const attachment = {
      fileUrl,
      fileName: file.originalname,
      mimeType: contentType,
      fileSize: file.size
    };
    
    homework.attachments.push(attachment);
    await homework.save();
    
    console.log('[Homework] Attachment added:', attachment.fileName);
    
    res.json({ success: true, attachment });
  } catch (error: any) {
    console.error('[Homework] Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete attachment from homework (teachers/admin only)
router.delete('/:id/attachment/:attachmentIndex', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const homework = await Homework.findById(req.params.id);
    if (!homework) {
      return res.status(404).json({ error: 'Homework not found' });
    }
    
    if (user.role !== 'admin' && homework.createdBy.toString() !== user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const index = parseInt(req.params.attachmentIndex);
    if (index < 0 || index >= homework.attachments.length) {
      return res.status(400).json({ error: 'Invalid attachment index' });
    }
    
    homework.attachments.splice(index, 1);
    await homework.save();
    
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
