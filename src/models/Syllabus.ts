import mongoose, { Document, Schema } from 'mongoose';

export interface ISyllabusItem {
  _id?: string;
  topic: string;
  description?: string;
  order: number;
  completed: boolean;
  completedDate?: Date;
  estimatedHours?: number;
}

export interface ISyllabusTopic {
  _id?: string;
  name: string;
  completed: boolean;
  completedDate?: Date;
}

export interface ISyllabusChapter {
  _id?: string;
  name: string;
  order: number;
  topics: ISyllabusTopic[];
  /** Used only when the chapter has no topics (topics are optional). */
  completed?: boolean;
  completedDate?: Date;
}

export interface ISyllabus extends Document {
  teacherId: string;
  teacherName: string;
  subject: string;
  classLevel: string;
  batch?: string;
  academicYear: string;
  items?: ISyllabusItem[]; // Legacy support
  chapters: ISyllabusChapter[]; // New structure
  totalTopics: number;
  completedTopics: number;
  progressPercentage: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const syllabusItemSchema = new Schema({
  topic: { type: String, required: true },
  description: { type: String },
  order: { type: Number, required: true },
  completed: { type: Boolean, default: false },
  completedDate: { type: Date },
  estimatedHours: { type: Number, default: 0 }
}, { _id: true });

const syllabusTopicSchema = new Schema({
  name: { type: String, required: true },
  completed: { type: Boolean, default: false },
  completedDate: { type: Date }
}, { _id: true });

const syllabusChapterSchema = new Schema({
  name: { type: String, required: true },
  order: { type: Number, required: true },
  topics: [syllabusTopicSchema],
  // Topics are optional. A chapter without topics is tracked as one item and
  // marked complete on its own; with topics, its topics are what count.
  completed: { type: Boolean, default: false },
  completedDate: { type: Date }
}, { _id: true });

const syllabusSchema = new Schema<ISyllabus>({
  teacherId: { type: String, required: true, index: true },
  teacherName: { type: String, required: true },
  subject: { type: String, required: true, index: true },
  classLevel: { type: String, required: true, index: true },
  batch: { type: String, index: true },
  academicYear: { type: String, required: true, index: true },
  items: [syllabusItemSchema], // Legacy support
  chapters: [syllabusChapterSchema], // New structure
  totalTopics: { type: Number, default: 0 },
  completedTopics: { type: Number, default: 0 },
  progressPercentage: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true, index: true }
}, { timestamps: true });

// Update counters before save
syllabusSchema.pre('save', function(next) {
  // Calculate from new chapters structure if available
  if (this.chapters && this.chapters.length > 0) {
    // Each topic is one item; a chapter with no topics is one item itself.
    let total = 0;
    let done = 0;
    for (const chapter of this.chapters) {
      const topics = chapter.topics || [];
      if (topics.length > 0) {
        total += topics.length;
        done += topics.filter(topic => topic.completed).length;
      } else {
        total += 1;
        if (chapter.completed) done += 1;
      }
    }
    this.totalTopics = total;
    this.completedTopics = done;
  } else if (this.items && this.items.length > 0) {
    // Fallback to legacy items structure
    this.totalTopics = this.items.length;
    this.completedTopics = this.items.filter(item => item.completed).length;
  } else {
    this.totalTopics = 0;
    this.completedTopics = 0;
  }
  
  this.progressPercentage = this.totalTopics > 0 
    ? Math.round((this.completedTopics / this.totalTopics) * 100) 
    : 0;
  next();
});

// Compound indexes for efficient queries
syllabusSchema.index({ classLevel: 1, subject: 1, academicYear: 1 });
syllabusSchema.index({ teacherId: 1, isActive: 1 });

export default mongoose.model<ISyllabus>('Syllabus', syllabusSchema);
