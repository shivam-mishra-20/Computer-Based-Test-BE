import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IExamSection {
  _id: Types.ObjectId;
  title: string;
  questionIds: Types.ObjectId[]; // references to Question
  sectionDurationMins?: number; // optional per-section timer
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
}

export interface IExam extends Document {
  title: string;
  description?: string;
  createdBy: Types.ObjectId; // teacher/admin
  sections: IExamSection[];
  totalDurationMins?: number; // overall exam timer
  schedule?: {
    startAt?: Date;
    endAt?: Date;
  };
  isPublished: boolean; // visible/assigned to students
  assignedTo?: {
    users?: Types.ObjectId[];
    groups?: string[]; // simple batch/group names
  };
  meta?: Record<string, any>;
}

const examSectionSchema = new Schema<IExamSection>(
  {
    title: { type: String, required: true },
    questionIds: [{ type: Schema.Types.ObjectId, ref: 'Question', required: true }],
    sectionDurationMins: { type: Number },
    shuffleQuestions: { type: Boolean, default: false },
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
    schedule: {
      startAt: { type: Date },
      endAt: { type: Date },
    },
    isPublished: { type: Boolean, default: false, index: true },
    assignedTo: {
      users: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      groups: [{ type: String }],
    },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

export default mongoose.model<IExam>('Exam', examSchema);
