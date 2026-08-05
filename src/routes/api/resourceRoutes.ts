import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import StudyResource from '../../models/StudyResource';
import { authMiddleware, optionalAuthMiddleware } from '../../middlewares/authMiddleware';
import { uploadLimiter } from '../../middlewares/rateLimiter';
import { uploadToFirebase } from '../../services/firebaseService';
import { pdfFileFilter, resolveContentType } from '../../utils/uploadFileTypes';
import { withContentCategory } from '../../utils/resourceCategory';
import youtubeService from '../../services/youtubeService';

const router = Router();

// Configure multer for PDF uploads. Accept by mimetype OR .pdf extension so a PDF
// picked from a cloud provider (sent as application/octet-stream) isn't rejected.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max
  },
  fileFilter: pdfFileFilter,
});

// ============ Public Routes ============

/**
 * True when the caller is signed in as staff. Guests AND signed-in students
 * both get the public view; only staff may see non-public/unpublished items.
 */
const isStaff = (req: Request): boolean => {
  const role = (req as any).user?.role;
  return role === 'admin' || role === 'teacher' || role === 'developer';
};

/**
 * Visibility floor enforced SERVER-SIDE for every non-staff caller.
 *
 * Previously `isPublic` was applied only when the client happened to send
 * `?isPublic=true`, so simply omitting the parameter returned private
 * resources to anonymous callers. Client query params can no longer influence
 * this — they are only allowed to narrow within the permitted set.
 */
const applyVisibilityFloor = (query: any, req: Request) => {
  if (isStaff(req)) return query;
  query.status = 'published';
  query.isPublic = true;
  return query;
};

/** Guests must never receive uploader identity (staff names/emails). */
const publicProjection =
  '-uploadedBy -__v';

// Get all published resources (for guest users and students)
router.get('/', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const {
      type,
      category,
      contentCategory,
      subject,
      classLevel,
      batch,
      isPublic,
      isFeatured,
      search
    } = req.query;

    const staff = isStaff(req);
    const query: any = { status: 'published' };

    if (type) query.type = type;
    if (category) query.category = category;
    // NB: contentCategory is intentionally NOT part of the DB query — it is
    // applied after derivation below, so untagged legacy content still lands
    // in the right public section.
    if (subject) query.subject = subject;
    if (classLevel) query.classLevel = classLevel;
    if (batch) query.batch = batch;
    // Only staff may widen/narrow these — for everyone else the floor below wins.
    if (staff && isPublic !== undefined) query.isPublic = isPublic === 'true';
    if (isFeatured !== undefined) query.isFeatured = isFeatured === 'true';

    // Search in title and description
    if (search) {
      const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { title: { $regex: escaped, $options: 'i' } },
        { description: { $regex: escaped, $options: 'i' } },
        { tags: { $in: [new RegExp(escaped, 'i')] } }
      ];
    }

    applyVisibilityFloor(query, req);

    const findQuery = StudyResource.find(query);
    if (staff) {
      findQuery.populate('uploadedBy', 'name email');
    } else {
      findQuery.select(publicProjection);
    }

    const resources = await findQuery
      .sort({ isFeatured: -1, createdAt: -1 })
      .lean();

    // Fill in the public section for untagged content, then narrow if the
    // caller asked for one specific section.
    const withSections = resources.map((r) => withContentCategory(r));
    const result = contentCategory
      ? withSections.filter((r) => r.contentCategory === contentCategory)
      : withSections;

    res.json(result);
  } catch (error: any) {
    console.error('Error fetching resources:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get resource by ID (public for published+public items; staff see anything)
router.get('/:id', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const staff = isStaff(req);

    // Public endpoint: a malformed id is a 404, not a Mongoose CastError 500.
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    // The visibility floor is part of the LOOKUP, not a post-filter, so a
    // private resource is a 404 for guests rather than a readable document.
    const criteria: any = { _id: req.params.id };
    applyVisibilityFloor(criteria, req);

    const query = StudyResource.findOne(criteria);
    if (staff) {
      query.populate('uploadedBy', 'name email');
    } else {
      query.select(publicProjection);
    }

    const resource = await query.lean();

    if (!resource) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    // Increment view/download counters WITHOUT a full document save — the old
    // code round-tripped the whole doc on an unauthenticated GET. $inc is
    // atomic, fire-and-forget, and cannot rewrite other fields.
    const counterField = resource.type === 'video' ? 'viewCount' : 'downloadCount';
    StudyResource.updateOne({ _id: resource._id }, { $inc: { [counterField]: 1 } }).catch(
      (err) => console.error('Error incrementing resource counter:', err),
    );

    res.json(withContentCategory(resource));
  } catch (error: any) {
    console.error('Error fetching resource:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get unique categories (guests only see categories of public content)
router.get('/meta/categories', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const categories = await StudyResource.distinct(
      'category',
      applyVisibilityFloor({ status: 'published' }, req),
    );
    res.json(categories);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get unique subjects (guests only see subjects of public content)
router.get('/meta/subjects', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const subjects = await StudyResource.distinct(
      'subject',
      applyVisibilityFloor({ status: 'published' }, req),
    );
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
router.post('/upload-pdf', authMiddleware, uploadLimiter, upload.single('file'), async (req: Request, res: Response) => {
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
      contentCategory,
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

    const contentType = resolveContentType(file.mimetype, file.originalname);
    const fileUrl = await uploadToFirebase(file.buffer, fileName, contentType);

    // Create resource record
    const resource = new StudyResource({
      title,
      description: description || '',
      type: 'pdf',
      resourceUrl: fileUrl,
      category,
      contentCategory: contentCategory || undefined,
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
