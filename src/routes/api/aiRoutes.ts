import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import { parseAnyFiles } from '../../middlewares/formData';
import { evaluateSubjective, generateFromPdf, generateFromText, generatePaper, refineQuestion, generatePaperFromPdf, generateFromImage, createGuidance, listGuidance, updateGuidance, deleteGuidance, generatePaperFromImage, aiGenerateFromPDF, aiGenerateFromImage, aiGenerateFromText } from '../../controllers/aiController';
import { upload } from '../../middlewares/upload';
import { saveValidatedQuestionsCtrl, getClassQuestionsCtrl, getClassQuestionFiltersCtrl, updateClassQuestionCtrl, deleteClassQuestionCtrl, solveClassQuestionCtrl, solveBatchQuestionsCtrl } from '../../controllers/questionController';
import { aiLimiter, uploadLimiter } from '../../middlewares/rateLimiter';

const router = Router();

// NEW AI TOOLS - Vertex AI Gemini 2.5 Pro (Preview + Save workflow like Smart Import)
router.post('/ai-generate/pdf', authMiddleware, requireRole('teacher', 'admin'), aiLimiter, uploadLimiter, upload.single('file'), aiGenerateFromPDF);
router.post('/ai-generate/image', authMiddleware, requireRole('teacher', 'admin'), aiLimiter, uploadLimiter, upload.single('file'), aiGenerateFromImage);
router.post('/ai-generate/text', authMiddleware, requireRole('teacher', 'admin'), aiLimiter, aiGenerateFromText);

// OLD: Teachers/Admins can generate questions (keep for backward compatibility)
router.post('/generate/pdf', authMiddleware, requireRole('teacher', 'admin'), aiLimiter, uploadLimiter, parseAnyFiles, generateFromPdf);
router.post('/generate/image', authMiddleware, requireRole('teacher', 'admin'), aiLimiter, uploadLimiter, upload.single('image'), generateFromImage);
router.post('/generate/text', authMiddleware, requireRole('teacher', 'admin'), aiLimiter, generateFromText);
router.post('/generate/paper', authMiddleware, requireRole('teacher', 'admin'), aiLimiter, generatePaper);
router.post('/generate/paper-pdf', authMiddleware, requireRole('teacher', 'admin'), aiLimiter, uploadLimiter, parseAnyFiles, generatePaperFromPdf);
router.post('/generate/paper-image', authMiddleware, requireRole('teacher', 'admin'), aiLimiter, uploadLimiter, upload.single('image'), generatePaperFromImage);
router.post('/refine', authMiddleware, requireRole('teacher', 'admin'), aiLimiter, refineQuestion);

// Save questions with validation
router.post('/save-questions', authMiddleware, requireRole('teacher', 'admin'), saveValidatedQuestionsCtrl);

// Fetch class-wise questions with filters
router.get('/questions/class/:class', authMiddleware, requireRole('teacher', 'admin'), getClassQuestionsCtrl);
router.get('/questions/class/:class/filters', authMiddleware, requireRole('teacher', 'admin'), getClassQuestionFiltersCtrl);

// Update and delete class-wise questions (bulk-update MUST come before :id routes)
router.put('/questions/class/:class/bulk-update', authMiddleware, requireRole('teacher', 'admin'), require('../../controllers/questionController').bulkUpdateClassQuestionsCtrl);
router.put('/questions/class/:class/:id', authMiddleware, requireRole('teacher', 'admin'), updateClassQuestionCtrl);
router.delete('/questions/class/:class/:id', authMiddleware, requireRole('teacher', 'admin'), deleteClassQuestionCtrl);

// AI-powered question solving
router.post('/questions/class/:class/solve-batch', authMiddleware, requireRole('teacher', 'admin'), aiLimiter, solveBatchQuestionsCtrl);
router.post('/questions/class/:class/:id/solve', authMiddleware, requireRole('teacher', 'admin'), aiLimiter, solveClassQuestionCtrl);

// On-demand subjective evaluation (teachers/admins)
router.post('/evaluate/subjective', authMiddleware, requireRole('teacher', 'admin'), aiLimiter, evaluateSubjective);

// Admin guidance management
router.post('/guidance', authMiddleware, requireRole('admin'), createGuidance);
router.get('/guidance', authMiddleware, requireRole('admin'), listGuidance);
router.put('/guidance/:id', authMiddleware, requireRole('admin'), updateGuidance);
router.delete('/guidance/:id', authMiddleware, requireRole('admin'), deleteGuidance);

export default router;
