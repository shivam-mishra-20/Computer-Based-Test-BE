import mongoose, { Document, Schema } from 'mongoose';

export interface IStudentResult {
  studentId: string;
  studentName: string;
  marksObtained: number;
  percentage: number;
  grade: string;
  remarks?: string;
}

export interface ITestResult extends Document {
  testName: string;
  testDate: string; // yyyy-mm-dd format
  class: string;
  batch?: string;
  subject: string;
  maxMarks: number;
  studentResults: IStudentResult[];
  createdBy: string; // Teacher who created the test
  createdAt: Date;
  updatedAt: Date;
}

const studentResultSchema = new Schema<IStudentResult>({
  studentId: {
    type: String,
    required: true,
    index: true,
  },
  studentName: {
    type: String,
    required: true,
  },
  marksObtained: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
  },
  percentage: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
    max: 100,
  },
  grade: {
    type: String,
    required: true,
    default: 'F',
    enum: ['A+', 'A', 'B+', 'B', 'C', 'D', 'F'],
  },
  remarks: {
    type: String,
    trim: true,
  },
}, { _id: false });

const testResultSchema = new Schema<ITestResult>(
  {
    testName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    testDate: {
      type: String,
      required: true,
      index: true,
      match: /^\d{4}-\d{2}-\d{2}$/, // Validate yyyy-mm-dd format
    },
    class: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    batch: {
      type: String,
      index: true,
      trim: true,
    },
    subject: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    maxMarks: {
      type: Number,
      required: true,
      min: 1,
    },
    studentResults: {
      type: [studentResultSchema],
      default: [],
    },
    createdBy: {
      type: String,
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for efficient queries
testResultSchema.index({ class: 1, batch: 1, testDate: -1 });
testResultSchema.index({ class: 1, subject: 1 });
testResultSchema.index({ createdBy: 1, createdAt: -1 });

// Virtual for average performance
testResultSchema.virtual('classAverage').get(function() {
  if (this.studentResults.length === 0) return 0;
  const total = this.studentResults.reduce((sum, r) => sum + r.marksObtained, 0);
  return total / this.studentResults.length;
});

// Virtual for pass percentage
testResultSchema.virtual('passPercentage').get(function() {
  if (this.studentResults.length === 0) return 0;
  const passedCount = this.studentResults.filter(r => r.percentage >= 40).length;
  return (passedCount / this.studentResults.length) * 100;
});

// Ensure virtuals are included in JSON
testResultSchema.set('toJSON', { virtuals: true });
testResultSchema.set('toObject', { virtuals: true });

const TestResult = mongoose.model<ITestResult>('TestResult', testResultSchema);

export default TestResult;
