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
