import { Router, Request, Response } from 'express';
import StudentProgress from '../../models/StudentProgress';
import Material from '../../models/Material';
import Homework from '../../models/Homework';
import { authMiddleware } from '../../middlewares/authMiddleware';

const router = Router();

// Mark material/homework as viewed
router.post('/view', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { targetType, targetId } = req.body;
    
    if (!['material', 'homework'].includes(targetType)) {
      return res.status(400).json({ error: 'Invalid target type' });
    }
    
    const progress = await StudentProgress.findOneAndUpdate(
      { student: user.id, targetType, targetId },
      { 
        $setOnInsert: { student: user.id, targetType, targetId },
        $set: { viewedAt: new Date() },
        $min: { status: 'viewed' } // Only update if current status is less than 'viewed'
      },
      { upsert: true, new: true }
    );
    
    // Actually update status properly
    if (progress.status === 'not_started') {
      progress.status = 'viewed';
      await progress.save();
    }
    
    res.json(progress);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Mark material as completed
router.post('/complete', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { targetType, targetId } = req.body;
    
    if (!['material', 'homework'].includes(targetType)) {
      return res.status(400).json({ error: 'Invalid target type' });
    }
    
    const progress = await StudentProgress.findOneAndUpdate(
      { student: user.id, targetType, targetId },
      { 
        student: user.id,
        targetType,
        targetId,
        status: 'completed',
        completedAt: new Date(),
        viewedAt: new Date() // Ensure viewed is also set
      },
      { upsert: true, new: true }
    );
    
    res.json(progress);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Submit homework
router.post('/submit', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { targetId, submissionUrl, submissionFileName, submissionNotes } = req.body;
    
    // Check if homework exists and is still accepting submissions
    const homework = await Homework.findById(targetId);
    if (!homework) {
      return res.status(404).json({ error: 'Homework not found' });
    }
    
    if (homework.status === 'closed') {
      return res.status(400).json({ error: 'Homework is closed for submissions' });
    }
    
    // Check if past due date and late submissions not allowed
    if (homework.dueDate && new Date() > homework.dueDate && !homework.allowLateSubmission) {
      return res.status(400).json({ error: 'Submission deadline has passed' });
    }
    
    const progress = await StudentProgress.findOneAndUpdate(
      { student: user.id, targetType: 'homework', targetId },
      { 
        student: user.id,
        targetType: 'homework',
        targetId,
        status: 'submitted',
        submittedAt: new Date(),
        submissionUrl,
        submissionFileName,
        submissionNotes,
        viewedAt: new Date()
      },
      { upsert: true, new: true }
    );
    
    res.json(progress);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get current student's all progress
router.get('/my', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { targetType } = req.query;
    
    const query: any = { student: user.id };
    if (targetType) query.targetType = targetType;
    
    const progress = await StudentProgress.find(query)
      .sort({ updatedAt: -1 })
      .lean();
    
    res.json(progress);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get progress for a specific material (teacher view)
router.get('/material/:materialId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const progress = await StudentProgress.find({
      targetType: 'material',
      targetId: req.params.materialId
    })
      .populate('student', 'name email classLevel batch')
      .sort({ updatedAt: -1 })
      .lean();
    
    // Get material to know total assigned
    const material = await Material.findById(req.params.materialId).lean();
    
    res.json({ progress, material });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get progress for a specific homework (teacher view)
router.get('/homework/:homeworkId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const progress = await StudentProgress.find({
      targetType: 'homework',
      targetId: req.params.homeworkId
    })
      .populate('student', 'name email classLevel batch')
      .sort({ updatedAt: -1 })
      .lean();
    
    res.json(progress);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get aggregated stats for teacher dashboard
router.get('/stats', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // Get homework created by this teacher
    const homeworkList = await Homework.find({ createdBy: user.id, status: 'published' }).select('_id').lean();
    const homeworkIds = homeworkList.map(h => h._id);
    
    const stats = await StudentProgress.aggregate([
      { $match: { targetType: 'homework', targetId: { $in: homeworkIds } } },
      { $group: { 
        _id: '$status', 
        count: { $sum: 1 } 
      }}
    ]);
    
    res.json({
      totalHomework: homeworkIds.length,
      statusBreakdown: Object.fromEntries(stats.map(s => [s._id, s.count]))
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
