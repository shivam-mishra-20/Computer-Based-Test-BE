import { Router, Request, Response } from 'express';
import Material from '../../models/Material';
import { authMiddleware } from '../../middlewares/authMiddleware';

const router = Router();

// Get materials for student
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { subject, classLevel, chapter, type } = req.query;
    
    const query: any = { isPublished: true };
    
    // Filter by class level
    if (classLevel) {
      query.classLevel = classLevel;
    } else if (user.classLevel) {
      query.classLevel = user.classLevel;
    }
    
    if (subject) query.subject = subject;
    if (chapter) query.chapter = chapter;
    if (type) query.type = type;
    
    const materials = await Material.find(query)
      .populate('uploadedBy', 'name')
      .sort({ createdAt: -1 })
      .lean();
    
    res.json(materials);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get material details
router.get('/:materialId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const material = await Material.findById(req.params.materialId)
      .populate('uploadedBy', 'name')
      .lean();
    
    if (!material) {
      return res.status(404).json({ error: 'Material not found' });
    }
    
    res.json(material);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Track download
router.post('/:materialId/download', authMiddleware, async (req: Request, res: Response) => {
  try {
    const material = await Material.findByIdAndUpdate(
      req.params.materialId,
      { $inc: { downloadCount: 1 } },
      { new: true }
    );
    
    if (!material) {
      return res.status(404).json({ error: 'Material not found' });
    }
    
    res.json({ success: true, downloadUrl: material.fileUrl });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Create material
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const material = new Material({
      ...req.body,
      uploadedBy: user.id
    });
    
    await material.save();
    res.status(201).json(material);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Update material
router.put('/:materialId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const material = await Material.findByIdAndUpdate(
      req.params.materialId,
      req.body,
      { new: true }
    );
    
    if (!material) {
      return res.status(404).json({ error: 'Material not found' });
    }
    
    res.json(material);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Delete material
router.delete('/:materialId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    await Material.findByIdAndDelete(req.params.materialId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
