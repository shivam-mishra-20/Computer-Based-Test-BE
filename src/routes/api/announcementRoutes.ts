import { Router, Request, Response } from 'express';
import Announcement from '../../models/Announcement';
import { authMiddleware } from '../../middlewares/authMiddleware';

const router = Router();

// Get announcements for current user
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { limit = 20 } = req.query;
    
    const now = new Date();
    
    // Build query based on user role and class/batch
    const query: any = {
      isPublished: true,
      $or: [
        { expiresAt: { $exists: false } },
        { expiresAt: { $gt: now } }
      ]
    };
    
    // Target filtering
    const targetFilters: any[] = [
      { target: 'all' }
    ];
    
    if (user.role === 'student') {
      targetFilters.push({ target: 'students' });
      if (user.classLevel) {
        targetFilters.push({ target: 'class', targetClass: user.classLevel });
      }
      if (user.batch) {
        targetFilters.push({ target: 'batch', targetBatch: user.batch });
      }
    } else if (['teacher', 'admin'].includes(user.role)) {
      targetFilters.push({ target: 'teachers' });
    }
    
    query.$and = [{ $or: targetFilters }];
    
    const announcements = await Announcement.find(query)
      .populate('createdBy', 'name')
      .sort({ priority: -1, createdAt: -1 })
      .limit(Number(limit))
      .lean();
    
    res.json(announcements);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Create announcement
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const announcement = new Announcement({
      ...req.body,
      createdBy: user.id
    });
    
    await announcement.save();
    res.status(201).json(announcement);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Update announcement
router.put('/:announcementId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const announcement = await Announcement.findByIdAndUpdate(
      req.params.announcementId,
      req.body,
      { new: true }
    );
    
    if (!announcement) {
      return res.status(404).json({ error: 'Announcement not found' });
    }
    
    res.json(announcement);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Delete announcement
router.delete('/:announcementId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    await Announcement.findByIdAndDelete(req.params.announcementId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
