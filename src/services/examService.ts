import { Types } from 'mongoose';
import Exam, { IExam } from '../models/Exam';
import Question, { IQuestion } from '../models/Question';
import Blueprint, { IBlueprint } from '../models/Blueprint';
import type { GeneratedPaperResult } from './aiService';

export const createQuestion = async (payload: Partial<IQuestion> & { createdBy: Types.ObjectId }): Promise<IQuestion> => {
  const q = await Question.create(payload as IQuestion);
  return q;
};

export const listQuestions = async (filter: any = {}, limit = 50, skip = 0) => {
  const [items, total] = await Promise.all([
    Question.find(filter).limit(limit).skip(skip).sort({ createdAt: -1 }),
    Question.countDocuments(filter),
  ]);
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
