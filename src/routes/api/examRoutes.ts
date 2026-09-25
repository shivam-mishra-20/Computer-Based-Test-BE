import { requireStaffPermission } from '../../middlewares/requirePermission';
import { Router } from 'express';
import { authMiddleware} from '../../middlewares/authMiddleware';
import { invalidateCacheOn } from '../../utils/cacheHelpers';
import {
  assignExamCtrl,
  createExamCtrl,
  createQuestionCtrl,
  deleteExamCtrl,
  deleteQuestionCtrl,
  getExamCtrl,
  listExamsCtrl,
  listQuestionsCtrl,
  updateExamCtrl,
  updateQuestionCtrl,
  createBlueprintCtrl,
  listBlueprintsCtrl,
  updateBlueprintCtrl,
  deleteBlueprintCtrl,
  createExamFromPaperCtrl,
  getTopicsCtrl,
  getQuestionsForPaperCtrl,
  getChaptersCtrl,
} from '../../controllers/examController';

const router = Router();

// Questions bank (teacher/admin)
router.post('/questions', authMiddleware, requireStaffPermission('questions.create'), createQuestionCtrl);
router.get('/questions', authMiddleware, requireStaffPermission('questions.read'), listQuestionsCtrl);
router.get('/questions/topics', authMiddleware, requireStaffPermission('questions.read'), getTopicsCtrl);
router.get('/questions/chapters', authMiddleware, requireStaffPermission('questions.read'), getChaptersCtrl);
router.get('/questions/for-paper', authMiddleware, requireStaffPermission('questions.read'), getQuestionsForPaperCtrl);
router.put('/questions/:id', authMiddleware, requireStaffPermission('questions.update'), updateQuestionCtrl);
router.delete('/questions/:id', authMiddleware, requireStaffPermission('questions.delete'), deleteQuestionCtrl);

// Exams (teacher/admin). Creating/publishing an exam must clear the students'
// cached assigned-exams list (cached 180s) or a newly published exam takes up to
// 3 minutes to appear on the student side.
const invalidateAssigned = invalidateCacheOn({ patterns: ['assigned-exams', 'attempts'] });
router.post('/', authMiddleware, requireStaffPermission('exams.create'), invalidateAssigned, createExamCtrl);
router.get('/', authMiddleware, requireStaffPermission('exams.read'), listExamsCtrl);

// Place more specific sub-routes BEFORE parameterized :id to avoid collisions
// Blueprints
router.post('/blueprints', authMiddleware, requireStaffPermission('exams.create'), createBlueprintCtrl);
router.get('/blueprints', authMiddleware, requireStaffPermission('exams.read'), listBlueprintsCtrl);
router.put('/blueprints/:id', authMiddleware, requireStaffPermission('exams.update'), updateBlueprintCtrl);
router.delete('/blueprints/:id', authMiddleware, requireStaffPermission('exams.delete'), deleteBlueprintCtrl);

// Create exam from generated paper
router.post('/from-paper', authMiddleware, requireStaffPermission('exams.create'), createExamFromPaperCtrl);

// Param-based exam operations (must come after specific paths)
router.get('/:id', authMiddleware, requireStaffPermission('exams.read'), getExamCtrl);
router.put('/:id', authMiddleware, requireStaffPermission('exams.update'), invalidateAssigned, updateExamCtrl);
router.delete('/:id', authMiddleware, requireStaffPermission('exams.delete'), invalidateAssigned, deleteExamCtrl);

// Assign exams
router.post('/:id/assign', authMiddleware, requireStaffPermission('exams.publish'), invalidateAssigned, assignExamCtrl);

export default router;
