import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { saveBatchValidatedQuestions, sanitizeQuestionData, EnhancedQuestionData } from '../services/questionValidationService';
import {
  ANSWER_KEY_FIELDS,
  AnswerKeyError,
  answerKeyErrorBody,
  answerKeyProblem,
  findAnswerKeyIssues,
  type AnswerKeyFields,
  type AnswerKeyIssue,
} from '../services/questionAnswerKey';

/**
 * Fields of a class-bank update that can change a question's answer key. An
 * update that sends none of them (text, tags, explanation …) leaves the key as
 * it was, so it is not re-checked — that keeps metadata edits working on older
 * questions saved before keys were required.
 */
const KEY_FIELDS = ['type', 'options', 'correctAnswerText', 'assertionIsTrue', 'reasonIsTrue'] as const;

function touchesAnswerKey(update: Record<string, unknown> | null | undefined): boolean {
  return !!update && KEY_FIELDS.some((field) => update[field] !== undefined);
}

/** The question as it would be after `update` is $set over `existing` (undefined keys are not written). */
function mergedForKeyCheck(existing: AnswerKeyFields & { text?: unknown }, update: Record<string, unknown>) {
  const merged: Record<string, unknown> = { ...existing };
  for (const field of KEY_FIELDS) {
    if (update[field] !== undefined) merged[field] = update[field];
  }
  return merged as AnswerKeyFields & { text?: unknown };
}

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
      diagram: q.diagram,
      tableData: q.tableData,
      isPYQ: q.isPYQ,
      pyqYear: q.pyqYear,
      pyqExam: q.pyqExam,
      pyqShift: q.pyqShift,
    }));

    // Refuse the whole save when any question has no usable answer key, and
    // say which ones. The batch saver would otherwise skip them silently and
    // report only a "skipped" count. Checked after the same sanitization the
    // saver applies, so a question it would fix is not refused.
    const keyIssues = findAnswerKeyIssues(enhancedQuestions.map((q) => sanitizeQuestionData(q)));
    if (keyIssues.length > 0) {
      return res.status(400).json(answerKeyErrorBody(new AnswerKeyError(keyIssues, 'Nothing was saved')));
    }

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
      board,
      section,
      difficulty,
      source,
      hasCorrectAnswer,
      hasImage,
      hasExplanation,
      isPYQ,
      pyqYear,
      pyqExam,
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

    // Build filter — all conditions go into $and to prevent $or/$and key collisions
    // isActive: use $ne: false to also match docs where isActive is missing/undefined
    const andClauses: any[] = [{ isActive: { $ne: false } }];

    // Text Search
    if (query) {
      const q = (query as string).trim();
      const regex = { $regex: q, $options: 'i' };
      andClauses.push({
        $or: [
          { text: regex },
          { subject: regex },
          { topic: regex },
          { explanation: regex },
        ]
      });
    }

    // Case-insensitive string filters (prevents case mismatch between stored values and dropdown)
    if (subject) andClauses.push({ subject: { $regex: `^${String(subject).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
    if (chapter) andClauses.push({ chapter: { $regex: String(chapter).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } });
    if (topic) andClauses.push({ topic: { $regex: String(topic).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } });
    if (board) andClauses.push({ board: { $regex: `^${String(board).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
    if (section) andClauses.push({ section: String(section) });
    if (difficulty) andClauses.push({ difficulty: { $regex: `^${String(difficulty).trim()}$`, $options: 'i' } });
    if (type) andClauses.push({ type: { $regex: `^${String(type).trim()}$`, $options: 'i' } });
    if (source) andClauses.push({ source: { $regex: `^${String(source).trim()}$`, $options: 'i' } });

    // Has Correct Answer Filter
    if (hasCorrectAnswer === 'yes') {
      andClauses.push({ $or: [{ 'options.isCorrect': true }, { correctAnswerText: { $exists: true, $ne: '' } }] });
    } else if (hasCorrectAnswer === 'no') {
      andClauses.push({ 'options.isCorrect': { $ne: true } });
      andClauses.push({ $or: [{ correctAnswerText: { $exists: false } }, { correctAnswerText: '' }] });
    }

    // Has Image Filter
    if (hasImage === 'yes') {
      andClauses.push({ diagramUrl: { $exists: true, $ne: '' } });
    } else if (hasImage === 'no') {
      andClauses.push({ $or: [{ diagramUrl: { $exists: false } }, { diagramUrl: '' }] });
    }

    // PYQ Filters
    if (isPYQ === 'true') andClauses.push({ isPYQ: true });
    if (pyqYear) andClauses.push({ pyqYear: Number(pyqYear) });
    if (pyqExam) andClauses.push({ pyqExam: { $regex: `^${String(pyqExam).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });

    // Has Explanation Filter
    if (hasExplanation === 'yes') {
      andClauses.push({ $or: [{ explanation: { $exists: true, $ne: '' } }, { solutionText: { $exists: true, $ne: '' } }] });
    } else if (hasExplanation === 'no') {
      andClauses.push({ $or: [{ explanation: { $exists: false } }, { explanation: '' }] });
      andClauses.push({ $or: [{ solutionText: { $exists: false } }, { solutionText: '' }] });
    }

    const filter: any = andClauses.length === 1 ? andClauses[0] : { $and: andClauses };
    console.log(`[Get Questions] class=${className} filter=${JSON.stringify(filter)} page=${page} limit=${limit}`);

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
    const { subject, board } = req.query;

    if (!className) {
      return res.status(400).json({
        success: false,
        message: 'Class parameter is required'
      });
    }

    const { getClassQuestionModel } = await import('../models/ClassQuestion');
    const ClassQuestionModel = getClassQuestionModel(className as string);

    const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // board scopes everything except the boards list itself
    const boardClause = board
      ? { board: { $regex: `^${escapeRegex(String(board).trim())}$`, $options: 'i' } }
      : {};

    // Base filter — use $ne: false to match docs where isActive is missing too
    // subject supports a comma-separated list so multiple subjects can be scoped at once
    const baseFilter: any = { isActive: { $ne: false }, ...boardClause };
    if (subject) {
      const subjectList = String(subject)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (subjectList.length === 1) {
        baseFilter.subject = { $regex: `^${escapeRegex(subjectList[0])}$`, $options: 'i' };
      } else if (subjectList.length > 1) {
        baseFilter.subject = { $in: subjectList.map((s) => new RegExp(`^${escapeRegex(s)}$`, 'i')) };
      }
    }

    // Get distinct values — all use $ne:false so missing-isActive docs are included
    const activeFilter = { isActive: { $ne: false }, ...boardClause };
    const pyqFilter = { isActive: { $ne: false }, isPYQ: true };
    const allBoardsFilter = { isActive: { $ne: false } };
    const [subjects, chapters, topics, sections, boards, sources, types, pyqYears, pyqExams] = await Promise.all([
      ClassQuestionModel.distinct('subject', activeFilter),
      ClassQuestionModel.distinct('chapter', baseFilter),
      ClassQuestionModel.distinct('topic', baseFilter),
      ClassQuestionModel.distinct('section', baseFilter),
      ClassQuestionModel.distinct('board', allBoardsFilter),
      ClassQuestionModel.distinct('source', activeFilter),
      ClassQuestionModel.distinct('type', activeFilter),
      ClassQuestionModel.distinct('pyqYear', pyqFilter),
      ClassQuestionModel.distinct('pyqExam', pyqFilter),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        subjects: subjects.filter(Boolean).sort(),
        chapters: chapters.filter(Boolean).sort(),
        topics: topics.filter(Boolean).sort(),
        sections: sections.filter(Boolean).sort(),
        boards: boards.filter(Boolean).sort(),
        sources: sources.filter(Boolean).sort(),
        types: types.filter(Boolean).sort(),
        pyqYears: (pyqYears as number[]).filter(Boolean).sort((a, b) => b - a),
        pyqExams: pyqExams.filter(Boolean).sort(),
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

    if (touchesAnswerKey(updateData)) {
      const existing = await ClassQuestionModel.findById(id).select(`${ANSWER_KEY_FIELDS} text`).lean();
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Question not found' });
      }
      const issues = findAnswerKeyIssues([mergedForKeyCheck(existing as AnswerKeyFields, updateData)], () => 'This question');
      if (issues.length > 0) {
        return res.status(400).json(answerKeyErrorBody(new AnswerKeyError(issues, 'Not saved')));
      }
    }

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
          assertionIsTrue: updateData.assertionIsTrue,
          reasonIsTrue: updateData.reasonIsTrue,
          reasonExplainsAssertion: updateData.reasonExplainsAssertion,
          integerAnswer: updateData.integerAnswer,
          isPYQ: updateData.isPYQ ?? false,
          pyqYear: updateData.pyqYear,
          pyqExam: updateData.pyqExam,
          pyqShift: updateData.pyqShift,
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

    // Update the question with correct answer. `opt` is a hydrated subdocument:
    // spreading it copies Mongoose internals, not its fields, and the cast
    // update then keeps the ORIGINAL isCorrect flags — so convert it first.
    const updatedOptions = question.options?.map((opt, idx) => ({
      ...(typeof (opt as any).toObject === 'function' ? (opt as any).toObject() : opt),
      isCorrect: idx === result.correctOptionIndex
    }));

    // An index outside the options marks nothing correct; saving that would
    // leave the question ungradable, so nothing is written.
    const keyProblem = answerKeyProblem({ type: question.type, options: updatedOptions });
    if (keyProblem) {
      return res.status(422).json({
        success: false,
        code: 'ANSWER_KEY_MISSING',
        message: `AI did not identify one of the options as correct; nothing was saved. ${keyProblem}`,
        aiResult: { correctOptionIndex: result.correctOptionIndex, confidence: result.confidence },
      });
    }

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
          // Update the question (hydrated subdocuments: see solveClassQuestionCtrl)
          const updatedOptions = question.options?.map((opt, idx) => ({
            ...(typeof (opt as any).toObject === 'function' ? (opt as any).toObject() : opt),
            isCorrect: idx === result.correctOptionIndex
          }));

          const keyProblem = answerKeyProblem({ type: question.type, options: updatedOptions });
          if (keyProblem) {
            results.push({ id, success: false, error: `AI did not identify a correct option; not saved. ${keyProblem}` });
            failed++;
            continue;
          }

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
 * Bulk update metadata for all questions matching a filter value
 * PUT /api/ai/questions/class/:class/bulk-update-meta
 * Body: { field, fromValue, toValue }
 * e.g. { field: "subject", fromValue: "Unknown", toValue: "Mathematics" }
 */
export const bulkUpdateMetaCtrl = async (req: Request, res: Response) => {
  try {
    const { class: className } = req.params;
    const { field, fromValue, toValue } = req.body;

    const allowedFields = ['subject', 'topic', 'chapter', 'difficulty', 'board', 'source', 'pyqExam', 'pyqShift'];
    if (!className) return res.status(400).json({ success: false, message: 'Class required' });
    if (!allowedFields.includes(field)) return res.status(400).json({ success: false, message: `Field must be one of: ${allowedFields.join(', ')}` });
    if (!toValue || !toValue.toString().trim()) return res.status(400).json({ success: false, message: 'toValue is required' });

    const { getClassQuestionModel } = await import('../models/ClassQuestion');
    const ClassQuestionModel = getClassQuestionModel(className as string);

    const matchFilter: any = { isActive: true };
    if (fromValue !== undefined && fromValue !== null && fromValue !== '') {
      matchFilter[field] = fromValue;
    } else {
      // Match missing/empty/null
      matchFilter.$or = [{ [field]: { $exists: false } }, { [field]: '' }, { [field]: null }];
    }

    const result = await ClassQuestionModel.updateMany(matchFilter, { $set: { [field]: toValue.toString().trim(), updatedAt: new Date() } });

    return res.status(200).json({ success: true, data: { updated: result.modifiedCount } });
  } catch (error) {
    console.error('[Bulk Update Meta] Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to bulk update metadata', error: error instanceof Error ? error.message : 'Unknown error' });
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

    // Check every answer-key change before writing any of them, so a refused
    // request leaves the bank exactly as it was. Only the fields this handler
    // actually $sets are considered.
    const written = (u: any) => ({ options: u.options, correctAnswerText: u.correctAnswerText });
    const keyed = updates.filter(
      (u: any) => u && u.id && Types.ObjectId.isValid(String(u.id)) && touchesAnswerKey(written(u)),
    );
    if (keyed.length > 0) {
      const existing = await ClassQuestionModel.find({ _id: { $in: keyed.map((u: any) => String(u.id)) } })
        .select(`${ANSWER_KEY_FIELDS} text`)
        .lean();
      const byId = new Map(existing.map((q: any) => [String(q._id), q]));
      const issues: AnswerKeyIssue[] = [];
      keyed.forEach((u: any) => {
        const current = byId.get(String(u.id));
        if (!current) return; // unknown id: findByIdAndUpdate below is a no-op for it, as before
        const [issue] = findAnswerKeyIssues([{ ...mergedForKeyCheck(current, written(u)), _id: u.id }], () => `Question ${String(u.id)}`);
        if (issue) issues.push({ ...issue, position: updates.indexOf(u) + 1 });
      });
      if (issues.length > 0) {
        return res.status(400).json(answerKeyErrorBody(new AnswerKeyError(issues, 'Nothing was updated')));
      }
    }

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
