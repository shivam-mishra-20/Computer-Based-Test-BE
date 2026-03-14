import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcrypt';

export type UserRole = 'admin' | 'teacher' | 'student';
export type UserStatus = 'pending' | 'approved' | 'rejected';
export type RegistrationSource = 'website' | 'app' | 'admin' | 'unknown';
export type Board = 'CBSE' | 'ICSE' | 'State Board' | 'IB' | 'IGCSE' | 'Other';
export type TargetExam = 'JEE Main' | 'JEE Advanced' | 'NEET' | 'CET' | 'Board Exams' | 'CUET' | 'Olympiad' | 'Foundation' | 'Other';

export interface IUser extends Document {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  status: UserStatus;
  registrationSource?: RegistrationSource;
  phone?: string;
  empCode?: string; // For EtimeOffice mapping
  bio?: string; // Teacher/student bio
  pushToken?: string; // Expo push token
  // Student-specific fields
  board?: Board;
  targetExams?: TargetExam[];
  studyGoals?: string[];
  profileImage?: string;
  // Optional Firebase link and student metadata
  firebaseUid?: string;
  classLevel?: string;
  batch?: string;
  authProvider?: 'local' | 'firebase';
  // Password reset
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  // Onboarding
  welcomeTutorialCompleted?: boolean;
  // User settings
  settings?: {
    pushNotifications?: boolean;
    emailNotifications?: boolean;
    examReminders?: boolean;
    doubtAlerts?: boolean;
    scheduleUpdates?: boolean;
    materialUpdates?: boolean;
    notesUpdates?: boolean;
    autoSave?: boolean;
    language?: string;
  };
  comparePassword(password: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>({
  name: { type: String, required: true },
  email: { type: String, unique: true, required: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'teacher', 'student'], default: 'student', index: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved', index: true },
  registrationSource: { type: String, enum: ['website', 'app', 'admin', 'unknown'], default: 'unknown', index: true },
  phone: { type: String },
  empCode: { type: String, unique: true, sparse: true, index: true },
  bio: { type: String },
  pushToken: { type: String },
  board: { type: String, enum: ['CBSE', 'ICSE', 'State Board', 'IB', 'IGCSE', 'Other'], index: true },
  targetExams: [{ type: String, enum: ['JEE Main', 'JEE Advanced', 'NEET', 'CET', 'Board Exams', 'CUET', 'Olympiad', 'Foundation', 'Other'] }],
  studyGoals: [{ type: String }],
  profileImage: { type: String },
  firebaseUid: { type: String, index: true },
  classLevel: { type: String, index: true },
  batch: { type: String, index: true },
  authProvider: { type: String, enum: ['local', 'firebase'], default: 'local' },
  passwordResetToken: { type: String },
  passwordResetExpires: { type: Date },
  welcomeTutorialCompleted: { type: Boolean, default: false },
  settings: {
    type: {
      pushNotifications: { type: Boolean, default: true },
      emailNotifications: { type: Boolean, default: true },
      examReminders: { type: Boolean, default: true },
      doubtAlerts: { type: Boolean, default: true },
      scheduleUpdates: { type: Boolean, default: true },
      materialUpdates: { type: Boolean, default: true },
      notesUpdates: { type: Boolean, default: true },
      autoSave: { type: Boolean, default: true },
      language: { type: String, default: 'English' },
    },
    default: () => ({
      pushNotifications: true,
      emailNotifications: true,
      examReminders: true,
      doubtAlerts: true,
      scheduleUpdates: true,
      materialUpdates: true,
      notesUpdates: true,
      autoSave: true,
      language: 'English',
    }),
  },
}, { timestamps: true });

userSchema.pre('save', async function (next) {
  const user = this as unknown as IUser;
  if (!this.isModified('password')) return next();
  user.password = await bcrypt.hash(user.password, 10);
  next();
});

userSchema.methods.comparePassword = function (password: string): Promise<boolean> {
  return bcrypt.compare(password, (this as IUser).password);
};

export default mongoose.model<IUser>('User', userSchema);
