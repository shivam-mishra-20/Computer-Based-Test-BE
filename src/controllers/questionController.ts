import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { saveBatchValidatedQuestions, EnhancedQuestionData } from '../services/questionValidationService';

/**
 * Save questions with validation
 * POST /api/ai/save-questions
 */
export const saveValidatedQuestionsCtrl = async (req: Request, res: Response) => {
  try {
    const { questions } = req.body;
    const userId = (req as any).user.id;

    if (!questions || !Array.isArray(questions)) {
      return res.status(400).json({
        success: false,
        message: 'Questions array is required'
      });
    }

    // Map incoming questions to EnhancedQuestionData format (class required)
    const enhancedQuestions: Partial<EnhancedQuestionData>[] = questions.map(q => ({
      text: q.text,
      type: q.type,
      subject: q.subject || '',
      topic: q.topic,
      difficulty: q.difficulty || 'medium',
      class: q.class, // required for per-class collection routing
      board: q.board,
      chapter: q.chapter,
      section: q.section,
      marks: q.marks,
      source: q.source || 'AI',
      createdBy: new Types.ObjectId(userId),
      options: q.options,
      correctAnswerText: q.correctAnswerText,
      integerAnswer: q.integerAnswer,
      assertion: q.assertion,
      reason: q.reason,
      assertionIsTrue: q.assertionIsTrue,
      reasonIsTrue: q.reasonIsTrue,
      reasonExplainsAssertion: q.reasonExplainsAssertion,
      explanation: q.explanation || q.solutionText,
      diagramUrl: q.diagramUrl,
      diagramAlt: q.diagramAlt,
    }));

    // Save with validation
    const saved = await saveBatchValidatedQuestions(enhancedQuestions);

    return res.status(201).json({
      success: true,
      data: {
        saved: saved.length,
        skipped: questions.length - saved.length,
        questions: saved
      }
    });
  } catch (error) {
    console.error('Error saving validated questions:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to save questions',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Fetch questions from class-specific collection with filters
 * GET /api/questions/class/:class
 * Query params: subject, chapter, topic, section, difficulty, limit, skip
 */
export const getClassQuestionsCtrl = async (req: Request, res: Response) => {
  try {
    const { class: className } = req.params;
    const { 
      subject, 
      chapter, 
      topic, 
      section, 
      difficulty,
      limit = '100',
      skip = '0'
    } = req.query;

    if (!className) {
      return res.status(400).json({
        success: false,
        message: 'Class parameter is required'
      });
    }

    // Import the class-specific model
    const { getClassQuestionModel } = await import('../models/ClassQuestion');
    const ClassQuestionModel = getClassQuestionModel(className as string);

    // Build filter
    const filter: any = { isActive: true };
    if (subject) filter.subject = subject;
    if (chapter) filter.chapter = { $regex: chapter, $options: 'i' };
    if (topic) filter.topic = { $regex: topic, $options: 'i' };
    if (section) filter.section = section;
    if (difficulty) filter.difficulty = difficulty;

    // Fetch questions
    const [questions, total] = await Promise.all([
      ClassQuestionModel.find(filter)
        .limit(parseInt(limit as string, 10))
        .skip(parseInt(skip as string, 10))
        .sort({ createdAt: -1 })
        .lean(),
      ClassQuestionModel.countDocuments(filter)
    ]);

    return res.status(200).json({
      success: true,
      data: {
        questions,
        total,
        class: className
      }
    });
  } catch (error) {
    console.error('[Get Class Questions] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch questions',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Get distinct values for filters (subjects, chapters, topics, sections)
 * GET /api/questions/class/:class/filters
 */
export const getClassQuestionFiltersCtrl = async (req: Request, res: Response) => {
  try {
    const { class: className } = req.params;
    const { subject } = req.query;

    if (!className) {
      return res.status(400).json({
        success: false,
        message: 'Class parameter is required'
      });
    }

    const { getClassQuestionModel } = await import('../models/ClassQuestion');
    const ClassQuestionModel = getClassQuestionModel(className as string);

    // Base filter
    const baseFilter: any = { isActive: true };
    if (subject) baseFilter.subject = subject;

    // Get distinct values
    const [subjects, chapters, topics, sections] = await Promise.all([
      ClassQuestionModel.distinct('subject', { isActive: true }),
      ClassQuestionModel.distinct('chapter', baseFilter),
      ClassQuestionModel.distinct('topic', baseFilter),
      ClassQuestionModel.distinct('section', baseFilter)
    ]);

    return res.status(200).json({
      success: true,
      data: {
        subjects: subjects.filter(Boolean).sort(),
        chapters: chapters.filter(Boolean).sort(),
        topics: topics.filter(Boolean).sort(),
        sections: sections.filter(Boolean).sort()
      }
    });
  } catch (error) {
    console.error('[Get Class Question Filters] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch filters',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};
