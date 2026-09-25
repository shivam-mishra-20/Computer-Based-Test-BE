import { requireStaffPermission } from '../../middlewares/requirePermission';
import { Router } from 'express';
import { authMiddleware} from '../../middlewares/authMiddleware';
import { parseAnyFiles } from '../../middlewares/formData';
import { evaluateSubjective, generateFromPdf, generateFromText, generatePaper, refineQuestion, generatePaperFromPdf, generateFromImage, createGuidance, listGuidance, updateGuidance, deleteGuidance, generatePaperFromImage, aiGenerateFromPDF, aiGenerateFromImage, aiGenerateFromText } from '../../controllers/aiController';
import { upload } from '../../middlewares/upload';
import { saveValidatedQuestionsCtrl, getClassQuestionsCtrl, getClassQuestionFiltersCtrl, updateClassQuestionCtrl, deleteClassQuestionCtrl, solveClassQuestionCtrl, solveBatchQuestionsCtrl, bulkUpdateMetaCtrl } from '../../controllers/questionController';
import { aiLimiter, uploadLimiter } from '../../middlewares/rateLimiter';

const router = Router();

// NEW AI TOOLS - Vertex AI Gemini 2.5 Pro (Preview + Save workflow like Smart Import)
router.post('/ai-generate/pdf', authMiddleware, requireStaffPermission('ai.generate'), aiLimiter, uploadLimiter, upload.single('file'), aiGenerateFromPDF);
router.post('/ai-generate/image', authMiddleware, requireStaffPermission('ai.generate'), aiLimiter, uploadLimiter, upload.single('file'), aiGenerateFromImage);
router.post('/ai-generate/text', authMiddleware, requireStaffPermission('ai.generate'), aiLimiter, aiGenerateFromText);

// OLD: Teachers/Admins can generate questions (keep for backward compatibility)
router.post('/generate/pdf', authMiddleware, requireStaffPermission('ai.generate'), aiLimiter, uploadLimiter, parseAnyFiles, generateFromPdf);
router.post('/generate/image', authMiddleware, requireStaffPermission('ai.generate'), aiLimiter, uploadLimiter, upload.single('image'), generateFromImage);
router.post('/generate/text', authMiddleware, requireStaffPermission('ai.generate'), aiLimiter, generateFromText);
router.post('/generate/paper', authMiddleware, requireStaffPermission('ai.generate'), aiLimiter, generatePaper);
router.post('/generate/paper-pdf', authMiddleware, requireStaffPermission('ai.generate'), aiLimiter, uploadLimiter, parseAnyFiles, generatePaperFromPdf);
router.post('/generate/paper-image', authMiddleware, requireStaffPermission('ai.generate'), aiLimiter, uploadLimiter, upload.single('image'), generatePaperFromImage);
router.post('/refine', authMiddleware, requireStaffPermission('ai.generate'), aiLimiter, refineQuestion);

// Save questions with validation
router.post('/save-questions', authMiddleware, requireStaffPermission('questions.create'), saveValidatedQuestionsCtrl);

// Fetch class-wise questions with filters
router.get('/questions/class/:class', authMiddleware, requireStaffPermission('questions.read'), getClassQuestionsCtrl);
router.get('/questions/class/:class/filters', authMiddleware, requireStaffPermission('questions.read'), getClassQuestionFiltersCtrl);

// Update and delete class-wise questions (static routes MUST come before :id routes)
router.put('/questions/class/:class/bulk-update', authMiddleware, requireStaffPermission('questions.update'), require('../../controllers/questionController').bulkUpdateClassQuestionsCtrl);
router.put('/questions/class/:class/bulk-update-meta', authMiddleware, requireStaffPermission('questions.update'), bulkUpdateMetaCtrl);
router.put('/questions/class/:class/:id', authMiddleware, requireStaffPermission('questions.update'), updateClassQuestionCtrl);
router.delete('/questions/class/:class/:id', authMiddleware, requireStaffPermission('questions.delete'), deleteClassQuestionCtrl);

// AI-powered question solving
router.post('/questions/class/:class/solve-batch', authMiddleware, requireStaffPermission('ai.generate'), aiLimiter, solveBatchQuestionsCtrl);
router.post('/questions/class/:class/:id/solve', authMiddleware, requireStaffPermission('ai.generate'), aiLimiter, solveClassQuestionCtrl);

// On-demand subjective evaluation (teachers/admins)
router.post('/evaluate/subjective', authMiddleware, requireStaffPermission('ai.generate'), aiLimiter, evaluateSubjective);

// Admin guidance management
router.post('/guidance', authMiddleware, requireStaffPermission('org.settings'), createGuidance);
router.get('/guidance', authMiddleware, requireStaffPermission('org.settings'), listGuidance);
router.put('/guidance/:id', authMiddleware, requireStaffPermission('org.settings'), updateGuidance);
router.delete('/guidance/:id', authMiddleware, requireStaffPermission('org.settings'), deleteGuidance);

export default router;
