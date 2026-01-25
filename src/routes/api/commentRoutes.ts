import { Router, Request, Response } from 'express';
import MaterialComment from '../../models/MaterialComment';
import { authMiddleware } from '../../middlewares/authMiddleware';

const router = Router();

// Add a comment
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { targetType, targetId, content, parentComment } = req.body;
    
    if (!['material', 'homework'].includes(targetType)) {
      return res.status(400).json({ error: 'Invalid target type' });
    }
    
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Comment content is required' });
    }
    
    const comment = new MaterialComment({
      targetType,
      targetId,
      author: user.id,
      content: content.trim(),
      parentComment: parentComment || undefined
    });
    
    await comment.save();
    
    // Populate author info before returning
    await comment.populate('author', 'name role');
    
    res.status(201).json(comment);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get comments for a material/homework
router.get('/:targetType/:targetId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { targetType, targetId } = req.params;
    
    if (!['material', 'homework'].includes(targetType)) {
      return res.status(400).json({ error: 'Invalid target type' });
    }
    
    const comments = await MaterialComment.find({
      targetType,
      targetId,
      isDeleted: false
    })
      .populate('author', 'name role profileImage')
      .populate({
        path: 'parentComment',
        select: 'content author',
        populate: { path: 'author', select: 'name' }
      })
      .sort({ createdAt: -1 })
      .lean();
    
    res.json(comments);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete own comment (soft delete)
router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    
    const comment = await MaterialComment.findById(req.params.id);
    
    if (!comment) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    
    // Only author, teacher, or admin can delete
    if (user.role !== 'admin' && user.role !== 'teacher' && comment.author.toString() !== user.id) {
      return res.status(403).json({ error: 'Not authorized to delete this comment' });
    }
    
    comment.isDeleted = true;
    await comment.save();
    
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
