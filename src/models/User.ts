import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcrypt';

export type UserRole = 'admin' | 'teacher' | 'student';
export type UserStatus = 'pending' | 'approved' | 'rejected';
export type RegistrationSource = 'website' | 'app' | 'admin' | 'unknown';
export type Board = 'CBSE' | 'ICSE' | 'GSEB' | 'IB' | 'IGCSE' | 'Other';
export type TargetExam = 'JEE Main' | 'JEE Advanced' | 'NEET' | 'CET' | 'Board Exams' | 'CUET' | 'Olympiad' | 'Foundation' | 'Other';

/**
 * Discriminates an institute-enrolled student from a self-registered public
 * learner. Both carry `role: 'student'` so that every existing role check in
 * the codebase keeps behaving exactly as before — a new *role* would have
 * required auditing every `['admin','teacher'].includes(role)` permission gate,
 * where a missed site silently denies access. A discriminator fails safe in the
 * other direction: forget it and a learner is merely visible, never privileged.
 *
 * Institute *audience* queries must therefore exclude PUBLIC_LEARNER explicitly.
 * Use the helpers in `src/utils/instituteAudience.ts` — never hand-roll it.
 *
 * Legacy documents have no `accountType` field at all. `{ $ne: 'PUBLIC_LEARNER' }`
 * matches missing fields in MongoDB, so those documents stay inside every
 * institute audience with no backfill migration required.
 */
export type AccountType = 'INSTITUTE_STUDENT' | 'PUBLIC_LEARNER';

/** Where a public learner is in the post-registration personalization flow. */
export type LearnerOnboardingStep = 'BOARD' | 'CLASS' | 'SUBJECTS' | 'DONE';

export const LEARNER_ONBOARDING_STEPS: LearnerOnboardingStep[] = ['BOARD', 'CLASS', 'SUBJECTS', 'DONE'];

/**
 * A public learner's academic selections.
 *
 * These are LEARNING PREFERENCES, not enrollment. They are deliberately kept
 * out of the root `classLevel` / `batch` / `board` fields, which are read by
 * institute rosters, exam audiences, attendance, leaderboards and room
 * allocation. Writing a learner's chosen class into the root field would place
 * them inside institute Class 10 — this nesting is the primary structural
 * defence against that, independent of any query filter.
 */
export interface ILearnerProfile {
  board?: Board;
  /** Normalized digits-only class, e.g. "10". Never written to root classLevel. */
  classLevel?: string;
  subjects?: string[];
  /** Free-text location. Reference data only — never used for any institute
   *  audience query, and deliberately kept inside learnerProfile like the rest
   *  of a learner's self-declared information. */
  state?: string;
  city?: string;
  onboardingStep?: LearnerOnboardingStep;
  onboardingCompletedAt?: Date;
}

export interface IUser extends Document {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  /**
   * Assigned Role documents. Empty for every existing Abhigyan account, which
   * is exactly why resolveUserPermissions() falls back to the legacy `role`
   * string — see core/rbac/resolve.ts.
   */
  roleIds?: unknown[];
  /** Bumped to revoke every outstanding token for this user. */
  tokenVersion?: number;
  accountType?: AccountType;
  learnerProfile?: ILearnerProfile;
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
  // Additive: absent on all 158 existing accounts, which keeps them on the
  // legacy-role permission mapping and therefore behaving exactly as today.
  roleIds: [{ type: Schema.Types.ObjectId, ref: 'Role' }],
  tokenVersion: { type: Number, default: 0 },
  // Defaults to INSTITUTE_STUDENT so any account created by an existing code
  // path (admin creation, institute registration, firebase sync) stays inside
  // the institute exactly as before. Only the learner-register endpoint sets
  // PUBLIC_LEARNER. Inert for teacher/admin rows.
  accountType: {
    type: String,
    enum: ['INSTITUTE_STUDENT', 'PUBLIC_LEARNER'],
    default: 'INSTITUTE_STUDENT',
    index: true,
  },
  learnerProfile: {
    type: {
      board: { type: String, enum: ['CBSE', 'ICSE', 'GSEB', 'IB', 'IGCSE', 'Other'] },
      classLevel: { type: String },
      subjects: [{ type: String }],
      state: { type: String },
      city: { type: String },
      onboardingStep: { type: String, enum: LEARNER_ONBOARDING_STEPS, default: 'BOARD' },
      onboardingCompletedAt: { type: Date },
    },
    // No schema-level default: institute accounts must not carry an empty
    // learner profile, and its absence is what marks a row as institute-only.
    required: false,
    _id: false,
  },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved', index: true },
  registrationSource: { type: String, enum: ['website', 'app', 'admin', 'unknown'], default: 'unknown', index: true },
  phone: { type: String },
  empCode: { type: String, unique: true, sparse: true, index: true },
  bio: { type: String },
  pushToken: { type: String },
  board: { type: String, enum: ['CBSE', 'ICSE', 'GSEB', 'IB', 'IGCSE', 'Other'], index: true },
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

/**
 * Tenant-local email uniqueness.
 *
 * ── Why this is ADDED and the global one is NOT yet dropped ─────────────────
 * One person may legitimately exist at two organizations — a teacher who
 * consults for a second institute, a student who moved. Global uniqueness on
 * `email` makes that impossible.
 *
 * But the two constraints are deliberately allowed to coexist for now. Dropping
 * the global index in the same change would leave a window during which NEITHER
 * is enforced if the new one fails to build, and duplicate accounts created in
 * that window cannot be un-created. Order is: build the compound index, verify
 * it, and only then drop the global one — as a separate, reversible step.
 *
 * While both exist the stricter (global) constraint wins, so behaviour for
 * Org 001 is unchanged. Nothing depends on cross-org duplicates until Org 002
 * has a user sharing an email with Org 001, which is a deployment-window
 * concern rather than a code one.
 */
userSchema.index({ orgId: 1, email: 1 }, { unique: true, sparse: true });

export default mongoose.model<IUser>('User', userSchema);
