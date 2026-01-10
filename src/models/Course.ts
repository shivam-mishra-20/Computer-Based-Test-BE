import mongoose, { Document, Schema } from 'mongoose';

export type CourseStatus = 'draft' | 'published' | 'archived';

export interface ICourse extends Document {
  title: string;
  description: string;
  subject: string;
  classLevel: string;
  batch?: string;
  instructor: mongoose.Types.ObjectId;
  thumbnail?: string;
  duration?: number; // in hours
  lectureCount?: number;
  status: CourseStatus;
  isFree: boolean;
  enrolledStudents: mongoose.Types.ObjectId[];
  syllabus?: {
    title: string;
    description?: string;
    lectures: {
      title: string;
      videoUrl?: string; // Kept for backward compatibility or other video types
      youtubeVideoId?: string; // New field for YouTube ID
      duration?: number; // in minutes
      order: number;
      youtubeMeta?: {
        durationSec: number;
        thumbnail: string;
        title: string;
        fetchedAt: Date;
      };
    }[];
  }[];
  createdAt: Date;
  updatedAt: Date;
}

const courseSchema = new Schema<ICourse>({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  subject: { type: String, required: true, index: true },
  classLevel: { type: String, required: true, index: true },
  batch: { type: String, index: true },
  instructor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  thumbnail: { type: String },
  duration: { type: Number },
  lectureCount: { type: Number, default: 0 },
  status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft', index: true },
  isFree: { type: Boolean, default: false },
  enrolledStudents: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  syllabus: [{
    title: { type: String, required: true },
    description: { type: String },
    lectures: [{
      title: { type: String, required: true },
      videoUrl: { type: String },
      youtubeVideoId: { type: String },
      duration: { type: Number },
      order: { type: Number, default: 0 },
      youtubeMeta: {
        durationSec: { type: Number },
        thumbnail: { type: String },
        title: { type: String },
        fetchedAt: { type: Date }
      }
    }]
  }]
}, { timestamps: true });

// Pre-save hook to ensure youtubeVideoId is populated if videoUrl is a YouTube link
courseSchema.pre('save', function(next) {
  const course = this;
  if (course.syllabus) {
    course.syllabus.forEach(chapter => {
      chapter.lectures.forEach(lecture => {
        if (!lecture.youtubeVideoId && lecture.videoUrl) {
          // Attempt to extract ID if missing
          const match = lecture.videoUrl.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=|youtube\.com\/embed\/)([^#&?]*)/);
          if (match && match[1]) {
            lecture.youtubeVideoId = match[1];
          }
        }
      });
    });
  }
  next();
});

// Index for efficient queries
courseSchema.index({ status: 1, classLevel: 1, subject: 1 });

export default mongoose.model<ICourse>('Course', courseSchema);
