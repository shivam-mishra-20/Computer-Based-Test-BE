import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcrypt';

export type UserRole = 'admin' | 'teacher' | 'student';

export interface IUser extends Document {
  name: string;
  email: string;
  password: string;
  role: UserRole;
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
