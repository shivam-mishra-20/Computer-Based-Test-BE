import { requireTenantScope, tenantScope } from '../core/tenancy';
import { Types } from 'mongoose';
import Exam, { IExam } from '../models/Exam';
import Question, { IQuestion } from '../models/Question';
import Attempt from '../models/Attempt';
import ExamEvaluation from '../models/ExamEvaluation';
import ReviewAuditLog from '../models/ReviewAuditLog';
import Blueprint, { IBlueprint } from '../models/Blueprint';
import { ImportedQuestion } from '../models/ImportedQuestion';
import { getClassQuestionModel } from '../models/ClassQuestion';
import { findExamQuestions } from '../utils/questionSource';
import type { GeneratedPaperResult } from './aiService';
import * as notificationService from './notificationService';
import mongoose from 'mongoose';
import { deriveExamStatus } from '../utils/examTiming';
import { resolveExamNotificationRecipients } from './examAudienceService';
import { ANSWER_KEY_FIELDS, AnswerKeyError, findAnswerKeyIssues, type AnswerKeyFields } from './questionAnswerKey';

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
  const issues = findAnswerKeyIssues([payload as AnswerKeyFields], () => 'This question');
  if (issues.length > 0) throw new AnswerKeyError(issues, 'Not saved');
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

/**
 * The general `Question` collection itself (POST /exams/questions writes
 * here). Exams built for a class read the class banks instead, so these are
 * listed separately — to be edited, or copied into a class bank.
 */
export const listGeneralBankQuestions = async (
  opts: { text?: string; subject?: string; topic?: string; difficulty?: string },
  limit = 50,
  skip = 0,
) => {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const filter: Record<string, unknown> = { ...requireTenantScope('questions') };
  if (opts.text) filter.text = { $regex: escape(opts.text), $options: 'i' };
  if (opts.subject) filter['tags.subject'] = opts.subject;
  if (opts.topic) filter['tags.topic'] = opts.topic;
  if (opts.difficulty) filter['tags.difficulty'] = opts.difficulty;
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const [items, total] = await Promise.all([
    Question.find(filter).sort({ createdAt: -1 }).skip(Math.max(Number(skip) || 0, 0)).limit(safeLimit).lean(),
    Question.countDocuments(filter),
  ]);
  return { items, total };
};

export const updateQuestion = async (id: string, payload: Partial<IQuestion>) => {
  // Re-check the key only when this update can change it, so editing the text
  // or tags of an older question saved without a key still works.
  const body = payload as Record<string, unknown>;
  if (['type', 'options', 'correctAnswerText', 'assertionIsTrue', 'reasonIsTrue'].some((f) => body?.[f] !== undefined)) {
    const existing = await Question.findOne({ _id: id, ...requireTenantScope('questions') })
      .select(`${ANSWER_KEY_FIELDS} text`)
      .lean();
    if (!existing) return null;
    const merged = { ...existing, ...pickDefined(body, ['type', 'options', 'correctAnswerText', 'assertionIsTrue', 'reasonIsTrue']) };
    const issues = findAnswerKeyIssues([merged as AnswerKeyFields], () => 'This question');
    if (issues.length > 0) throw new AnswerKeyError(issues, 'Not saved');
  }
  const q = await Question.findOneAndUpdate({ _id: id, ...requireTenantScope('questions') }, payload, { new: true });
  return q;
};

/** Every question id an exam's sections reference, in order, as one comparable string. */
function questionIdList(sections: Array<{ questionIds?: unknown[] }> | undefined): string {
  return (sections || []).map((s) => (s.questionIds || []).map(String).join(',')).join('|');
}

function pickDefined(source: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (source[f] !== undefined) out[f] = source[f];
  return out;
}

/**
 * Publishing gate: every question an exam would grade from its options must
 * have a correct option. Looks questions up exactly as the grader does
 * (findExamQuestions: the class bank, then the general bank), so it checks
 * the copies students will actually be marked against.
 */
async function assertAnswerKeysReady(
  sections: Array<{ title?: string; questionIds?: unknown[] }> | undefined,
  classLevel: string | undefined,
  action: string,
) {
  const ordered = (sections || []).flatMap((section, sIdx) =>
    (section.questionIds || []).map((qid, qIdx) => ({
      id: String(qid),
      label: `${section.title || `Section ${sIdx + 1}`} Q${qIdx + 1}`,
    })),
  );
  const ids = ordered.map((o) => o.id).filter((id) => Types.ObjectId.isValid(id));
  if (ids.length === 0) return;
  // Wherever the grader will find them: the class bank, then the general
  // bank (an exam created from a paper keeps its questions there).
  const docs = await findExamQuestions(classLevel, ids, { select: `${ANSWER_KEY_FIELDS} text`, lean: true });
  const byId = new Map<string, AnswerKeyFields>((docs as any[]).map((d) => [String(d._id), d] as [string, AnswerKeyFields]));
  // A question the exam cannot load is one no student will ever see — and the
  // grader skips it. That happened when an exam's class was changed after its
  // questions were picked from another class's bank, or a question was deleted.
  const missing = ordered.filter((o) => !byId.has(o.id));
  if (missing.length > 0) {
    const where = classLevel ? `the Class ${classLevel} question bank` : 'the question bank';
    const list = missing.slice(0, 5).map((o) => o.label).join(', ');
    throw new Error(
      `${action}: ${missing.length} question(s) (${list}${missing.length > 5 ? ', …' : ''}) are not in ${where}. ` +
        'Remove them, or set the exam to the class they were picked from.',
    );
  }
  const present = ordered;
  const labels = new Map(present.map((o, i) => [i, o.label]));
  const issues = findAnswerKeyIssues(
    present.map((o) => byId.get(o.id)),
    (_q, i) => labels.get(i) || `Q${i + 1}`,
  );
  if (issues.length > 0) throw new AnswerKeyError(issues, action);
}

/** The deleted question, or null when this organization has none by that id. */
export const deleteQuestion = async (id: string) =>
  Question.findOneAndDelete({ _id: id, ...requireTenantScope('questions') });

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
  if (payload.isPublished) {
    assertPublishReady(payload);
    await assertAnswerKeysReady(payload.sections as any, payload.classLevel, 'Cannot publish');
  }
  const exam = await Exam.create(normalizeMarkingScheme({ ...payload }) as IExam);
  return withStatus(exam);
};

export const updateExam = async (id: string, payload: Partial<IExam>) => {
  let existing: IExam | null = null;
  if (payload.isPublished) {
    existing = await Exam.findOne({ _id: id, ...requireTenantScope('exams') });
    assertPublishReady(payload, existing);
  }
  // Answer keys are checked when this update PUBLISHES the exam, or changes
  // which questions (or which bank) a published exam grades — so a keyless
  // question can't be swapped into a live exam either. Republishing a live
  // exam with the same questions (the panel re-sends classLevel and sections
  // to extend a schedule) is not re-checked, so an urgent time change on an
  // exam published before this rule existed is never blocked.
  if (payload.isPublished || payload.sections !== undefined || payload.classLevel !== undefined) {
    existing = existing ?? (await Exam.findOne({ _id: id, ...requireTenantScope('exams') }));
    if (existing) {
      const wasPublished = !!existing.isPublished;
      const willBePublished = payload.isPublished !== undefined ? !!payload.isPublished : wasPublished;
      const nextSections = (payload.sections ?? existing.sections) as any;
      const nextClass = payload.classLevel !== undefined ? payload.classLevel : existing.classLevel;
      const questionSetChanged =
        String(nextClass || '') !== String(existing.classLevel || '') ||
        questionIdList(nextSections) !== questionIdList(existing.sections as any);
      if (willBePublished && (!wasPublished || questionSetChanged)) {
        await assertAnswerKeysReady(nextSections, nextClass, wasPublished ? 'Not saved' : 'Cannot publish');
      }
    }
  }
  const updated = await Exam.findOneAndUpdate({ _id: id, ...requireTenantScope('exams') }, normalizeMarkingScheme({ ...payload }), { new: true });
  return withStatus(updated);
};

export const getExam = async (id: string) => withStatus(await Exam.findOne({ _id: id, ...requireTenantScope('exams') }));
export const listExams = async (filter: any = {}, limit = 50, skip = 0) => {
  const scoped = { ...filter, ...requireTenantScope('exams') };
  const [items, total] = await Promise.all([
    Exam.find(scoped).limit(limit).skip(skip).sort({ createdAt: -1 }),
    Exam.countDocuments(scoped),
  ]);
  return { items: items.map(withStatus), total };
};

/** The deleted exam, or null when this organization has none by that id. */
export const deleteExam = async (id: string) => {
  // This organization's exam, or nothing is touched. The cascade below matches
  // by exam id alone, so it must never run for an id that is not ours.
  if (!Types.ObjectId.isValid(id)) return null;
  const scope = requireTenantScope('exams');
  const exam = await Exam.findOne({ _id: id, ...scope }).select('_id').lean();
  if (!exam) return null;
  const examObjectId = new Types.ObjectId(id);

  // Cascade delete everything tied to this exam. Without this, deleting an exam
  // leaves orphaned attempts that surface as "Exam Not Found" in a student's
  // results/analytics. Removing attempts + their evaluations + review logs keeps
  // student performance data consistent with the exams that still exist.
  await Promise.all([
    Attempt.deleteMany({ examId: examObjectId, ...scope }),
    ExamEvaluation.deleteMany({ examId: examObjectId, ...scope }),
    ReviewAuditLog.deleteMany({ examId: examObjectId, ...scope }),
  ]);

  return Exam.findOneAndDelete({ _id: id, ...scope });
};

export const assignExam = async (id: string, users?: string[], groups?: string[]) => {
  const exam = await Exam.findOne({ _id: id, ...requireTenantScope('exams') });
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
// "Shared" means shared within this organization, never across them.
export const listBlueprints = async (owner: Types.ObjectId) => {
  return Blueprint.find({ $or: [{ owner }, { shared: true }], ...requireTenantScope('blueprints') }).sort({ createdAt: -1 });
};
export const updateBlueprint = async (id: string, owner: Types.ObjectId, payload: Partial<IBlueprint>) => {
  return Blueprint.findOneAndUpdate({ _id: id, owner, ...requireTenantScope('blueprints') }, payload, { new: true });
};
export const deleteBlueprint = async (id: string, owner: Types.ObjectId) => {
  await Blueprint.findOneAndDelete({ _id: id, owner, ...requireTenantScope('blueprints') });
};

// Create exam (and optionally questions) from generated paper result
/** "Class 11" / "class_11" / "11" → "11" — the form exams and the publish panel use. */
function normalizeClassLevel(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  return text.match(/\d+/)?.[0] ?? text;
}

/** The bank ids a paper's questions were picked from (papers built from the question bank keep them). */
function paperQuestionIds(paper: GeneratedPaperResult): string[] {
  return paper.sections
    .flatMap((s) => s.questions as Array<{ _id?: unknown }>)
    .map((q) => String(q?._id ?? ''))
    .filter((id) => Types.ObjectId.isValid(id));
}

/**
 * The class a paper's exam belongs to: the one asked for, the one saved on the
 * paper, or — for papers saved before they kept their class — the class bank
 * their questions were picked from.
 */
async function resolvePaperClass(paper: GeneratedPaperResult, requested?: string): Promise<string | undefined> {
  const declared = normalizeClassLevel(requested || (paper as any).classLevel || (paper as any).className);
  if (declared) return declared;
  const ids = paperQuestionIds(paper);
  const db = mongoose.connection.db;
  if (ids.length === 0 || !db) return undefined;
  const banks = (await db.listCollections({ name: { $regex: /^class_/ } }, { nameOnly: true }).toArray()).map((c) => c.name);
  let best: { classLevel: string; hits: number } | undefined;
  for (const bank of banks) {
    const classLevel = bank.replace(/^class_/, '');
    const hits = await getClassQuestionModel(classLevel).countDocuments({ _id: { $in: ids }, ...tenantScope() });
    if (hits > (best?.hits ?? 0)) best = { classLevel, hits };
  }
  return best?.classLevel;
}

const CLASS_BANK_TYPES = new Set(['mcq', 'truefalse', 'fill', 'short', 'long', 'assertionreason', 'integer']);
const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

/**
 * Create an exam from a saved question paper.
 *
 * ── Which bank the questions live in ────────────────────────────────────────
 * The class question bank — the one the exam builder, the Question Bank tab,
 * Smart Import and the AI generator all use. A paper built from that bank
 * carries each question's bank id, and the exam uses those same records (no
 * copies, so a correction in the bank reaches the exam). A question with no
 * bank record yet is added to the class bank. Only a paper with no class at
 * all still writes to the general bank, as every paper exam used to — and
 * those older exams keep working (findExamQuestions reads both banks).
 */
export const createExamFromPaper = async (paper: GeneratedPaperResult, createdBy: Types.ObjectId, opts: {
  classLevel?: string;
  batch?: string;
  schedule?: { startAt?: string | Date; endAt?: string | Date };
  autoPublish?: boolean;
  blueprintId?: string;
}) => {
  const classLevel = await resolvePaperClass(paper, opts.classLevel);
  const flat = paper.sections.flatMap((s) => s.questions as any[]);

  // Questions the paper took from a bank keep their bank record.
  const sourceIds = paperQuestionIds(paper);
  const existing = sourceIds.length > 0 ? await findExamQuestions(classLevel, sourceIds) : [];
  const existingById = new Map<string, any>(existing.map((d: any) => [String(d._id), d]));
  const reusedFor = (q: any) => existingById.get(String(q?._id ?? ''));

  // Every question must carry a usable answer key — checked on what will be
  // graded (the bank record for a reused question, the paper's copy for a new
  // one), before anything is written, so a refused paper leaves nothing behind.
  const paperIssues = findAnswerKeyIssues(
    flat.map((q) => (reusedFor(q) ?? q) as AnswerKeyFields),
    (() => {
      const labels = paper.sections.flatMap((s, sIdx) =>
        s.questions.map((_q, qIdx) => `${s.title || `Section ${sIdx + 1}`} Q${qIdx + 1}`),
      );
      return (_q: unknown, i: number) => labels[i] || `Q${i + 1}`;
    })(),
  );
  if (paperIssues.length > 0) throw new AnswerKeyError(paperIssues, 'No exam was created');

  const questionIds: Types.ObjectId[] = [];
  for (const q of flat) {
    const reused = reusedFor(q);
    if (reused) {
      questionIds.push(reused._id as Types.ObjectId);
      continue;
    }
    const content = {
      text: q.text,
      type: q.type,
      options: Array.isArray(q.options) ? q.options.map((o: any) => ({ text: o.text, isCorrect: !!o.isCorrect })) : undefined,
      correctAnswerText: q.correctAnswerText,
      integerAnswer: q.integerAnswer,
      assertion: q.assertion,
      reason: q.reason,
      assertionIsTrue: q.assertionIsTrue,
      reasonIsTrue: q.reasonIsTrue,
      reasonExplainsAssertion: q.reasonExplainsAssertion,
      diagramUrl: q.diagramUrl,
      diagramAlt: q.diagramAlt,
      explanation: q.explanation,
      createdBy,
    };
    const difficulty = DIFFICULTIES.has(q.tags?.difficulty || q.difficulty) ? q.tags?.difficulty || q.difficulty : 'medium';
    if (classLevel && CLASS_BANK_TYPES.has(String(q.type))) {
      const doc = await getClassQuestionModel(classLevel).create({
        ...content,
        subject: paper.subject || q.tags?.subject || q.subject || 'General',
        chapter: q.tags?.chapter || q.chapter,
        topic: q.tags?.topic || q.topic,
        difficulty,
      } as any);
      questionIds.push(doc._id as Types.ObjectId);
    } else {
      // No class, or a type the class bank does not hold: the general bank, as before.
      const doc = await Question.create({
        ...content,
        tags: { subject: paper.subject, difficulty },
      } as any);
      questionIds.push(doc._id as Types.ObjectId);
    }
  }

  // Map questions into exam sections preserving order
  let cursor = 0;
  const sections = paper.sections.map((s) => {
    const count = s.questions.length;
    const slice = questionIds.slice(cursor, cursor + count);
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
    classLevel,
    batch: opts.batch,
    autoPublish: opts.autoPublish,
    schedule: opts.schedule ? { startAt: opts.schedule.startAt, endAt: opts.schedule.endAt } : undefined,
    blueprintId: opts.blueprintId ? new Types.ObjectId(opts.blueprintId) : undefined,
    meta: { generated: true },
  } as any);
  return withStatus(exam);
};
