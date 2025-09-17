import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
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
} from '../../controllers/examController';

const router = Router();

// Questions bank (teacher/admin)
router.post('/questions', authMiddleware, requireRole('teacher', 'admin'), createQuestionCtrl);
router.get('/questions', authMiddleware, requireRole('teacher', 'admin'), listQuestionsCtrl);
router.put('/questions/:id', authMiddleware, requireRole('teacher', 'admin'), updateQuestionCtrl);
router.delete('/questions/:id', authMiddleware, requireRole('teacher', 'admin'), deleteQuestionCtrl);

// Exams (teacher/admin)
router.post('/', authMiddleware, requireRole('teacher', 'admin'), createExamCtrl);
router.get('/', authMiddleware, requireRole('teacher', 'admin'), listExamsCtrl);

// Place more specific sub-routes BEFORE parameterized :id to avoid collisions
// Blueprints
router.post('/blueprints', authMiddleware, requireRole('teacher', 'admin'), createBlueprintCtrl);
router.get('/blueprints', authMiddleware, requireRole('teacher', 'admin'), listBlueprintsCtrl);
router.put('/blueprints/:id', authMiddleware, requireRole('teacher', 'admin'), updateBlueprintCtrl);
router.delete('/blueprints/:id', authMiddleware, requireRole('teacher', 'admin'), deleteBlueprintCtrl);

// Create exam from generated paper
router.post('/from-paper', authMiddleware, requireRole('teacher', 'admin'), createExamFromPaperCtrl);

// Param-based exam operations (must come after specific paths)
router.get('/:id', authMiddleware, requireRole('teacher', 'admin'), getExamCtrl);
router.put('/:id', authMiddleware, requireRole('teacher', 'admin'), updateExamCtrl);
router.delete('/:id', authMiddleware, requireRole('teacher', 'admin'), deleteExamCtrl);

// Assign exams
router.post('/:id/assign', authMiddleware, requireRole('teacher', 'admin'), assignExamCtrl);

export default router;
