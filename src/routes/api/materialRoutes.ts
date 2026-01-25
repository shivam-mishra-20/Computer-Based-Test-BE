import { Router, Request, Response } from 'express';
import multer from 'multer';
import Material from '../../models/Material';
import User from '../../models/User';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { uploadToFirebase } from '../../services/firebaseService';
import { sendStudentNotifications } from '../../services/notificationService';

const router = Router();

// Configure multer for memory storage (we'll upload to Firebase)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max
  },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, images, and documents are allowed.'));
    }
  }
});

// Helper to get assigned student IDs
async function getAssignedStudentIds(material: any): Promise<string[]> {
  if (material.assignmentType === 'students') {
    return material.assignedStudents.map((id: any) => id.toString());
  }
  
  const query: any = { role: 'student' };
  
  if (material.assignmentType === 'class') {
    query.classLevel = { $in: material.assignedClasses };
  } else if (material.assignmentType === 'batch') {
    query.batch = { $in: material.assignedBatches };
  }
  
  const students = await User.find(query).select('_id').lean();
  return students.map(s => s._id.toString());
}

// Get materials (filtered by assignment for students)
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { subject, classLevel, chapter, type } = req.query;
    
    let query: any = {};
    
    if (user.role === 'student') {
      // Fetch student's full data from DB (JWT may not include classLevel/batch)
      const studentData = await User.findById(user.id).select('classLevel batch').lean();
      const userClassLevel = studentData?.classLevel || user.classLevel || '';
      const userBatch = studentData?.batch || user.batch || '';
      
      // Normalize classLevel format (handle both "11" and "Class 11")
      const classNum = userClassLevel.replace(/Class\s*/i, '').trim();
      const classLevelVariants = [classNum, `Class ${classNum}`, userClassLevel].filter(v => v && v !== 'Class ');
      
      // Debug logging
      console.log('[Materials] Student query:', {
        userId: user.id,
        userClassLevel,
        classLevelVariants,
        userBatch
      });
      
      // Students see published materials assigned to them
      query = {
        isPublished: true,
        $or: [
          { assignmentType: 'all' },
          { assignmentType: 'class', assignedClasses: { $in: classLevelVariants } },
          { assignmentType: 'batch', assignedBatches: userBatch },
          { assignmentType: 'students', assignedStudents: user.id },
          // Legacy: materials without assignmentType that match classLevel
          { assignmentType: { $exists: false }, classLevel: { $in: classLevelVariants } },
          { assignmentType: null, classLevel: { $in: classLevelVariants } }
        ]
      };
      
      console.log('[Materials] Query:', JSON.stringify(query, null, 2));
    } else if (user.role === 'teacher') {
      // Teachers see their own materials (published or not)
      query = { uploadedBy: user.id };
    } else if (user.role === 'admin') {
      // Admin sees all
      query = {};
    }
    
    // Add additional filters
    if (subject) query.subject = subject;
    if (classLevel && user.role !== 'student') query.classLevel = classLevel;
    if (chapter) query.chapter = chapter;
    if (type) query.type = type;
    
    const materials = await Material.find(query)
      .populate('uploadedBy', 'name')
      .sort({ createdAt: -1 })
      .lean();
    
    console.log('[Materials] Found:', materials.length, 'materials for', user.role);
    
    res.json(materials);
  } catch (error: any) {
    console.error('[Materials] Error:', error);
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

// Upload file and create material (teachers/admin)
router.post('/upload', authMiddleware, upload.single('file'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Parse body data
    const {
      title,
      description,
      subject,
      classLevel,
      chapter,
      assignmentType = 'class',
      assignedClasses,
      assignedBatches,
      assignedStudents,
      isPublished = 'true'
    } = req.body;
    
    if (!title || !subject || !classLevel) {
      return res.status(400).json({ error: 'Title, subject, and class are required' });
    }
    
    // Determine file type
    let fileType: string = 'other';
    if (file.mimetype === 'application/pdf') {
      fileType = 'pdf';
    } else if (file.mimetype.startsWith('image/')) {
      fileType = 'image';
    } else if (file.mimetype.includes('document') || file.mimetype.includes('word')) {
      fileType = 'document';
    }
    
    // Generate unique filename
    const timestamp = Date.now();
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const fileName = `materials/${classLevel}/${subject}/${timestamp}_${sanitizedName}`;
    
    // Upload to Firebase Storage
    const fileUrl = await uploadToFirebase(file.buffer, fileName, file.mimetype);
    
    // Parse assignment arrays
    const parsedAssignedClasses = assignedClasses 
      ? (typeof assignedClasses === 'string' ? JSON.parse(assignedClasses) : assignedClasses)
      : [classLevel];
    const parsedAssignedBatches = assignedBatches
      ? (typeof assignedBatches === 'string' ? JSON.parse(assignedBatches) : assignedBatches)
      : [];
    const parsedAssignedStudents = assignedStudents
      ? (typeof assignedStudents === 'string' ? JSON.parse(assignedStudents) : assignedStudents)
      : [];
    
    // Create material record
    const material = new Material({
      title,
      description,
      type: fileType,
      fileUrl,
      fileName: file.originalname,
      mimeType: file.mimetype,
      fileSize: file.size,
      subject,
      classLevel,
      chapter,
      uploadedBy: user.id,
      assignmentType,
      assignedClasses: parsedAssignedClasses,
      assignedBatches: parsedAssignedBatches,
      assignedStudents: parsedAssignedStudents,
      isPublished: isPublished === 'true' || isPublished === true,
      version: 1,
      versions: [{
        version: 1,
        fileUrl,
        fileSize: file.size,
        fileName: file.originalname,
        mimeType: file.mimetype,
        uploadedAt: new Date()
      }]
    });
    
    await material.save();
    
    // Send notifications if published
    if (material.isPublished) {
      const studentIds = await getAssignedStudentIds(material);
      if (studentIds.length > 0) {
        sendStudentNotifications(
          studentIds,
          'New Study Material',
          `${material.title} - ${material.subject}`,
          { type: 'material', materialId: material._id },
          'material'
        );
      }
    }
    
    res.status(201).json(material);
  } catch (error: any) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create material without file (for links)
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { assignedClasses, classLevel, assignmentType = 'class' } = req.body;
    
    const material = new Material({
      ...req.body,
      uploadedBy: user.id,
      assignmentType,
      assignedClasses: assignedClasses || [classLevel],
      version: 1
    });
    
    await material.save();
    res.status(201).json(material);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update material
router.put('/:materialId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const existingMaterial = await Material.findById(req.params.materialId);
    if (!existingMaterial) {
      return res.status(404).json({ error: 'Material not found' });
    }
    
    // Only owner or admin can update
    if (user.role !== 'admin' && existingMaterial.uploadedBy.toString() !== user.id) {
      return res.status(403).json({ error: 'Not authorized to update this material' });
    }
    
    const material = await Material.findByIdAndUpdate(
      req.params.materialId,
      req.body,
      { new: true }
    );
    
    res.json(material);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update material with new file (creates new version)
router.put('/:materialId/upload', authMiddleware, upload.single('file'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const material = await Material.findById(req.params.materialId);
    if (!material) {
      return res.status(404).json({ error: 'Material not found' });
    }
    
    if (user.role !== 'admin' && material.uploadedBy.toString() !== user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Upload new file
    const timestamp = Date.now();
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const fileName = `materials/${material.classLevel}/${material.subject}/${timestamp}_${sanitizedName}`;
    const fileUrl = await uploadToFirebase(file.buffer, fileName, file.mimetype);
    
    // Add to versions
    const newVersion = material.version + 1;
    material.versions.push({
      version: newVersion,
      fileUrl,
      fileSize: file.size,
      fileName: file.originalname,
      mimeType: file.mimetype,
      uploadedAt: new Date(),
      notes: req.body.notes
    });
    
    // Update current file
    material.fileUrl = fileUrl;
    material.fileName = file.originalname;
    material.mimeType = file.mimetype;
    material.fileSize = file.size;
    material.version = newVersion;
    
    await material.save();
    res.json(material);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete material
router.delete('/:materialId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const material = await Material.findById(req.params.materialId);
    if (!material) {
      return res.status(404).json({ error: 'Material not found' });
    }
    
    if (user.role !== 'admin' && material.uploadedBy.toString() !== user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    await Material.findByIdAndDelete(req.params.materialId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

