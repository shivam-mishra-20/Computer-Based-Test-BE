import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcrypt';

export type UserRole = 'admin' | 'teacher' | 'student';
export type UserStatus = 'pending' | 'approved' | 'rejected';
export type Board = 'CBSE' | 'ICSE' | 'State Board' | 'IB' | 'IGCSE' | 'Other';
export type TargetExam = 'Boards' | 'JEE' | 'NEET' | 'CUET' | 'NDA' | 'Olympiad' | 'Other';

export interface IUser extends Document {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  status: UserStatus;
  phone?: string;
  // Student-specific fields
  board?: Board;
  targetExams?: TargetExam[];
  // Optional Firebase link and student metadata
  firebaseUid?: string;
  classLevel?: string;
  batch?: string;
  authProvider?: 'local' | 'firebase';
  comparePassword(password: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>({
  name: { type: String, required: true },
  email: { type: String, unique: true, required: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'teacher', 'student'], default: 'student', index: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved', index: true },
  phone: { type: String },
  board: { type: String, enum: ['CBSE', 'ICSE', 'State Board', 'IB', 'IGCSE', 'Other'], index: true },
  targetExams: [{ type: String, enum: ['Boards', 'JEE', 'NEET', 'CUET', 'NDA', 'Olympiad', 'Other'] }],
  firebaseUid: { type: String, index: true },
  classLevel: { type: String, index: true },
  batch: { type: String, index: true },
  authProvider: { type: String, enum: ['local', 'firebase'], default: 'local' },
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
