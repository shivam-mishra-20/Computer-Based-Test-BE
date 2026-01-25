import { Router, Request, Response } from 'express';
import multer from 'multer';
import Homework from '../../models/Homework';
import StudentProgress from '../../models/StudentProgress';
import User from '../../models/User';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { sendStudentNotifications } from '../../services/notificationService';
import { getFirestoreUserProfile, uploadToFirebase } from '../../services/firebaseService';

const router = Router();

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and image files allowed'));
    }
  }
});
// Helper to get assigned student IDs based on homework assignment type
async function getAssignedStudentIds(homework: any): Promise<string[]> {
  if (homework.assignmentType === 'students') {
    return homework.assignedStudents.map((id: any) => id.toString());
  }
  
  const query: any = { role: 'student' };
  
  if (homework.assignmentType === 'class') {
    query.classLevel = { $in: homework.assignedClasses };
  } else if (homework.assignmentType === 'batch') {
    query.batch = { $in: homework.assignedBatches };
  }
  // For 'all', no filter needed - gets all students
  
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
      query.$or = [
        { assignmentType: 'all' },
        { assignmentType: 'class', assignedClasses: { $in: classLevelVariants } },
        { assignmentType: 'batch', assignedBatches: userBatch },
        { assignmentType: 'students', assignedStudents: user.id }
      ];
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
    
    // For students, include their progress
    if (user.role === 'student') {
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
      .populate('student', 'name email classLevel batch')
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
router.post('/:id/upload', authMiddleware, upload.single('file'), async (req: Request, res: Response) => {
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
    
    console.log('[Homework] Uploading file:', file.originalname, file.mimetype, file.size);
    
    // Upload to Firebase Storage
    const storagePath = `homework/${homework._id}/${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const fileUrl = await uploadToFirebase(file.buffer, storagePath, file.mimetype);
    
    // Add attachment to homework
    const attachment = {
      fileUrl,
      fileName: file.originalname,
      mimeType: file.mimetype,
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
