import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IExamSection {
  _id: Types.ObjectId;
  title: string;
  questionIds: Types.ObjectId[]; // references to Question
  sectionDurationMins?: number; // optional per-section timer
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
}

export interface IMarkingScheme {
  correct: number;
  incorrect: number;
  unattempted: number;
}

export interface IExam extends Document {
  title: string;
  description?: string;
  createdBy: Types.ObjectId; // teacher/admin
  sections: IExamSection[];
  totalDurationMins?: number; // overall exam timer
  // Marks awarded per question (e.g. +4 / -1 / 0). Set at build time and used
  // as the grading default; the review module can still override per-test.
  markingScheme?: IMarkingScheme;
  mode?: 'practice' | 'live' | 'adaptive';
  schedule?: {
    startAt?: Date;
    endAt?: Date;
    // Display-only IANA zone (dates are always stored/compared as absolute UTC).
    timezone?: string;
  };
  // Shown to students on the pre-exam waiting screen.
  instructions?: string;
  // Minutes after schedule.startAt during which a student may still start the
  // exam. Unset = students may start any time up to schedule.endAt (today's
  // behavior). Does not extend schedule.endAt itself.
  lateEntryMins?: number;
  // % of totalDurationMins that must elapse before a student may voluntarily
  // submit. Does not gate auto-submit (time-up / anti-cheat / forced).
  submitLockPercent?: number;
  classLevel?: string; // e.g., 'Class 10', 'NEET Batch'
  batch?: string; // batch/group label
  autoPublish?: boolean; // if true exam auto publishes at start
  // Enable proctoring (heartbeat + tab-switch/background logging + auto-submit on
  // repeated violations) for this exam. Off for relaxed practice tests.
  antiCheat?: boolean;
  isPublished: boolean; // visible/assigned to students
  assignedTo?: {
    users?: Types.ObjectId[];
    groups?: string[]; // simple batch/group names
  };
  meta?: Record<string, any>;
  blueprintId?: Types.ObjectId; // reference to saved blueprint if created from one
}

const examSectionSchema = new Schema<IExamSection>(
  {
    title: { type: String, required: true },
    questionIds: [{ type: Schema.Types.ObjectId, ref: 'Question', required: true }],
    sectionDurationMins: { type: Number },
    // Question order is shuffled per student by default (each attempt gets a
    // unique sequence). Teachers can opt out per section via the build UI.
    shuffleQuestions: { type: Boolean, default: true },
    shuffleOptions: { type: Boolean, default: false },
  },
  { _id: true }
);

const examSchema = new Schema<IExam>(
  {
    title: { type: String, required: true },
    description: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sections: { type: [examSectionSchema], required: true },
    totalDurationMins: { type: Number },
    markingScheme: {
      correct: { type: Number, default: 1 },
      incorrect: { type: Number, default: 0 },
      unattempted: { type: Number, default: 0 },
    },
    mode: { type: String, enum: ['practice', 'live', 'adaptive'], default: 'live', index: true },
    schedule: {
      startAt: { type: Date },
      endAt: { type: Date },
      timezone: { type: String, default: 'Asia/Kolkata' },
    },
    instructions: { type: String },
    lateEntryMins: { type: Number },
    submitLockPercent: { type: Number, default: 50 },
    classLevel: { type: String, index: true },
    batch: { type: String, index: true },
    autoPublish: { type: Boolean, default: false },
    antiCheat: { type: Boolean, default: false },
    isPublished: { type: Boolean, default: false, index: true },
    assignedTo: {
      users: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      groups: [{ type: String }],
    },
    meta: { type: Schema.Types.Mixed },
    blueprintId: { type: Schema.Types.ObjectId, ref: 'Blueprint' },
  },
  { timestamps: true }
);

export default mongoose.model<IExam>('Exam', examSchema);
