import { requireStaffPermission } from '../../middlewares/requirePermission';
import { Router } from 'express';
import { authMiddleware} from '../../middlewares/authMiddleware';
import { parseAnyFiles } from '../../middlewares/formData';
import { evaluateSubjective, generateFromPdf, generateFromText, generatePaper, refineQuestion, generatePaperFromPdf, generateFromImage, createGuidance, listGuidance, updateGuidance, deleteGuidance, generatePaperFromImage, aiGenerateFromPDF, aiGenerateFromImage, aiGenerateFromText, getAiGenerationJob, discardAiGenerationJob } from '../../controllers/aiController';
import { upload } from '../../middlewares/upload';
import { saveValidatedQuestionsCtrl, getClassQuestionsCtrl, getClassQuestionFiltersCtrl, updateClassQuestionCtrl, deleteClassQuestionCtrl, solveClassQuestionCtrl, solveBatchQuestionsCtrl, bulkUpdateMetaCtrl } from '../../controllers/questionController';
import { aiLimiter, uploadLimiter } from '../../middlewares/rateLimiter';
import { requireModule } from '../../middlewares/requireModule';
import { meterRequest } from '../../core/subscriptions/usage';

// Gated PER ROUTE, not as a whole router: this router serves AI generation
// (module `ai`) AND the class question bank (module `questionBank`, which every
// plan sells). Gating it all on `ai` used to refuse an organization its own
// question bank because it had not bought AI. Generation is also metered:
// one unit per accepted request, refunded if the request or its job fails.
const meterAi = meterRequest('aiGenerationsMonthly');

const router = Router();

// NEW AI TOOLS - Vertex AI Gemini 2.5 Pro (Preview + Save workflow like Smart Import)
router.post('/ai-generate/pdf', authMiddleware, requireModule('ai'), requireStaffPermission('ai.generate'), aiLimiter, meterAi, uploadLimiter, upload.single('file'), aiGenerateFromPDF);
router.post('/ai-generate/image', authMiddleware, requireModule('ai'), requireStaffPermission('ai.generate'), aiLimiter, meterAi, uploadLimiter, upload.single('file'), aiGenerateFromImage);
router.post('/ai-generate/text', authMiddleware, requireModule('ai'), requireStaffPermission('ai.generate'), aiLimiter, meterAi, aiGenerateFromText);
// Background generation jobs (pdf/image with async=true): progress, result, discard.
router.get('/ai-generate/jobs/:jobId', authMiddleware, requireModule('ai'), requireStaffPermission('ai.generate'), getAiGenerationJob);
router.delete('/ai-generate/jobs/:jobId', authMiddleware, requireModule('ai'), requireStaffPermission('ai.generate'), discardAiGenerationJob);

// OLD: Teachers/Admins can generate questions (keep for backward compatibility)
router.post('/generate/pdf', authMiddleware, requireModule('ai'), requireStaffPermission('ai.generate'), aiLimiter, meterAi, uploadLimiter, parseAnyFiles, generateFromPdf);
router.post('/generate/image', authMiddleware, requireModule('ai'), requireStaffPermission('ai.generate'), aiLimiter, meterAi, uploadLimiter, upload.single('image'), generateFromImage);
router.post('/generate/text', authMiddleware, requireModule('ai'), requireStaffPermission('ai.generate'), aiLimiter, meterAi, generateFromText);
router.post('/generate/paper', authMiddleware, requireModule('ai'), requireStaffPermission('ai.generate'), aiLimiter, meterAi, generatePaper);
router.post('/generate/paper-pdf', authMiddleware, requireModule('ai'), requireStaffPermission('ai.generate'), aiLimiter, meterAi, uploadLimiter, parseAnyFiles, generatePaperFromPdf);
router.post('/generate/paper-image', authMiddleware, requireModule('ai'), requireStaffPermission('ai.generate'), aiLimiter, meterAi, uploadLimiter, upload.single('image'), generatePaperFromImage);
router.post('/refine', authMiddleware, requireModule('ai'), requireStaffPermission('ai.generate'), aiLimiter, meterAi, refineQuestion);

// Save questions with validation
router.post('/save-questions', authMiddleware, requireModule('questionBank'), requireStaffPermission('questions.create'), saveValidatedQuestionsCtrl);

// Fetch class-wise questions with filters
router.get('/questions/class/:class', authMiddleware, requireModule('questionBank'), requireStaffPermission('questions.read'), getClassQuestionsCtrl);
router.get('/questions/class/:class/filters', authMiddleware, requireModule('questionBank'), requireStaffPermission('questions.read'), getClassQuestionFiltersCtrl);

// Update and delete class-wise questions (static routes MUST come before :id routes)
router.put('/questions/class/:class/bulk-update', authMiddleware, requireModule('questionBank'), requireStaffPermission('questions.update'), require('../../controllers/questionController').bulkUpdateClassQuestionsCtrl);
router.put('/questions/class/:class/bulk-update-meta', authMiddleware, requireModule('questionBank'), requireStaffPermission('questions.update'), bulkUpdateMetaCtrl);
router.put('/questions/class/:class/:id', authMiddleware, requireModule('questionBank'), requireStaffPermission('questions.update'), updateClassQuestionCtrl);
router.delete('/questions/class/:class/:id', authMiddleware, requireModule('questionBank'), requireStaffPermission('questions.delete'), deleteClassQuestionCtrl);

// AI-powered question solving
router.post('/questions/class/:class/solve-batch', authMiddleware, requireModule('ai'), requireStaffPermission('ai.generate'), aiLimiter, meterAi, solveBatchQuestionsCtrl);
router.post('/questions/class/:class/:id/solve', authMiddleware, requireModule('ai'), requireStaffPermission('ai.generate'), aiLimiter, meterAi, solveClassQuestionCtrl);

// On-demand subjective evaluation (teachers/admins)
router.post('/evaluate/subjective', authMiddleware, requireModule('ai'), requireStaffPermission('ai.generate'), aiLimiter, meterAi, evaluateSubjective);

// Admin guidance management
router.post('/guidance', authMiddleware, requireModule('ai'), requireStaffPermission('org.settings'), createGuidance);
router.get('/guidance', authMiddleware, requireModule('ai'), requireStaffPermission('org.settings'), listGuidance);
router.put('/guidance/:id', authMiddleware, requireModule('ai'), requireStaffPermission('org.settings'), updateGuidance);
router.delete('/guidance/:id', authMiddleware, requireModule('ai'), requireStaffPermission('org.settings'), deleteGuidance);

export default router;
