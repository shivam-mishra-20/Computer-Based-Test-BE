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
      // Pagination
      limit = '20',
      page = '1',
      // Filters
      query,
      type,
      subject,
      topic,
      chapter,
      section,
      difficulty,
      source,
      hasCorrectAnswer,
      hasImage,
      hasExplanation
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

    // Text Search
    if (query) {
      const q = (query as string).trim();
      const regex = { $regex: q, $options: 'i' };
      filter.$or = [
        { text: regex },
        { subject: regex },
        { topic: regex },
        { explanation: regex },
        // Also search in nested tags as fallback
        { 'tags.subject': regex },
        { 'tags.topic': regex }
      ];
    }

    // Exact Filters
    if (subject) filter.subject = subject;
    if (chapter) filter.chapter = { $regex: chapter, $options: 'i' };
    if (topic) filter.topic = { $regex: topic, $options: 'i' };
    if (section) filter.section = section;
    if (difficulty) filter.difficulty = difficulty;
    
    // Type Filter
    if (type) filter.type = type;

    // Source Filter
    if (source) {
       // Handle both "manual" and null/undefined as "Manual" if specifically requested, 
       // but typically source is a direct match. The frontend might send "manual".
       // Our model stores "Manual", "Smart Import", etc. or "manual", "imported". 
       // We'll trust the frontend sends the correct value, or use regex if needed.
       // For exact matching:
       filter.source = source;
    }

    // Has Correct Answer Filter
    if (hasCorrectAnswer === 'yes') {
      filter.$or = [
         { 'options.isCorrect': true },
         { correctAnswerText: { $exists: true, $ne: '' } }
      ];
    } else if (hasCorrectAnswer === 'no') {
      filter.$and = [
         { 'options.isCorrect': { $ne: true } },
         { $or: [{ correctAnswerText: { $exists: false } }, { correctAnswerText: '' }] }
      ];
    }

    // Has Image Filter
    if (hasImage === 'yes') {
      filter.diagramUrl = { $exists: true, $ne: '' };
    } else if (hasImage === 'no') {
      filter.$or = [
        { diagramUrl: { $exists: false } },
        { diagramUrl: '' }
      ];
    }

    // Has Explanation Filter
    if (hasExplanation === 'yes') {
       filter.$or = [
          { explanation: { $exists: true, $ne: '' } },
          { solutionText: { $exists: true, $ne: '' } }
       ];
    } else if (hasExplanation === 'no') {
       filter.$and = [
          { $or: [ { explanation: { $exists: false } }, { explanation: '' } ] },
          { $or: [ { solutionText: { $exists: false } }, { solutionText: '' } ] }
       ];
    }

    // Pagination Calculation
    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.max(1, parseInt(limit as string, 10));
    const skip = (pageNum - 1) * limitNum;

    // Fetch questions
    const [questions, total] = await Promise.all([
      ClassQuestionModel.find(filter)
        .limit(limitNum)
        .skip(skip)
        .sort({ createdAt: -1 })
        .lean(),
      ClassQuestionModel.countDocuments(filter)
    ]);

    return res.status(200).json({
      success: true,
      data: {
        questions,
        total,
        page: pageNum,
        totalPages: Math.ceil(total / limitNum),
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

/**
 * Update a question in class-specific collection
 * PUT /api/ai/questions/class/:class/:id
 */
export const updateClassQuestionCtrl = async (req: Request, res: Response) => {
  try {
    const { class: className, id } = req.params;
    const updateData = req.body;

    if (!className || !id) {
      return res.status(400).json({
        success: false,
        message: 'Class and question ID are required'
      });
    }

    const { getClassQuestionModel } = await import('../models/ClassQuestion');
    const ClassQuestionModel = getClassQuestionModel(className as string);

    // Find and update the question
    const updated = await ClassQuestionModel.findByIdAndUpdate(
      id,
      { 
        $set: {
          text: updateData.text,
          type: updateData.type,
          subject: updateData.subject || updateData.tags?.subject,
          topic: updateData.topic || updateData.tags?.topic,
          chapter: updateData.chapter || updateData.tags?.chapter,
          difficulty: updateData.difficulty || updateData.tags?.difficulty,
          board: updateData.board,
          section: updateData.section,
          marks: updateData.marks,
          options: updateData.options,
          correctAnswerText: updateData.correctAnswerText,
          explanation: updateData.explanation,
          diagramUrl: updateData.diagramUrl,
          assertion: updateData.assertion,
          reason: updateData.reason,
          updatedAt: new Date()
        }
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Question not found'
      });
    }

    return res.status(200).json({
      success: true,
      data: updated
    });
  } catch (error) {
    console.error('[Update Class Question] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update question',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Delete a question from class-specific collection
 * DELETE /api/ai/questions/class/:class/:id
 */
export const deleteClassQuestionCtrl = async (req: Request, res: Response) => {
  try {
    const { class: className, id } = req.params;

    if (!className || !id) {
      return res.status(400).json({
        success: false,
        message: 'Class and question ID are required'
      });
    }

    const { getClassQuestionModel } = await import('../models/ClassQuestion');
    const ClassQuestionModel = getClassQuestionModel(className as string);

    // Soft delete by setting isActive to false
    const deleted = await ClassQuestionModel.findByIdAndUpdate(
      id,
      { $set: { isActive: false, updatedAt: new Date() } },
      { new: true }
    );

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Question not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Question deleted successfully'
    });
  } catch (error) {
    console.error('[Delete Class Question] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete question',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Use AI to solve a single MCQ question and mark the correct answer
 * POST /api/ai/questions/class/:class/:id/solve
 */
export const solveClassQuestionCtrl = async (req: Request, res: Response) => {
  try {
    const { class: className, id } = req.params;
    const { preview } = req.body;

    if (!className || !id) {
      return res.status(400).json({
        success: false,
        message: 'Class and question ID are required'
      });
    }

    const { getClassQuestionModel } = await import('../models/ClassQuestion');
    const ClassQuestionModel = getClassQuestionModel(className as string);

    // Find the question
    const question = await ClassQuestionModel.findById(id);
    if (!question) {
      return res.status(404).json({
        success: false,
        message: 'Question not found'
      });
    }

    // Check if it's an MCQ
    if (!['mcq', 'mcq-single', 'Multiple Choice'].includes(question.type)) {
      return res.status(400).json({
        success: false,
        message: 'Only MCQ questions can be solved by AI'
      });
    }

    // Check if already has correct answer
    // If preview is requested, we allow solving even if answer exists (to double check)
    if (!preview) {
        const hasCorrectAnswer = question.options?.some(opt => opt.isCorrect);
        if (hasCorrectAnswer) {
        return res.status(400).json({
            success: false,
            message: 'Question already has a correct answer marked'
        });
        }
    }

    // Solve with AI
    const { solveQuestionWithAI } = await import('../services/answerGenerationService');
    const result = await solveQuestionWithAI({
      _id: question._id?.toString(),
      text: question.text,
      type: question.type,
      options: question.options,
      subject: question.subject,
      topic: question.topic,
      chapter: question.chapter,
    });

    // If preview mode, return result without saving
    if (preview) {
        return res.status(200).json({
          success: true,
          data: question,
          aiResult: {
            correctOptionIndex: result.correctOptionIndex,
            confidence: result.confidence,
            explanation: result.explanation
          }
        });
    }

    // Update the question with correct answer
    const updatedOptions = question.options?.map((opt, idx) => ({
      ...opt,
      isCorrect: idx === result.correctOptionIndex
    }));

    const updated = await ClassQuestionModel.findByIdAndUpdate(
      id,
      {
        $set: {
          options: updatedOptions,
          correctAnswerText: (typeof result.correctOptionIndex === 'number' && question.options && question.options[result.correctOptionIndex]) ? question.options[result.correctOptionIndex].text : undefined,
          explanation: result.explanation || question.explanation,
          updatedAt: new Date()
        }
      },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      data: updated,
      aiResult: {
        correctOptionIndex: result.correctOptionIndex,
        confidence: result.confidence,
        explanation: result.explanation
      }
    });
  } catch (error) {
    console.error('[Solve Class Question] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to solve question',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Solve multiple MCQ questions in batch
 * POST /api/ai/questions/class/:class/solve-batch
 */
export const solveBatchQuestionsCtrl = async (req: Request, res: Response) => {
  try {
    const { class: className } = req.params;
    const { questionIds, preview } = req.body;

    if (!className) {
      return res.status(400).json({
        success: false,
        message: 'Class parameter is required'
      });
    }

    if (!questionIds || !Array.isArray(questionIds) || questionIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'questionIds array is required'
      });
    }

    const { getClassQuestionModel } = await import('../models/ClassQuestion');
    const ClassQuestionModel = getClassQuestionModel(className as string);
    const { solveQuestionWithAI } = await import('../services/answerGenerationService');

    const results: { id: string; success: boolean; error?: string; aiResult?: any }[] = [];
    let solved = 0;
    let failed = 0;

    for (const id of questionIds) {
      try {
        const question = await ClassQuestionModel.findById(id);
        if (!question) {
          results.push({ id, success: false, error: 'Not found' });
          failed++;
          continue;
        }

        if (!['mcq', 'mcq-single', 'Multiple Choice'].includes(question.type)) {
          results.push({ id, success: false, error: 'Not an MCQ' });
          failed++;
          continue;
        }

        if (!preview && question.options?.some(opt => opt.isCorrect)) {
          results.push({ id, success: false, error: 'Already has answer' });
          failed++;
          continue;
        }

        // Solve with AI
        const result = await solveQuestionWithAI({
          _id: question._id?.toString(),
          text: question.text,
          type: question.type,
          options: question.options,
          subject: question.subject,
          topic: question.topic,
          chapter: question.chapter,
        });

        if (preview) {
             results.push({ 
               id, 
               success: true, 
               aiResult: {
                 correctOptionIndex: result.correctOptionIndex,
                 confidence: result.confidence,
                 explanation: result.explanation
               } 
             });
             solved++;
        } else {
             // Update the question
             const updatedOptions = question.options?.map((opt, idx) => ({
                ...opt,
                isCorrect: idx === result.correctOptionIndex
             }));

             await ClassQuestionModel.findByIdAndUpdate(id, {
                $set: {
                  options: updatedOptions,
                  correctAnswerText: (typeof result.correctOptionIndex === 'number' && question.options && question.options[result.correctOptionIndex]) ? question.options[result.correctOptionIndex].text : undefined,
                  explanation: result.explanation || question.explanation,
                  updatedAt: new Date()
                }
             });
             results.push({ id, success: true });
             solved++;
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (error) {
        results.push({ id, success: false, error: error instanceof Error ? error.message : 'Unknown error' });
        failed++;
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        total: questionIds.length,
        solved,
        failed,
        results
      }
    });
  } catch (error) {
    console.error('[Solve Batch Questions] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to solve questions',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Bulk update mapped questions
 * PUT /api/ai/questions/class/:class/bulk-update
 */
export const bulkUpdateClassQuestionsCtrl = async (req: Request, res: Response) => {
  try {
    const { class: className } = req.params;
    const { updates } = req.body; 

    if (!className) {
      return res.status(400).json({ success: false, message: 'Class parameter required' });
    }
    if (!updates || !Array.isArray(updates)) {
      return res.status(400).json({ success: false, message: 'Updates array required' });
    }

    const { getClassQuestionModel } = await import('../models/ClassQuestion');
    const ClassQuestionModel = getClassQuestionModel(className as string);

    let updatedCount = 0;
    let errors = 0;

    for (const update of updates) {
      if (!update.id) continue;
      try {
        await ClassQuestionModel.findByIdAndUpdate(update.id, {
           $set: {
             options: update.options,
             correctAnswerText: update.correctAnswerText,
             explanation: update.explanation,
             updatedAt: new Date()
           }
        });
        updatedCount++;
      } catch (err) {
        console.error(`Failed to update question ${update.id}:`, err);
        errors++;
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        updated: updatedCount,
        errors
      }
    });
  } catch (error) {
    console.error('[Bulk Update] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to bulk update',
      error: (error instanceof Error) ? error.message : 'Unknown error'
    });
  }
};
