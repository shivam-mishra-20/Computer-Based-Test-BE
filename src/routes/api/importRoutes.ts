import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { Types } from 'mongoose';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { QuestionImportService } from '../../services/questionImportService';
import { ImportBatch, ImportedQuestion } from '../../models/ImportedQuestion';
import { successResponse, errorResponse } from '../../utils/response';
import { ImportModel } from '../../models/Import';
import Blueprint from '../../models/Blueprint';
import Paper from '../../models/Paper';
import { upload as memUpload } from '../../middlewares/upload';

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req: Request, file: Express.Multer.File, cb: (error: Error | null, destination: string) => void) => {
    // Use process.cwd() instead of __dirname for correct path resolution in bundled code
    const uploadDir = path.join(process.cwd(), 'uploads', 'imports');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req: Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `import-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const allowedTypes = [
      'application/pdf',
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/gif',
      'image/bmp'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF and image files are allowed.'));
    }
  }
});

/**
 * POST /api/import-paper
 * Upload and process question paper
 */
router.post('/import-paper', authMiddleware, upload.single('questionPaper'), async (req, res) => {
  try {
  const { subject, topic, ocrProvider = 'tesseract', mode, model = 'gemini-2.5-flash', class: className, board, chapter, section, marks } = req.body;
    const userId = (req as any).user.id;
    
    if (!req.file) {
      return errorResponse(res, 'No file uploaded', 400);
    }

    // Validate file type
    const fileType = req.file.mimetype.startsWith('image/') ? 'image' : 'pdf';
    
    // Start processing asynchronously with Vision API + Gemini pipeline
    const importPromise = QuestionImportService.importQuestionPaper(
      req.file.path,
      req.file.originalname,
      fileType,
      new Types.ObjectId(userId),
      {
        subject,
        topic,
        class: className,
        board,
        chapter,
        section,
        marks: marks ? parseInt(marks) : undefined,
        model
      }
    );

    // Return immediate response with batch ID for tracking
    importPromise.then(result => {
      console.log(`Import completed for batch ${result.batchId}: ${result.processedQuestions} questions processed`);
    }).catch(error => {
      console.error('Import failed:', error);
    });

    // For now, await the result (in production, you might want to make this async)
    const result = await importPromise;

    return successResponse(res, {
      message: 'Question paper processed successfully',
      batchId: result.batchId,
      totalQuestions: result.totalQuestions,
      processedQuestions: result.processedQuestions,
      processingTime: result.processingTime
    });

  } catch (error) {
    console.error('Import paper error:', error);
    
    // Clean up uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    return errorResponse(res, 
      error instanceof Error ? error.message : 'Failed to process question paper', 
      500
    );
  }
});

/**
 * GET /api/import-paper/batches
 * Get all import batches for the current user
 */
router.get('/import-paper/batches', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { page = 1, limit = 10, status } = req.query;
    
    const query: any = { uploadedBy: userId };
    if (status) {
      query.status = status;
    }

    const batches = await ImportBatch.find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit))
      .populate('uploadedBy', 'name email');

    const total = await ImportBatch.countDocuments(query);

    return successResponse(res, {
      batches,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });

  } catch (error) {
    console.error('Get batches error:', error);
    return errorResponse(res, 'Failed to fetch import batches', 500);
  }
});

/**
 * GET /api/import-paper/batch/:batchId
 * Get specific import batch with questions
 */
router.get('/import-paper/batch/:batchId', authMiddleware, async (req, res) => {
  try {
    const { batchId } = req.params;
    const userId = (req as any).user.id;
    
    if (!Types.ObjectId.isValid(batchId)) {
      return errorResponse(res, 'Invalid batch ID', 400);
    }

    const batch = await ImportBatch.findOne({ 
      _id: batchId, 
      uploadedBy: userId 
    }).populate('uploadedBy', 'name email');

    if (!batch) {
      return errorResponse(res, 'Import batch not found', 404);
    }

    const questions = await ImportedQuestion.find({ importBatch: batchId })
      .sort({ questionNumber: 1 });

    return successResponse(res, {
      batch,
      questions
    });

  } catch (error) {
    console.error('Get batch error:', error);
    return errorResponse(res, 'Failed to fetch import batch', 500);
  }
});

/**
 * GET /api/import-paper/questions
 * Get questions from a specific batch with filtering
 */
router.get('/import-paper/questions', authMiddleware, async (req, res) => {
  try {
    const { 
      batchId, 
      status, 
      needsReview, 
      type,
      page = 1, 
      limit = 20 
    } = req.query;
    
    const query: any = {};
    
    if (batchId) {
      if (!Types.ObjectId.isValid(batchId as string)) {
        return errorResponse(res, 'Invalid batch ID', 400);
      }
      query.importBatch = batchId;
    }
    
    if (status) {
      query.status = status;
    }
    
    if (needsReview !== undefined) {
      query.needsReview = needsReview === 'true';
    }
    
    if (type) {
      query.type = type;
    }

    const questions = await ImportedQuestion.find(query)
      .populate('importBatch', 'fileName originalFileName')
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit));

    const total = await ImportedQuestion.countDocuments(query);

    return successResponse(res, {
      questions,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });

  } catch (error) {
    console.error('Get questions error:', error);
    return errorResponse(res, 'Failed to fetch questions', 500);
  }
});

/**
 * PUT /api/import-paper/question/:questionId
 * Update/review a specific question
 */
router.put('/import-paper/question/:questionId', authMiddleware, async (req, res) => {
  try {
    const { questionId } = req.params;
    const userId = (req as any).user.id;
    const { action, ...updateData } = req.body;
    
    if (!Types.ObjectId.isValid(questionId)) {
      return errorResponse(res, 'Invalid question ID', 400);
    }

    if (action && !['approve', 'reject'].includes(action)) {
      return errorResponse(res, 'Invalid action. Must be "approve" or "reject"', 400);
    }

    let updatedQuestion;
    
    if (action) {
      updatedQuestion = await QuestionImportService.reviewQuestion(
        new Types.ObjectId(questionId),
        new Types.ObjectId(userId),
        action,
        updateData
      );
    } else {
      // Just update the question data
      updatedQuestion = await ImportedQuestion.findByIdAndUpdate(
        questionId,
        updateData,
        { new: true }
      );
      
      if (!updatedQuestion) {
        return errorResponse(res, 'Question not found', 404);
      }
    }

    return successResponse(res, {
      message: `Question ${action ? action + 'd' : 'updated'} successfully`,
      question: updatedQuestion
    });

  } catch (error) {
    console.error('Update question error:', error);
    return errorResponse(res, 
      error instanceof Error ? error.message : 'Failed to update question', 
      500
    );
  }
});

/**
 * POST /api/import-paper/questions/bulk-approve
 * Bulk approve multiple questions
 */
router.post('/import-paper/questions/bulk-approve', authMiddleware, async (req, res) => {
  try {
    const { questionIds } = req.body;
    const userId = (req as any).user.id;
    
    if (!Array.isArray(questionIds) || questionIds.length === 0) {
      return errorResponse(res, 'Invalid question IDs array', 400);
    }

    const objectIds = questionIds.map(id => {
      if (!Types.ObjectId.isValid(id)) {
        throw new Error(`Invalid question ID: ${id}`);
      }
      return new Types.ObjectId(id);
    });

    const result = await QuestionImportService.bulkApproveQuestions(
      objectIds,
      new Types.ObjectId(userId)
    );

    return successResponse(res, {
      message: `Bulk approval completed`,
      approved: result.approved,
      failed: result.failed
    });

  } catch (error) {
    console.error('Bulk approve error:', error);
    return errorResponse(res, 
      error instanceof Error ? error.message : 'Failed to bulk approve questions', 
      500
    );
  }
});

/**
 * DELETE /api/import-paper/batch/:batchId
 * Delete an import batch and all its questions
 */
router.delete('/import-paper/batch/:batchId', authMiddleware, async (req, res) => {
  try {
    const { batchId } = req.params;
    const userId = (req as any).user.id;
    
    if (!Types.ObjectId.isValid(batchId)) {
      return errorResponse(res, 'Invalid batch ID', 400);
    }

    // Verify ownership
    const batch = await ImportBatch.findOne({ 
      _id: batchId, 
      uploadedBy: userId 
    });

    if (!batch) {
      return errorResponse(res, 'Import batch not found', 404);
    }

    // Delete all questions in the batch
    await ImportedQuestion.deleteMany({ importBatch: batchId });
    
    // Delete the batch
    await ImportBatch.findByIdAndDelete(batchId);

    return successResponse(res, {
      message: 'Import batch deleted successfully'
    });

  } catch (error) {
    console.error('Delete batch error:', error);
    return errorResponse(res, 'Failed to delete import batch', 500);
  }
});

/**
 * GET /api/import-paper/stats
 * Get import statistics for the current user
 */
router.get('/import-paper/stats', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    
    const stats = await ImportBatch.aggregate([
      { $match: { uploadedBy: new Types.ObjectId(userId) } },
      {
        $group: {
          _id: null,
          totalBatches: { $sum: 1 },
          totalQuestions: { $sum: '$totalQuestions' },
          totalApproved: { $sum: '$approvedQuestions' },
          totalRejected: { $sum: '$rejectedQuestions' },
          avgProcessingTime: { $avg: '$totalProcessingTime' }
        }
      }
    ]);

    const statusCounts = await ImportBatch.aggregate([
      { $match: { uploadedBy: new Types.ObjectId(userId) } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    return successResponse(res, {
      stats: stats[0] || {
        totalBatches: 0,
        totalQuestions: 0,
        totalApproved: 0,
        totalRejected: 0,
        avgProcessingTime: 0
      },
      statusCounts: statusCounts.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {} as any)
    });

  } catch (error) {
    console.error('Get stats error:', error);
    return errorResponse(res, 'Failed to fetch statistics', 500);
  }
});

export default router;

/**
 * Imports aggregation routes (subject/topic-wise)
 */
router.get('/imports/subjects', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const subjects = await ImportModel.aggregate([
      { $match: { uploadedBy: new Types.ObjectId(userId) } },
      { $group: { _id: '$subject', count: { $sum: '$questionCount' } } },
      { $project: { _id: 0, subject: '$_id', count: 1 } },
      { $sort: { subject: 1 } }
    ]);
    return successResponse(res, { subjects });
  } catch (e) {
    return errorResponse(res, 'Failed to list subjects', 500);
  }
});

router.get('/imports/topics', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { subject } = req.query;
    const match: any = { uploadedBy: new Types.ObjectId(userId) };
    if (subject) match.subject = subject;
    const topics = await ImportModel.aggregate([
      { $match: match },
      { $group: { _id: { subject: '$subject', topic: '$topic' }, count: { $sum: '$questionCount' } } },
      { $project: { _id: 0, subject: '$_id.subject', topic: '$_id.topic', count: 1 } },
      { $sort: { subject: 1, topic: 1 } }
    ]);
    return successResponse(res, { topics });
  } catch (e) {
    return errorResponse(res, 'Failed to list topics', 500);
  }
});

router.get('/imports/questions', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { subject, topic, page = 1, limit = 20 } = req.query;
    const query: any = { extractedBy: userId };
    if (subject) query.subject = subject;
    if (topic) query.topic = topic;
    const items = await ImportedQuestion.find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit));
    const total = await ImportedQuestion.countDocuments(query);
    return successResponse(res, { items, total, page: Number(page), limit: Number(limit) });
  } catch (e) {
    return errorResponse(res, 'Failed to fetch imported questions', 500);
  }
});

/**
 * POST /api/import-paper/question/:questionId/diagram
 * Attach a diagram image to a specific imported question
 */
router.post('/import-paper/question/:questionId/diagram', authMiddleware, memUpload.single('image'), async (req, res) => {
  try {
    const { questionId } = req.params;
    if (!Types.ObjectId.isValid(questionId)) return errorResponse(res, 'Invalid question ID', 400);
    if (!(req as any).file) return errorResponse(res, 'Image is required', 400);

    // Upload to Firebase Storage
    const { uploadToFirebase } = await import('../../services/firebaseService');
    const file = (req as any).file;
    const safeBase = ((file.originalname as string) || 'image').replace(/[^a-zA-Z0-9-_\.]/g, '_');
    const fileName = `diagrams/${Date.now()}_${safeBase}`;
    
    console.log(`Uploading diagram to Firebase: ${fileName}`);
    const publicUrl = await uploadToFirebase(
      file.buffer,
      fileName,
      file.mimetype || 'image/jpeg'
    );
    console.log(`Diagram uploaded successfully: ${publicUrl}`);

    const updated = await ImportedQuestion.findByIdAndUpdate(questionId, { diagramUrl: publicUrl }, { new: true });
    if (!updated) return errorResponse(res, 'Question not found', 404);
    return successResponse(res, { message: 'Diagram attached', question: updated });
  } catch (e) {
    console.error('Failed to attach diagram:', e);
    return errorResponse(res, 'Failed to attach diagram', 500);
  }
});

/**
 * GET /api/blueprints
 * List available blueprints for current user (and shared)
 */
router.get('/blueprints', authMiddleware, async (req, res) => {
  try {
    const userId = new Types.ObjectId((req as any).user.id);
    const items = await Blueprint.find({ $or: [{ owner: userId }, { shared: true }] }).sort({ createdAt: -1 });
    return successResponse(res, { items });
  } catch (e) {
    return errorResponse(res, 'Failed to list blueprints', 500);
  }
});

/**
 * POST /api/import-paper/create-paper
 * Build a Paper document from a blueprint and selected imported question IDs, preserving order.
 * Body: { blueprintId: string, questionIds: string[] }
 */
router.post('/import-paper/create-paper', authMiddleware, async (req, res) => {
  try {
    const userId = new Types.ObjectId((req as any).user.id);
    const { blueprintId, questionIds, examTitle } = req.body as { blueprintId: string; questionIds: string[]; examTitle?: string };
    if (!Types.ObjectId.isValid(blueprintId)) return errorResponse(res, 'Invalid blueprintId', 400);
    if (!Array.isArray(questionIds) || questionIds.length === 0) return errorResponse(res, 'questionIds required', 400);
    const bp = await Blueprint.findById(blueprintId);
    if (!bp) return errorResponse(res, 'Blueprint not found', 404);

    // Load questions, preserving the order provided by questionIds
    const ids = questionIds.map(id => new Types.ObjectId(id));
    const docs = await ImportedQuestion.find({ _id: { $in: ids } });
    const byId = new Map(docs.map(d => [String(d._id), d] as const));
    const ordered = questionIds.map(id => byId.get(id)).filter(Boolean) as any[];

    // Build sections by consuming ordered questions according to blueprint questionCounts/type
    const sections: any[] = [];
    let cursor = 0;
    for (const sec of bp.sections) {
      const secQuestions: any[] = [];
      const counts = sec.questionCounts || {};
      const typesOrder = Object.keys(counts);
      for (const t of typesOrder) {
        const need = counts[t] || 0;
        for (let i = 0; i < need && cursor < ordered.length; i++) {
          const q = ordered[cursor++];
          // ensure type match if possible; else still include to avoid dropping
          if (q) {
            secQuestions.push({
              text: q.text, // already LaTeX-wrapped inline/display content is preserved
              type: q.type,
              options: q.options,
              correctAnswerText: q.correctAnswerText,
              integerAnswer: q.integerAnswer,
              assertion: q.assertion,
              reason: q.reason,
              assertionIsTrue: q.assertionIsTrue,
              reasonIsTrue: q.reasonIsTrue,
              reasonExplainsAssertion: q.reasonExplainsAssertion,
              explanation: (q as any).explanation,
              diagramUrl: (q as any).diagramUrl,
            });
          }
        }
      }
      sections.push({
        title: sec.title,
        instructions: sec.instructions,
        marksPerQuestion: sec.marksPerQuestion,
        questions: secQuestions,
      });
    }

    const paperDoc = await Paper.create({
      owner: userId,
      examTitle: examTitle || bp.examTitle,
      subject: bp.subject,
      generalInstructions: bp.generalInstructions,
      sections,
      meta: { source: 'import', blueprintId: bp._id, importedQuestionIds: questionIds },
    });

    return successResponse(res, { message: 'Paper created from imported questions and blueprint', paper: paperDoc });
  } catch (e) {
    console.error('create-paper error', e);
    return errorResponse(res, 'Failed to create paper from blueprint', 500);
  }
});