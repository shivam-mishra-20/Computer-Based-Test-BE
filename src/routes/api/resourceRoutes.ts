import { Router, Request, Response } from 'express';
import multer from 'multer';
import StudyResource from '../../models/StudyResource';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { uploadToFirebase } from '../../services/firebaseService';
import youtubeService from '../../services/youtubeService';

const router = Router();

// Configure multer for PDF uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max
  },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ['application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// ============ Public Routes ============

// Get all published resources (for guest users and students)
router.get('/', async (req: Request, res: Response) => {
  try {
    const { 
      type, 
      category, 
      subject, 
      classLevel, 
      batch, 
      isPublic, 
      isFeatured,
      search 
    } = req.query;

    const query: any = { status: 'published' };

    if (type) query.type = type;
    if (category) query.category = category;
    if (subject) query.subject = subject;
    if (classLevel) query.classLevel = classLevel;
    if (batch) query.batch = batch;
    if (isPublic !== undefined) query.isPublic = isPublic === 'true';
    if (isFeatured !== undefined) query.isFeatured = isFeatured === 'true';
    
    // Search in title and description
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { tags: { $in: [new RegExp(search as string, 'i')] } }
      ];
    }

    const resources = await StudyResource.find(query)
      .populate('uploadedBy', 'name email')
      .sort({ isFeatured: -1, createdAt: -1 })
      .lean();

    res.json(resources);
  } catch (error: any) {
    console.error('Error fetching resources:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get resource by ID (public)
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const resource = await StudyResource.findById(req.params.id)
      .populate('uploadedBy', 'name email');

    if (!resource) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    // Increment view/download count
    if (resource.type === 'video' && resource.viewCount !== undefined) {
      resource.viewCount += 1;
      await resource.save();
    } else if (resource.type === 'pdf' && resource.downloadCount !== undefined) {
      resource.downloadCount += 1;
      await resource.save();
    }

    res.json(resource);
  } catch (error: any) {
    console.error('Error fetching resource:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get unique categories
router.get('/meta/categories', async (req: Request, res: Response) => {
  try {
    const categories = await StudyResource.distinct('category', { status: 'published' });
    res.json(categories);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get unique subjects
router.get('/meta/subjects', async (req: Request, res: Response) => {
  try {
    const subjects = await StudyResource.distinct('subject', { status: 'published' });
    res.json(subjects);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Admin/Teacher Routes (Protected) ============

// Get YouTube metadata for autofill (admin/teacher only)
router.get('/youtube/metadata', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl) {
      return res.status(400).json({ error: 'YouTube URL or video ID is required' });
    }

    const videoId = youtubeService.extractYouTubeId(rawUrl);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL or video ID' });
    }

    const meta = await youtubeService.fetchYouTubeMeta(videoId);
    if (!meta) {
      return res.status(404).json({ error: 'Unable to fetch YouTube metadata for this video' });
    }

    return res.json({
      videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      title: meta.title,
      description: meta.description,
      thumbnailUrl: meta.thumbnail,
      durationSec: meta.durationSec,
      viewCount: meta.viewCount,
      tags: meta.tags,
      channelTitle: meta.channelTitle,
      publishedAt: meta.publishedAt,
      source: 'backend-youtube-service',
    });
  } catch (error: any) {
    console.error('Error fetching YouTube metadata:', error);
    return res.status(500).json({ error: error.message || 'Failed to fetch YouTube metadata' });
  }
});

// Create resource with YouTube URL (admin/teacher only)
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const resourceData = {
      ...req.body,
      uploadedBy: user.id
    };

    const resource = new StudyResource(resourceData);
    await resource.save();

    res.status(201).json(resource);
  } catch (error: any) {
    console.error('Error creating resource:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload PDF file (admin/teacher only)
router.post('/upload-pdf', authMiddleware, upload.single('file'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Parse form data
    const {
      title,
      description,
      category,
      subject,
      classLevel,
      batch,
      tags,
      pageCount,
      isPublic,
      isFeatured
    } = req.body;

    if (!title || !category || !subject || !classLevel) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Upload to Firebase Storage
    const timestamp = Date.now();
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const fileName = `study-resources/pdfs/${classLevel}/${subject}/${timestamp}_${sanitizedName}`;
    
    const fileUrl = await uploadToFirebase(file.buffer, fileName, file.mimetype);

    // Create resource record
    const resource = new StudyResource({
      title,
      description: description || '',
      type: 'pdf',
      resourceUrl: fileUrl,
      category,
      subject,
      classLevel,
      batch: batch || undefined,
      tags: tags ? JSON.parse(tags) : [],
      uploadedBy: user.id,
      fileSize: file.size,
      pageCount: pageCount ? parseInt(pageCount) : undefined,
      isPublic: isPublic === 'true' || isPublic === true,
      isFeatured: isFeatured === 'true' || isFeatured === true,
      status: 'published'
    });

    await resource.save();

    res.status(201).json(resource);
  } catch (error: any) {
    console.error('Error uploading PDF:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update resource (admin/teacher only)
router.put('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const resource = await StudyResource.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );

    if (!resource) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    res.json(resource);
  } catch (error: any) {
    console.error('Error updating resource:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete resource (admin/teacher only)
router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const resource = await StudyResource.findByIdAndDelete(req.params.id);

    if (!resource) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    res.json({ success: true, message: 'Resource deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting resource:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all resources including drafts (admin/teacher only)
router.get('/admin/all', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { type, status } = req.query;
    const query: any = {};

    if (type) query.type = type;
    if (status) query.status = status;

    const resources = await StudyResource.find(query)
      .populate('uploadedBy', 'name email role')
      .sort({ createdAt: -1 })
      .lean();

    res.json(resources);
  } catch (error: any) {
    console.error('Error fetching resources:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
