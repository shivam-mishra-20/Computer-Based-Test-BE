import { Router, Request, Response } from 'express';
import multer from 'multer';
import Material, { AssignmentType } from '../../models/Material';
import User from '../../models/User';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { uploadLimiter } from '../../middlewares/rateLimiter';
import { uploadToFirebase } from '../../services/firebaseService';
import { sendStudentNotifications } from '../../services/notificationService';

const router = Router();

const MATERIAL_ASSIGNMENT_TYPES: AssignmentType[] = [
  'all',
  'class',
  'batch',
  'class_batch',
  'students',
];

interface StudentMaterialContext {
  userId: string;
  classKey: string;
  classVariants: string[];
  batchKey: string;
}

interface TargetingPayload {
  assignmentType: AssignmentType;
  classLevel: string;
  assignedClasses: string[];
  assignedBatches: string[];
  assignedStudents: string[];
}

const safeString = (value: unknown): string => {
  return typeof value === 'string' ? value.trim() : '';
};

const toBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
};

const parseArrayField = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      if (parsed === undefined || parsed === null || parsed === '') return [];
      return [parsed];
    } catch {
      if (trimmed.includes(',')) {
        return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
      }
      return [trimmed];
    }
  }

  return [value];
};

const normalizeClassLabel = (value: unknown): string => {
  const raw = safeString(value);
  if (!raw) return '';

  const digitMatch = raw.match(/(\d{1,2})/);
  if (digitMatch) {
    return `Class ${Number(digitMatch[1])}`;
  }

  return raw;
};

const normalizeClassKey = (value: unknown): string => {
  const raw = safeString(value);
  if (!raw) return '';

  const digitMatch = raw.match(/(\d{1,2})/);
  if (digitMatch) {
    return String(Number(digitMatch[1]));
  }

  return raw.toLowerCase();
};

const normalizeBatchKey = (value: unknown): string => {
  return safeString(value).toLowerCase();
};

const uniqueCaseInsensitive = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
  }

  return result;
};

const normalizeClassList = (values: unknown[]): string[] => {
  return uniqueCaseInsensitive(
    values
      .map((value) => normalizeClassLabel(value))
      .filter(Boolean),
  );
};

const normalizeBatchList = (values: unknown[]): string[] => {
  return uniqueCaseInsensitive(
    values
      .map((value) => safeString(value))
      .filter(Boolean),
  );
};

const normalizeStudentIds = (values: unknown[]): string[] => {
  const unique = new Set<string>();
  values.forEach((value) => {
    const id = safeString(value);
    if (id) unique.add(id);
  });
  return Array.from(unique);
};

const normalizeAssignmentType = (value: unknown): AssignmentType => {
  const raw = safeString(value);
  return MATERIAL_ASSIGNMENT_TYPES.includes(raw as AssignmentType)
    ? (raw as AssignmentType)
    : 'class';
};

const buildStudentContext = (
  userId: string,
  classLevel: string,
  batch: string,
): StudentMaterialContext => {
  const normalizedClassLabel = normalizeClassLabel(classLevel);
  const classKey = normalizeClassKey(normalizedClassLabel);

  const variants = [
    normalizedClassLabel,
    classKey ? `Class ${classKey}` : '',
    classLevel,
  ]
    .map((value) => safeString(value))
    .filter(Boolean);

  return {
    userId,
    classKey,
    classVariants: uniqueCaseInsensitive(variants),
    batchKey: normalizeBatchKey(batch),
  };
};

const getStudentContextFromUser = async (user: any): Promise<StudentMaterialContext> => {
  const studentData = await User.findById(user.id).select('classLevel batch').lean();
  const userClassLevel = safeString(studentData?.classLevel || user.classLevel);
  const userBatch = safeString(studentData?.batch || user.batch);

  return buildStudentContext(String(user.id), userClassLevel, userBatch);
};

const matchesClass = (context: StudentMaterialContext, classValues: string[]): boolean => {
  if (!context.classKey || classValues.length === 0) return false;

  const classKeys = classValues.map((value) => normalizeClassKey(value)).filter(Boolean);
  return classKeys.includes(context.classKey);
};

const matchesBatch = (batchKey: string, batchValues: string[]): boolean => {
  if (!batchKey || batchValues.length === 0) return false;
  const normalized = batchValues.map((value) => normalizeBatchKey(value)).filter(Boolean);
  return normalized.includes(batchKey);
};

const isStudentExplicitlyAssigned = (material: any, userId: string): boolean => {
  const assignedIds = parseArrayField(material?.assignedStudents)
    .map((id) => String(id))
    .filter(Boolean);
  return assignedIds.includes(userId);
};

const canStudentAccessMaterial = (material: any, context: StudentMaterialContext): boolean => {
  if (!material?.isPublished) return false;

  const assignmentTypeRaw = safeString(material?.assignmentType);
  const assignmentType = MATERIAL_ASSIGNMENT_TYPES.includes(assignmentTypeRaw as AssignmentType)
    ? (assignmentTypeRaw as AssignmentType)
    : null;

  const assignedClasses = normalizeClassList(parseArrayField(material?.assignedClasses));
  const assignedBatches = normalizeBatchList(parseArrayField(material?.assignedBatches));
  const classScope = assignedClasses.length > 0
    ? assignedClasses
    : normalizeClassList([material?.classLevel]);

  const classMatches = matchesClass(context, classScope);
  const batchMatches = matchesBatch(context.batchKey, assignedBatches);

  if (!assignmentType) {
    // Legacy materials: class match is mandatory; batch is optional but enforced when provided.
    if (!classMatches) return false;
    if (assignedBatches.length > 0) return batchMatches;
    return true;
  }

  switch (assignmentType) {
    case 'all':
      // "All" is scoped to selected class(es), not global cross-class.
      return classMatches;
    case 'class':
      return classMatches;
    case 'batch':
      return classMatches && batchMatches;
    case 'class_batch':
      return classMatches && batchMatches;
    case 'students':
      return isStudentExplicitlyAssigned(material, context.userId);
    default:
      return false;
  }
};

const canUserAccessMaterial = async (material: any, user: any): Promise<boolean> => {
  if (!material) return false;

  if (user.role === 'admin') return true;

  if (user.role === 'teacher') {
    const uploader = material.uploadedBy;
    const uploaderId = uploader && typeof uploader === 'object' && 'toString' in uploader
      ? uploader.toString()
      : safeString(uploader);
    return uploaderId === String(user.id);
  }

  if (user.role === 'student') {
    const context = await getStudentContextFromUser(user);
    return canStudentAccessMaterial(material, context);
  }

  return false;
};

const buildTargetingPayload = (
  input: {
    assignmentType?: unknown;
    classLevel?: unknown;
    assignedClasses?: unknown;
    assignedBatches?: unknown;
    assignedStudents?: unknown;
  },
  fallbackClassLevel?: string,
): TargetingPayload => {
  const classLevel = normalizeClassLabel(input.classLevel || fallbackClassLevel);
  const assignmentType = normalizeAssignmentType(input.assignmentType);

  const assignedClasses = normalizeClassList(parseArrayField(input.assignedClasses));
  const assignedBatches = normalizeBatchList(parseArrayField(input.assignedBatches));
  const assignedStudents = normalizeStudentIds(parseArrayField(input.assignedStudents));

  const classScope = assignedClasses.length > 0
    ? assignedClasses
    : classLevel
      ? [classLevel]
      : [];

  if (assignmentType === 'all') {
    return {
      assignmentType,
      classLevel,
      assignedClasses: classScope,
      assignedBatches: [],
      assignedStudents: [],
    };
  }

  if (assignmentType === 'class') {
    return {
      assignmentType,
      classLevel,
      assignedClasses: classScope,
      assignedBatches: [],
      assignedStudents: [],
    };
  }

  if (assignmentType === 'batch') {
    return {
      assignmentType,
      classLevel,
      assignedClasses: classScope,
      assignedBatches,
      assignedStudents: [],
    };
  }

  if (assignmentType === 'class_batch') {
    return {
      assignmentType,
      classLevel,
      assignedClasses: classScope,
      assignedBatches,
      assignedStudents: [],
    };
  }

  return {
    assignmentType,
    classLevel,
    assignedClasses: classScope,
    assignedBatches: [],
    assignedStudents,
  };
};

const validateTargetingPayload = (payload: TargetingPayload): string | null => {
  if (!payload.classLevel) {
    return 'Class is required';
  }

  if (
    (payload.assignmentType === 'all'
      || payload.assignmentType === 'class'
      || payload.assignmentType === 'batch'
      || payload.assignmentType === 'class_batch'
      || payload.assignmentType === 'students')
    && payload.assignedClasses.length === 0
  ) {
    return 'Select at least one class';
  }

  if (
    (payload.assignmentType === 'batch' || payload.assignmentType === 'class_batch')
    && payload.assignedBatches.length === 0
  ) {
    return 'Select at least one batch';
  }

  if (payload.assignmentType === 'students' && payload.assignedStudents.length === 0) {
    return 'Select at least one student';
  }

  return null;
};

const buildSearchRegex = (value?: string): RegExp | null => {
  const query = safeString(value);
  if (!query) return null;

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
};

// Helper to get assigned student IDs
async function getAssignedStudentIds(material: any): Promise<string[]> {
  const students = await User.find({ role: 'student', status: 'approved' })
    .select('_id classLevel batch')
    .lean();

  return students
    .filter((student: any) => {
      const context = buildStudentContext(
        String(student._id),
        safeString(student.classLevel),
        safeString(student.batch),
      );
      return canStudentAccessMaterial(material, context);
    })
    .map((student: any) => String(student._id));
}

const notifyMaterialPublished = async (material: any): Promise<void> => {
  try {
    const studentIds = await getAssignedStudentIds(material);
    if (studentIds.length === 0) return;

    await sendStudentNotifications(
      studentIds,
      'New Study Material',
      `${material.title} - ${material.subject}`,
      { type: 'material', materialId: material._id },
      'material',
    );
  } catch (notificationError) {
    console.error('Material notification error:', notificationError);
  }
};

// Configure multer for memory storage (we'll upload to Firebase)
const upload = multer({
  storage: multer.memoryStorage(),
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

// Get materials (filtered by assignment for students)
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const {
      subject,
      classLevel,
      chapter,
      type,
      q,
    } = req.query as Record<string, string | undefined>;
    
    let query: any = {};
    
    if (user.role === 'student') {
      const studentContext = await getStudentContextFromUser(user);

      query = {
        isPublished: true,
      };

      if (subject) query.subject = subject;
      if (chapter) query.chapter = chapter;
      if (type) query.type = type;

      const searchRegex = buildSearchRegex(q);
      if (searchRegex) {
        query.$or = [
          { title: searchRegex },
          { description: searchRegex },
          { chapter: searchRegex },
          { subject: searchRegex },
        ];
      }

      const studentMaterials = await Material.find(query)
        .populate('uploadedBy', 'name')
        .sort({ createdAt: -1 })
        .lean();

      let visibleMaterials = studentMaterials.filter((material: any) => {
        return canStudentAccessMaterial(material, studentContext);
      });

      if (classLevel) {
        const filterClassKey = normalizeClassKey(classLevel);
        visibleMaterials = visibleMaterials.filter((material: any) => {
          const classTargets = normalizeClassList([
            ...parseArrayField(material?.assignedClasses),
            material?.classLevel,
          ]);
          return classTargets.some((classValue) => normalizeClassKey(classValue) === filterClassKey);
        });
      }

      return res.json(visibleMaterials);
    } else if (user.role === 'teacher') {
      // Teachers see their own materials (published or not)
      query = { uploadedBy: user.id };
    } else if (user.role === 'admin') {
      // Admin sees all
      query = {};
    }
    
    const searchRegex = buildSearchRegex(q);

    // Add additional filters
    if (subject) query.subject = subject;
    if (classLevel) {
      const normalized = normalizeClassLabel(classLevel);
      const variants = uniqueCaseInsensitive([normalized, safeString(classLevel)]);
      query.classLevel = { $in: variants };
    }
    if (chapter) query.chapter = chapter;
    if (type) query.type = type;
    if (searchRegex) {
      query.$or = [
        { title: searchRegex },
        { description: searchRegex },
        { chapter: searchRegex },
        { subject: searchRegex },
      ];
    }
    
    const materials = await Material.find(query)
      .populate('uploadedBy', 'name')
      .sort({ createdAt: -1 })
      .lean();

    res.json(materials);
  } catch (error: any) {
    console.error('[Materials] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get material details
router.get('/:materialId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const materialDoc = await Material.findById(req.params.materialId);
    
    if (!materialDoc) {
      return res.status(404).json({ error: 'Material not found' });
    }

    const hasAccess = await canUserAccessMaterial(materialDoc, user);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Not authorized to access this material' });
    }

    const material = await Material.findById(req.params.materialId)
      .populate('uploadedBy', 'name')
      .lean();
    
    res.json(material);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Track download
router.post('/:materialId/download', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const material = await Material.findById(req.params.materialId);
    
    if (!material) {
      return res.status(404).json({ error: 'Material not found' });
    }

    const hasAccess = await canUserAccessMaterial(material, user);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Not authorized to download this material' });
    }

    await Material.findByIdAndUpdate(
      req.params.materialId,
      { $inc: { downloadCount: 1 } },
      { new: true },
    );
    
    res.json({ success: true, downloadUrl: material.fileUrl });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Upload file and create material (teachers/admin)
router.post('/upload', authMiddleware, uploadLimiter, upload.single('file'), async (req: Request, res: Response) => {
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
      chapter,
      isPublished = 'true'
    } = req.body;
    
    const targeting = buildTargetingPayload({
      assignmentType: req.body.assignmentType,
      classLevel: req.body.classLevel,
      assignedClasses: req.body.assignedClasses,
      assignedBatches: req.body.assignedBatches,
      assignedStudents: req.body.assignedStudents,
    });

    const targetingError = validateTargetingPayload(targeting);

    if (!safeString(title) || !safeString(subject)) {
      return res.status(400).json({ error: 'Title and subject are required' });
    }

    if (targetingError) {
      return res.status(400).json({ error: targetingError });
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
    const classFolder = targeting.classLevel.replace(/\s+/g, '_');
    const subjectFolder = safeString(subject).replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `materials/${classFolder}/${subjectFolder}/${timestamp}_${sanitizedName}`;
    
    // Upload to Firebase Storage
    const fileUrl = await uploadToFirebase(file.buffer, fileName, file.mimetype);
    
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
      classLevel: targeting.classLevel,
      chapter,
      uploadedBy: user.id,
      assignmentType: targeting.assignmentType,
      assignedClasses: targeting.assignedClasses,
      assignedBatches: targeting.assignedBatches,
      assignedStudents: targeting.assignedStudents,
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
      await notifyMaterialPublished(material);
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
    
    const { title, subject, fileUrl } = req.body;

    if (!safeString(title) || !safeString(subject) || !safeString(fileUrl)) {
      return res.status(400).json({ error: 'Title, subject, and fileUrl are required' });
    }

    const targeting = buildTargetingPayload(
      {
        assignmentType: req.body.assignmentType,
        classLevel: req.body.classLevel,
        assignedClasses: req.body.assignedClasses,
        assignedBatches: req.body.assignedBatches,
        assignedStudents: req.body.assignedStudents,
      },
      safeString(req.body.classLevel),
    );

    const targetingError = validateTargetingPayload(targeting);
    if (targetingError) {
      return res.status(400).json({ error: targetingError });
    }
    
    const material = new Material({
      ...req.body,
      uploadedBy: user.id,
      classLevel: targeting.classLevel,
      assignmentType: targeting.assignmentType,
      assignedClasses: targeting.assignedClasses,
      assignedBatches: targeting.assignedBatches,
      assignedStudents: targeting.assignedStudents,
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
    
    const wasPublished = Boolean(existingMaterial.isPublished);

    if (req.body.title !== undefined) {
      existingMaterial.title = safeString(req.body.title);
    }
    if (req.body.description !== undefined) {
      existingMaterial.description = safeString(req.body.description);
    }
    if (req.body.subject !== undefined) {
      existingMaterial.subject = safeString(req.body.subject);
    }
    if (req.body.chapter !== undefined) {
      existingMaterial.chapter = safeString(req.body.chapter);
    }
    if (req.body.type !== undefined) {
      existingMaterial.type = req.body.type;
    }
    if (req.body.isPublished !== undefined) {
      existingMaterial.isPublished = toBoolean(req.body.isPublished, existingMaterial.isPublished);
    }

    const hasTargetingUpdate = ['assignmentType', 'assignedClasses', 'assignedBatches', 'assignedStudents', 'classLevel']
      .some((key) => req.body[key] !== undefined);

    if (hasTargetingUpdate) {
      const targeting = buildTargetingPayload(
        {
          assignmentType: req.body.assignmentType,
          classLevel: req.body.classLevel,
          assignedClasses: req.body.assignedClasses,
          assignedBatches: req.body.assignedBatches,
          assignedStudents: req.body.assignedStudents,
        },
        existingMaterial.classLevel,
      );

      const targetingError = validateTargetingPayload(targeting);
      if (targetingError) {
        return res.status(400).json({ error: targetingError });
      }

      existingMaterial.classLevel = targeting.classLevel;
      existingMaterial.assignmentType = targeting.assignmentType;
      existingMaterial.assignedClasses = targeting.assignedClasses;
      existingMaterial.assignedBatches = targeting.assignedBatches;
      existingMaterial.assignedStudents = targeting.assignedStudents as any;
    }

    if (!safeString(existingMaterial.title) || !safeString(existingMaterial.subject)) {
      return res.status(400).json({ error: 'Title and subject are required' });
    }

    await existingMaterial.save();

    if (!wasPublished && existingMaterial.isPublished) {
      await notifyMaterialPublished(existingMaterial);
    }
    
    res.json(existingMaterial);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update material with new file (creates new version)
router.put('/:materialId/upload', authMiddleware, uploadLimiter, upload.single('file'), async (req: Request, res: Response) => {
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

    const wasPublished = Boolean(material.isPublished);
    
    // Upload new file
    const timestamp = Date.now();
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const classFolder = normalizeClassLabel(req.body.classLevel || material.classLevel || 'General').replace(/\s+/g, '_');
    const subjectFolder = safeString(req.body.subject || material.subject || 'General').replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `materials/${classFolder}/${subjectFolder}/${timestamp}_${sanitizedName}`;
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
      notes: safeString(req.body.notes)
    });
    
    // Update current file
    material.fileUrl = fileUrl;
    material.fileName = file.originalname;
    material.mimeType = file.mimetype;
    material.fileSize = file.size;
    material.version = newVersion;

    if (req.body.title !== undefined) {
      material.title = safeString(req.body.title);
    }
    if (req.body.description !== undefined) {
      material.description = safeString(req.body.description);
    }
    if (req.body.subject !== undefined) {
      material.subject = safeString(req.body.subject);
    }
    if (req.body.chapter !== undefined) {
      material.chapter = safeString(req.body.chapter);
    }
    if (req.body.isPublished !== undefined) {
      material.isPublished = toBoolean(req.body.isPublished, material.isPublished);
    }

    const hasTargetingUpdate = ['assignmentType', 'assignedClasses', 'assignedBatches', 'assignedStudents', 'classLevel']
      .some((key) => req.body[key] !== undefined);

    if (hasTargetingUpdate) {
      const targeting = buildTargetingPayload(
        {
          assignmentType: req.body.assignmentType,
          classLevel: req.body.classLevel,
          assignedClasses: req.body.assignedClasses,
          assignedBatches: req.body.assignedBatches,
          assignedStudents: req.body.assignedStudents,
        },
        material.classLevel,
      );

      const targetingError = validateTargetingPayload(targeting);
      if (targetingError) {
        return res.status(400).json({ error: targetingError });
      }

      material.classLevel = targeting.classLevel;
      material.assignmentType = targeting.assignmentType;
      material.assignedClasses = targeting.assignedClasses;
      material.assignedBatches = targeting.assignedBatches;
      material.assignedStudents = targeting.assignedStudents as any;
    }

    if (!safeString(material.title) || !safeString(material.subject)) {
      return res.status(400).json({ error: 'Title and subject are required' });
    }
    
    await material.save();

    if (!wasPublished && material.isPublished) {
      await notifyMaterialPublished(material);
    }

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

