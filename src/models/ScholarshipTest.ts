import mongoose from 'mongoose';

const scholarshipTestSchema = new mongoose.Schema(
  {
    testName: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      default: '',
    },
    eligibleClasses: {
      type: [Number],
      required: true,
      enum: [7, 8, 9, 10, 11, 12],
    },
    subjects: {
      type: [String],
      required: true,
      enum: ['Math', 'Science', 'English', 'History'],
    },
    durationMins: {
      type: Number,
      required: true,
      default: 60,
    },
    questionsPerSubject: {
      type: Number,
      required: true,
      default: 15,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: String,
      default: 'admin',
    },
    shareLink: {
      type: String,
      unique: true,
      sparse: true,
    },
    totalAttempts: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

export interface IScholarshipTest extends mongoose.Document {
  testName: string;
  description?: string;
  eligibleClasses: number[];
  subjects: string[];
  durationMins: number;
  questionsPerSubject: number;
  isActive: boolean;
  createdBy: string;
  shareLink?: string;
  totalAttempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export default mongoose.model<IScholarshipTest>('ScholarshipTest', scholarshipTestSchema);
