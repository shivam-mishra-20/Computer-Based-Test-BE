import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * A public assessment: test, quiz, mock test or a paper inside a test series.
 *
 * ── Why this is NOT the existing Exam model ──────────────────────────────────
 * `Exam` is institute machinery. It carries `classLevel` + `batch` +
 * `assignedTo.{users,groups}`, and those fields are read by
 * examAudienceService, notificationService, room allocation and the teacher
 * dashboards. Adding a "public" flag to Exam would put public content one
 * forgotten filter away from every institute audience query — the exact failure
 * mode the accountType architecture exists to prevent.
 *
 * A separate collection means no Exam query can ever return a public test and
 * no public query can ever return an institute exam. That separation is
 * structural rather than filter-dependent.
 *
 * ── What IS reused ───────────────────────────────────────────────────────────
 * `Question`. Sections hold `questionIds` exactly as Exam does, so the existing
 * bank, the import pipeline and `gradeObjective()` all work unchanged. The
 * question documents themselves are shared and read-only from the public side.
 *
 * SECURITY NOTE: Question stores its answer key inline (`options[].isCorrect`,
 * `correctAnswerText`, `integerAnswer`, `explanation`). Anything serving a
 * question to a learner MUST go through `sanitizeQuestionForAttempt()` in
 * utils/publicAssessment.ts. Never hand a raw Question to the public API.
 */

export type PublicTestKind = 'TEST' | 'QUIZ' | 'MOCK' | 'SERIES_PAPER';
export type PublicTestStatus = 'draft' | 'published' | 'archived';
export type PublicTestDifficulty = 'easy' | 'medium' | 'hard' | 'mixed';

export interface IPublicTestSection {
  _id: Types.ObjectId;
  title: string;
  questionIds: Types.ObjectId[];
  /** Optional per-section timer. Unset = governed by the overall duration. */
  durationMins?: number;
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
}

export interface IPublicMarkingScheme {
  correct: number;
  /** Negative marking. Stored as a negative number, e.g. -1. */
  incorrect: number;
  unattempted: number;
}

export interface IPublicTest extends Document {
  title: string;
  description?: string;
  kind: PublicTestKind;

  sections: IPublicTestSection[];
  markingScheme: IPublicMarkingScheme;
  durationMins: number;

  // ── Discovery dimensions. Every one is a real filter on the public list. ──
  /** Boards this paper suits. Empty = board-agnostic and shown to everyone. */
  board: string[];
  /** Digits-only, e.g. "10" — matches learnerProfile.classLevel, never the
   *  institute root classLevel. */
  classLevel?: string;
  subject?: string;
  /** Target exam, e.g. "JEE Main", "NEET". Free text so it is not locked to
   *  the institute's TargetExam enum. */
  exam?: string;
  examType?: string;
  difficulty: PublicTestDifficulty;

  /** Series membership. Set only for kind === 'SERIES_PAPER'. */
  seriesId?: Types.ObjectId;
  /** Position within its series. */
  orderInSeries?: number;

  status: PublicTestStatus;
  /**
   * Optional availability window. A published test outside its window is
   * discoverable but not startable — the same distinction the institute
   * scheduler makes, implemented independently.
   */
  schedule?: { startAt?: Date; endAt?: Date };

  instructions?: string;
  /**
   * WHICH question collection `sections[].questionIds` belong to.
   *
   * Questions are stored per class (`class_11`, `class_12`, …), not in one
   * global bank — see utils/questionSource.ts. This records the bank at the
   * moment the ids were chosen, so every later read resolves them from the same
   * place.
   *
   * Deliberately separate from `classLevel`: that is a discovery tag an author
   * may edit or clear, and deriving the bank from it would silently repoint a
   * paper at a collection its ids do not exist in. Empty = the shared
   * `Question` collection.
   */
  questionBank?: string;

  /** Denormalised so list queries never have to count section arrays. */
  questionCount: number;
  totalMarks: number;

  createdBy: Types.ObjectId;
  /** Set when this test was produced by duplicating another. Never used for
   *  reads — purely provenance, so a copy is fully independent. */
  duplicatedFrom?: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const sectionSchema = new Schema<IPublicTestSection>(
  {
    title: { type: String, required: true },
    questionIds: [{ type: Schema.Types.ObjectId, ref: 'Question' }],
    durationMins: { type: Number },
    shuffleQuestions: { type: Boolean, default: false },
    shuffleOptions: { type: Boolean, default: false },
  },
  { _id: true },
);

const publicTestSchema = new Schema<IPublicTest>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String },
    kind: {
      type: String,
      enum: ['TEST', 'QUIZ', 'MOCK', 'SERIES_PAPER'],
      default: 'TEST',
      index: true,
    },

    sections: { type: [sectionSchema], default: [] },
    markingScheme: {
      correct: { type: Number, default: 1 },
      incorrect: { type: Number, default: 0 },
      unattempted: { type: Number, default: 0 },
    },
    durationMins: { type: Number, required: true, default: 30 },

    board: [{ type: String }],
    classLevel: { type: String, index: true },
    subject: { type: String, index: true },
    exam: { type: String, index: true },
    examType: { type: String },
    difficulty: {
      type: String,
      enum: ['easy', 'medium', 'hard', 'mixed'],
      default: 'mixed',
      index: true,
    },

    seriesId: {
      type: Schema.Types.ObjectId,
      ref: 'PublicTestSeries',
      index: true,
    },
    orderInSeries: { type: Number },

    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft',
      index: true,
    },
    schedule: {
      startAt: { type: Date },
      endAt: { type: Date },
    },

    instructions: { type: String },
    /** The per-class collection these question ids live in. See the interface. */
    questionBank: { type: String },
    questionCount: { type: Number, default: 0 },
    totalMarks: { type: Number, default: 0 },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    duplicatedFrom: { type: Schema.Types.ObjectId, ref: 'PublicTest' },
  },
  { timestamps: true },
);

/**
 * Keep the denormalised counters truthful on every write, so the discovery list
 * never has to load section arrays just to show "30 questions · 120 marks".
 */
publicTestSchema.pre('save', function (next) {
  const test = this as unknown as IPublicTest;
  const ids = (test.sections || []).flatMap((s) => s.questionIds || []);
  test.questionCount = ids.length;
  test.totalMarks = ids.length * (test.markingScheme?.correct ?? 1);
  next();
});

// The discovery query: published tests narrowed by any combination of filters.
publicTestSchema.index({ status: 1, kind: 1, classLevel: 1, subject: 1 });
publicTestSchema.index({ status: 1, exam: 1, difficulty: 1 });
publicTestSchema.index({ status: 1, createdAt: -1 });
publicTestSchema.index({ seriesId: 1, orderInSeries: 1 });
// Free-text search over title/description.
publicTestSchema.index({ title: 'text', description: 'text' });

export default mongoose.model<IPublicTest>('PublicTest', publicTestSchema);
