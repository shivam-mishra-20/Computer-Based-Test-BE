import { Types } from 'mongoose';
import Exam, { IExam } from '../models/Exam';
import Question, { IQuestion } from '../models/Question';
import Attempt from '../models/Attempt';
import ExamEvaluation from '../models/ExamEvaluation';
import ReviewAuditLog from '../models/ReviewAuditLog';
import Blueprint, { IBlueprint } from '../models/Blueprint';
import { ImportedQuestion } from '../models/ImportedQuestion';
import { getClassQuestionModel } from '../models/ClassQuestion';
import type { GeneratedPaperResult } from './aiService';
import * as notificationService from './notificationService';
import mongoose from 'mongoose';
import { deriveExamStatus } from '../utils/examTiming';
import { resolveExamNotificationRecipients } from './examAudienceService';

// Attaches the server-derived `status` (draft/scheduled/live/completed) to an
// exam document before it goes out over the API — additive field, not part of
// the schema, so every response carries one authoritative status without web/
// mobile/admin each re-deriving it from isPublished+schedule independently.
function withStatus(examDoc: IExam | null): (IExam & { status: ReturnType<typeof deriveExamStatus> }) | null {
  if (!examDoc) return null;
  const obj = typeof (examDoc as any).toObject === 'function' ? (examDoc as any).toObject() : examDoc;
  return { ...obj, status: deriveExamStatus(examDoc) };
}

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

// Ensure a marking scheme coming from any client persists as numbers (so the
// scheme set during exam creation reliably reaches the DB and the review).
function normalizeMarkingScheme<T extends { markingScheme?: any }>(payload: T): T {
  const m = payload?.markingScheme;
  if (m && typeof m === 'object') {
    payload.markingScheme = {
      correct: Number(m.correct) || 0,
      incorrect: Number(m.incorrect) || 0,
      unattempted: Number(m.unattempted) || 0,
    };
  }
  return payload;
}

// A teacher can no longer flip isPublished:true without an exam schedule —
// students' waiting room / start-window enforcement depends on schedule.startAt
// and schedule.endAt actually being set. `existing` supplies fallback values
// when a PUT updates isPublished without re-sending an already-saved schedule.
function assertPublishReady(payload: Partial<IExam>, existing?: IExam | null) {
  const startAt = payload.schedule?.startAt ?? existing?.schedule?.startAt;
  const endAt = payload.schedule?.endAt ?? existing?.schedule?.endAt;
  if (!startAt || !endAt) {
    throw new Error('Publishing requires an exam schedule (start and end date/time).');
  }
  if (new Date(startAt) >= new Date(endAt)) {
    throw new Error('Exam schedule start time must be before the end time.');
  }
}

export const createExam = async (payload: Partial<IExam>) => {
  if (payload.isPublished) assertPublishReady(payload);
  const exam = await Exam.create(normalizeMarkingScheme({ ...payload }) as IExam);
  return withStatus(exam);
};

export const updateExam = async (id: string, payload: Partial<IExam>) => {
  let existing: IExam | null = null;
  if (payload.isPublished) {
    existing = await Exam.findById(id);
    assertPublishReady(payload, existing);
  }
  const updated = await Exam.findByIdAndUpdate(id, normalizeMarkingScheme({ ...payload }), { new: true });
  return withStatus(updated);
};

export const getExam = async (id: string) => withStatus(await Exam.findById(id));
export const listExams = async (filter: any = {}, limit = 50, skip = 0) => {
  const [items, total] = await Promise.all([
    Exam.find(filter).limit(limit).skip(skip).sort({ createdAt: -1 }),
    Exam.countDocuments(filter),
  ]);
  return { items: items.map(withStatus), total };
};

export const deleteExam = async (id: string) => {
  const examObjectId = new Types.ObjectId(id);

  // Cascade delete everything tied to this exam. Without this, deleting an exam
  // leaves orphaned attempts that surface as "Exam Not Found" in a student's
  // results/analytics. Removing attempts + their evaluations + review logs keeps
  // student performance data consistent with the exams that still exist.
  await Promise.all([
    Attempt.deleteMany({ examId: examObjectId }),
    ExamEvaluation.deleteMany({ examId: examObjectId }),
    ReviewAuditLog.deleteMany({ examId: examObjectId }),
  ]);

  return Exam.findByIdAndDelete(id);
};

export const assignExam = async (id: string, users?: string[], groups?: string[]) => {
  const exam = await Exam.findById(id);
  if (!exam) return null;
  // Non-destructive: a caller that only sends `groups` (e.g. the
  // Schedule & Publish flow, which is class/batch-only) must not silently
  // wipe out an existing individual-student assignment set by a different
  // caller (e.g. the mobile build wizard's per-student picker), and vice
  // versa. Omitting a key means "leave it as-is"; sending an empty array
  // means "clear it" — both are distinguishable from `undefined` here.
  exam.assignedTo = {
    users: users !== undefined ? users.map((u) => new Types.ObjectId(u)) : exam.assignedTo?.users,
    groups: groups !== undefined ? groups : exam.assignedTo?.groups,
  };
  // Notifications must never run ahead of a successful write — if save()
  // throws, we exit here and nobody is told about an exam they cannot open.
  await exam.save();

  // Trigger Notifications
  try {
    // Resolved from the SAVED exam, not from the request payload: assignment is
    // a non-destructive merge, and some clients express the audience purely
    // through classLevel+batch while sending an empty `groups`. The saved
    // document is the only complete picture of who the exam now targets.
    const userIds = await resolveExamNotificationRecipients(exam);

    if (userIds.length > 0) {
      await notificationService.broadcastNotification(userIds, {
        type: 'exam',
        title: 'New Exam Assigned',
        body: `You have been assigned a new exam: ${exam.title}`,
        data: { examId: exam._id, type: 'exam' }
      });
    }
  } catch (err) {
    console.error('Error sending exam assignment notifications:', err);
  }

  return withStatus(exam);
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
}) => {
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
      shuffleQuestions: true,
      shuffleOptions: false,
    };
  });

  // autoPublish is only honoured when a valid schedule came with it — same
  // requirement as every other publish path (assertPublishReady). Previously
  // this bypassed that check entirely via a raw Exam.create, so an AI-generated
  // exam could end up "published" with no schedule (unrestricted, immediate,
  // indefinite access). Without a schedule it's created as a draft instead of
  // throwing, since this flow has no inline UI to fix a validation error.
  const hasValidSchedule = !!(
    opts.schedule?.startAt &&
    opts.schedule?.endAt &&
    new Date(opts.schedule.startAt) < new Date(opts.schedule.endAt)
  );
  const isPublished = !!opts.autoPublish && hasValidSchedule;

  const exam = await Exam.create({
    title: paper.examTitle,
    description: `Generated exam from AI paper for subject ${paper.subject || ''}`.trim(),
    createdBy,
    sections,
    isPublished,
    classLevel: opts.classLevel,
    batch: opts.batch,
    autoPublish: opts.autoPublish,
    schedule: opts.schedule ? { startAt: opts.schedule.startAt, endAt: opts.schedule.endAt } : undefined,
    blueprintId: opts.blueprintId ? new Types.ObjectId(opts.blueprintId) : undefined,
    meta: { generated: true },
  } as any);
  return withStatus(exam);
};
