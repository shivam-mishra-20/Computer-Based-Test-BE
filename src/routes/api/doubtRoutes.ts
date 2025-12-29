import { Router, Request, Response } from 'express';
import Doubt, { IDoubt } from '../../models/Doubt';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { IUser } from '../../models/User';

interface AuthRequest extends Request {
  user?: IUser & { _id: any };
}

const router = Router();

// GET - Fetch doubts for teacher (with filters)
router.get('/teacher', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { status, batch, subject, page = 1, limit = 20 } = req.query;
    const teacherId = req.user?._id;

    if (req.user?.role !== 'teacher' && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const filter: any = {};
    
    // Teachers see doubts assigned to them or in their batches
    if (req.user?.role === 'teacher') {
      filter.$or = [
        { teacher: teacherId },
        { batch: req.user.batch }
      ];
    }

    if (status) filter.status = status;
    if (batch) filter.batch = batch;
    if (subject) filter.subject = subject;

    const skip = (Number(page) - 1) * Number(limit);

    const [doubts, total] = await Promise.all([
      Doubt.find(filter)
        .populate('student', 'name email classLevel batch')
        .populate('teacher', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Doubt.countDocuments(filter)
    ]);

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
      .populate('student', 'name email classLevel batch phone')
      .populate('teacher', 'name email');

    if (!doubt) {
      return res.status(404).json({ error: 'Doubt not found' });
    }

    return res.json(doubt);
  } catch (error) {
    console.error('Error fetching doubt:', error);
    return res.status(500).json({ error: 'Failed to fetch doubt' });
  }
});

// POST - Create doubt (student)
router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { subject, topic, chapter, question, images } = req.body;
    const studentId = req.user?._id;

    if (!subject || !question) {
      return res.status(400).json({ error: 'Subject and question are required' });
    }

    const doubt = new Doubt({
      student: studentId,
      subject,
      topic,
      chapter,
      question,
      images: images || [],
      batch: req.user?.batch,
      classLevel: req.user?.classLevel,
      status: 'pending',
      priority: 'normal'
    });

    await doubt.save();
    
    const populated = await Doubt.findById(doubt._id)
      .populate('student', 'name email classLevel batch');

    return res.status(201).json(populated);
  } catch (error) {
    console.error('Error creating doubt:', error);
    return res.status(500).json({ error: 'Failed to create doubt' });
  }
});

// PUT - Reply to doubt (teacher)
router.put('/:id/reply', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { reply, replyImages } = req.body;
    const teacherId = req.user?._id;

    if (req.user?.role !== 'teacher' && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only teachers can reply to doubts' });
    }

    if (!reply) {
      return res.status(400).json({ error: 'Reply is required' });
    }

    const doubt = await Doubt.findByIdAndUpdate(
      req.params.id,
      {
        reply,
        replyImages: replyImages || [],
        teacher: teacherId,
        repliedAt: new Date(),
        status: 'in-progress'
      },
      { new: true }
    ).populate('student', 'name email classLevel batch')
     .populate('teacher', 'name email');

    if (!doubt) {
      return res.status(404).json({ error: 'Doubt not found' });
    }

    return res.json(doubt);
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
