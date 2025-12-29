import { Router, Request, Response } from 'express';
import Bookmark from '../../models/Bookmark';
import { authMiddleware } from '../../middlewares/authMiddleware';

const router = Router();

// Get all bookmarks for current user
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const bookmarks = await Bookmark.find({ studentId: user.id })
      .populate('courseId', 'title subject thumbnail')
      .sort({ createdAt: -1 })
      .lean();
    
    res.json(bookmarks);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get bookmarks for a specific course
router.get('/course/:courseId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const bookmarks = await Bookmark.find({ 
      studentId: user.id,
      courseId: req.params.courseId 
    }).sort({ createdAt: -1 }).lean();
    
    res.json(bookmarks);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Add a bookmark
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { courseId, lectureId, lectureTitle, timestamp, note } = req.body;
    
    if (!courseId || !lectureId || !lectureTitle) {
      return res.status(400).json({ error: 'courseId, lectureId, and lectureTitle are required' });
    }
    
    // Upsert bookmark
    const bookmark = await Bookmark.findOneAndUpdate(
      { studentId: user.id, courseId, lectureId },
      { 
        studentId: user.id, 
        courseId, 
        lectureId, 
        lectureTitle,
        timestamp: timestamp || 0,
        note 
      },
      { upsert: true, new: true }
    );
    
    res.status(201).json(bookmark);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Remove a bookmark
router.delete('/:bookmarkId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const bookmark = await Bookmark.findOneAndDelete({
      _id: req.params.bookmarkId,
      studentId: user.id
    });
    
    if (!bookmark) {
      return res.status(404).json({ error: 'Bookmark not found' });
    }
    
    res.json({ success: true, message: 'Bookmark removed' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Remove bookmark by lecture
router.delete('/lecture/:courseId/:lectureId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const bookmark = await Bookmark.findOneAndDelete({
      studentId: user.id,
      courseId: req.params.courseId,
      lectureId: req.params.lectureId
    });
    
    if (!bookmark) {
      return res.status(404).json({ error: 'Bookmark not found' });
    }
    
    res.json({ success: true, message: 'Bookmark removed' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
