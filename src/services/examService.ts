import { Types } from 'mongoose';
import Exam, { IExam } from '../models/Exam';
import Question, { IQuestion } from '../models/Question';
import Blueprint, { IBlueprint } from '../models/Blueprint';
import { ImportedQuestion } from '../models/ImportedQuestion';
import { getClassQuestionModel } from '../models/ClassQuestion';
import type { GeneratedPaperResult } from './aiService';
import User from '../models/User';
import * as notificationService from './notificationService';
import mongoose from 'mongoose';

export const createQuestion = async (payload: Partial<IQuestion> & { createdBy: Types.ObjectId }): Promise<IQuestion> => {
  const q = await Question.create(payload as IQuestion);
  return q;
};

export const listQuestions = async (filter: any = {}, limit = 50, skip = 0) => {
  // Aggregate questions from:
  // 1. ImportedQuestions collection
  // 2. All class_* collections (class_7, class_8, class_11, etc.)

  const allQuestions: any[] = [];

  // 1. Get questions from ImportedQuestions collection
  const importedQuestions = await ImportedQuestion.find().limit(1000).sort({ createdAt: -1 }).lean();
  allQuestions.push(...importedQuestions.map((q: any) => ({
    ...q,
    _id: q._id,
    text: q.text,
    type: q.type,
    options: q.options,
    correctAnswerText: q.correctAnswerText,
    imageUrl: q.diagramUrl,
    explanation: q.originalText || '',
    source: 'imported',
    tags: {
      subject: q.subject,
      topic: q.topic,
      difficulty: q.difficulty,
      chapter: q.chapter,
    }
  })));

  // 3. Get all class_* collections dynamically
  const db = mongoose.connection.db;
  if (db) {
    const collections = await db.listCollections().toArray();
    const classCollections = collections
      .map(c => c.name)
      .filter(name => name.startsWith('class_'));

    // Fetch questions from each class collection
    for (const collectionName of classCollections) {
      try {
        // Extract class name from collection (e.g., class_11 -> 11)
        const className = collectionName.replace('class_', '');
        const ClassModel = getClassQuestionModel(className);
        const classQuestions = await ClassModel.find().limit(1000).sort({ createdAt: -1 }).lean();
        
        allQuestions.push(...classQuestions.map((q: any) => ({
          ...q,
          _id: q._id,
          text: q.text,
          type: q.type,
          options: q.options,
          correctAnswerText: q.correctAnswerText,
          imageUrl: q.diagramUrl,
          explanation: q.explanation,
          source: 'Smart Import',
          tags: {
            subject: q.subject,
            topic: q.topic,
            difficulty: q.difficulty,
            chapter: q.chapter,
          }
        })));
      } catch (err) {
        console.error(`Error fetching from ${collectionName}:`, err);
      }
    }
  }

  // Apply filters to aggregated questions
  let filtered = allQuestions;

  if (filter.text) {
    const regex = new RegExp(filter.text.$regex || filter.text, 'i');
    filtered = filtered.filter(q => regex.test(q.text));
  }
  if (filter['tags.subject']) {
    filtered = filtered.filter(q => q.tags?.subject === filter['tags.subject']);
  }
  if (filter['tags.topic']) {
    filtered = filtered.filter(q => q.tags?.topic === filter['tags.topic']);
  }
  if (filter['tags.difficulty']) {
    filtered = filtered.filter(q => q.tags?.difficulty === filter['tags.difficulty']);
  }

  // Sort by creation date (newest first)
  filtered.sort((a, b) => {
    const dateA = new Date(a.createdAt || 0).getTime();
    const dateB = new Date(b.createdAt || 0).getTime();
    return dateB - dateA;
  });

  // Apply pagination
  const total = filtered.length;
  const items = filtered.slice(skip, skip + limit);

  return { items, total };
};

export const updateQuestion = async (id: string, payload: Partial<IQuestion>) => {
  const q = await Question.findByIdAndUpdate(id, payload, { new: true });
  return q;
};

export const deleteQuestion = async (id: string) => {
  await Question.findByIdAndDelete(id);
};

export const createExam = async (payload: Partial<IExam>): Promise<IExam> => {
  const exam = await Exam.create(payload as IExam);
  return exam;
};

export const updateExam = async (id: string, payload: Partial<IExam>) => {
  return Exam.findByIdAndUpdate(id, payload, { new: true });
};

export const getExam = async (id: string) => Exam.findById(id);
export const listExams = async (filter: any = {}, limit = 50, skip = 0) => {
  const [items, total] = await Promise.all([
    Exam.find(filter).limit(limit).skip(skip).sort({ createdAt: -1 }),
    Exam.countDocuments(filter),
  ]);
  return { items, total };
};

export const deleteExam = async (id: string) => Exam.findByIdAndDelete(id);

export const assignExam = async (id: string, users?: string[], groups?: string[]) => {
  const exam = await Exam.findById(id);
  if (!exam) return null;
  exam.assignedTo = {
    users: users?.map((u) => new Types.ObjectId(u)),
    groups,
  };
  await exam.save();

  // Trigger Notifications
  try {
    const userIds = new Set<string>();
    
    // Add directly assigned users
    if (users) users.forEach(u => userIds.add(u));

    // Resolve groups to users
    if (groups && groups.length > 0) {
      const groupUsers = await User.find({
        $or: [
          { batch: { $in: groups } },
          { classLevel: { $in: groups } }
        ]
      }).select('_id');
      groupUsers.forEach((u: any) => userIds.add(u._id.toString()));
    }

    if (userIds.size > 0) {
      await notificationService.broadcastNotification(Array.from(userIds), {
        type: 'exam',
        title: 'New Exam Assigned',
        body: `You have been assigned a new exam: ${exam.title}`,
        data: { examId: exam._id, type: 'exam' }
      });
    }
  } catch (err) {
    console.error('Error sending exam assignment notifications:', err);
  }

  return exam;
};

// Blueprint CRUD
export const createBlueprint = async (payload: Partial<IBlueprint> & { owner: Types.ObjectId }) => {
  return Blueprint.create(payload as IBlueprint);
};
export const listBlueprints = async (owner: Types.ObjectId) => {
  return Blueprint.find({ $or: [{ owner }, { shared: true }] }).sort({ createdAt: -1 });
};
export const updateBlueprint = async (id: string, owner: Types.ObjectId, payload: Partial<IBlueprint>) => {
  return Blueprint.findOneAndUpdate({ _id: id, owner }, payload, { new: true });
};
export const deleteBlueprint = async (id: string, owner: Types.ObjectId) => {
  await Blueprint.findOneAndDelete({ _id: id, owner });
};

// Create exam (and optionally questions) from generated paper result
export const createExamFromPaper = async (paper: GeneratedPaperResult, createdBy: Types.ObjectId, opts: {
  classLevel?: string;
  batch?: string;
  schedule?: { startAt?: string | Date; endAt?: string | Date };
  autoPublish?: boolean;
  blueprintId?: string;
}): Promise<IExam> => {
  // First persist all questions (flatten sections)
  const questionDocs: IQuestion[] = [];
  for (const section of paper.sections) {
    for (const q of section.questions) {
      const doc = await Question.create({
        text: q.text,
        type: q.type as any,
        options: q.options,
        correctAnswerText: q.correctAnswerText,
        integerAnswer: (q as any).integerAnswer,
        assertion: (q as any).assertion,
        reason: (q as any).reason,
        assertionIsTrue: (q as any).assertionIsTrue,
        reasonIsTrue: (q as any).reasonIsTrue,
        reasonExplainsAssertion: (q as any).reasonExplainsAssertion,
        diagramUrl: (q as any).diagramUrl,
        diagramAlt: (q as any).diagramAlt,
        explanation: q.explanation,
        tags: {
          subject: paper.subject,
          difficulty: (q as any).tags?.difficulty || 'medium',
        },
        createdBy,
      } as any);
      questionDocs.push(doc);
    }
  }

  // Map questions into exam sections preserving order
  let cursor = 0;
  const sections = paper.sections.map((s) => {
    const count = s.questions.length;
    const slice = questionDocs.slice(cursor, cursor + count).map((qd) => qd._id as Types.ObjectId);
    cursor += count;
    return {
      title: s.title,
      questionIds: slice,
      shuffleQuestions: false,
      shuffleOptions: false,
    };
  });

  const exam = await Exam.create({
    title: paper.examTitle,
    description: `Generated exam from AI paper for subject ${paper.subject || ''}`.trim(),
    createdBy,
    sections,
    isPublished: !!opts.autoPublish,
    classLevel: opts.classLevel,
    batch: opts.batch,
    autoPublish: opts.autoPublish,
    schedule: opts.schedule ? { startAt: opts.schedule.startAt, endAt: opts.schedule.endAt } : undefined,
    blueprintId: opts.blueprintId ? new Types.ObjectId(opts.blueprintId) : undefined,
    meta: { generated: true },
  } as any);
  return exam;
};
