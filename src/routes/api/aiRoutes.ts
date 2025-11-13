import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import { parseAnyFiles } from '../../middlewares/formData';
import { evaluateSubjective, generateFromPdf, generateFromText, generatePaper, refineQuestion, generatePaperFromPdf, generateFromImage, createGuidance, listGuidance, updateGuidance, deleteGuidance, generatePaperFromImage, aiGenerateFromPDF, aiGenerateFromImage, aiGenerateFromText } from '../../controllers/aiController';
import { upload } from '../../middlewares/upload';
import { saveValidatedQuestionsCtrl, getClassQuestionsCtrl, getClassQuestionFiltersCtrl } from '../../controllers/questionController';

const router = Router();

// NEW AI TOOLS - Vertex AI Gemini 2.5 Pro (Preview + Save workflow like Smart Import)
router.post('/ai-generate/pdf', authMiddleware, requireRole('teacher', 'admin'), upload.single('file'), aiGenerateFromPDF);
router.post('/ai-generate/image', authMiddleware, requireRole('teacher', 'admin'), upload.single('file'), aiGenerateFromImage);
router.post('/ai-generate/text', authMiddleware, requireRole('teacher', 'admin'), aiGenerateFromText);

// OLD: Teachers/Admins can generate questions (keep for backward compatibility)
router.post('/generate/pdf', authMiddleware, requireRole('teacher', 'admin'), parseAnyFiles, generateFromPdf);
router.post('/generate/image', authMiddleware, requireRole('teacher', 'admin'), upload.single('image'), generateFromImage);
router.post('/generate/text', authMiddleware, requireRole('teacher', 'admin'), generateFromText);
router.post('/generate/paper', authMiddleware, requireRole('teacher', 'admin'), generatePaper);
router.post('/generate/paper-pdf', authMiddleware, requireRole('teacher', 'admin'), parseAnyFiles, generatePaperFromPdf);
router.post('/generate/paper-image', authMiddleware, requireRole('teacher', 'admin'), upload.single('image'), generatePaperFromImage);
router.post('/refine', authMiddleware, requireRole('teacher', 'admin'), refineQuestion);

// Save questions with validation
router.post('/save-questions', authMiddleware, requireRole('teacher', 'admin'), saveValidatedQuestionsCtrl);

// Fetch class-wise questions with filters
router.get('/questions/class/:class', authMiddleware, requireRole('teacher', 'admin'), getClassQuestionsCtrl);
router.get('/questions/class/:class/filters', authMiddleware, requireRole('teacher', 'admin'), getClassQuestionFiltersCtrl);

// On-demand subjective evaluation (teachers/admins)
router.post('/evaluate/subjective', authMiddleware, requireRole('teacher', 'admin'), evaluateSubjective);

// Admin guidance management
router.post('/guidance', authMiddleware, requireRole('admin'), createGuidance);
router.get('/guidance', authMiddleware, requireRole('admin'), listGuidance);
router.put('/guidance/:id', authMiddleware, requireRole('admin'), updateGuidance);
router.delete('/guidance/:id', authMiddleware, requireRole('admin'), deleteGuidance);

export default router;
