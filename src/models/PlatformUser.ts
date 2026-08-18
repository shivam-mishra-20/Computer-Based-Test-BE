import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcrypt';

/**
 * Platform staff — YOUR people, not a customer's.
 *
 * ── Why a separate collection and not a fourth tenant role ──────────────────
 * A `superadmin` value inside the tenant `User` enum would mean every
 * tenant-scoped query has to special-case it, and ONE missed special case is a
 * cross-tenant read. A separate collection cannot be returned by a scoped query
 * at all, because it is not in the scope — the isolation is structural rather
 * than a rule someone has to remember.
 *
 * It also lets a support hire see customer data without holding the keys to
 * billing.
 *
 * `tenantScoped: false`: platform staff belong to no organization by
 * definition, and a scoped query for them would return nobody.
 */

export type PlatformRole = 'owner' | 'support' | 'billing' | 'engineer';

export const PLATFORM_ROLES: PlatformRole[] = ['owner', 'support', 'billing', 'engineer'];

/**
 * What each platform role may do. Deliberately coarse — there are four of them
 * and they are all employees, so the fine-grained vocabulary tenants get would
 * be ceremony without benefit.
 */
export const PLATFORM_ROLE_CAPABILITIES: Record<PlatformRole, string[]> = {
  owner: ['org.manage', 'plan.manage', 'subscription.manage', 'entitlement.manage', 'billing.manage', 'staff.manage', 'impersonate', 'audit.read'],
  support: ['org.read', 'impersonate', 'audit.read'],
  billing: ['org.read', 'plan.manage', 'subscription.manage', 'billing.manage', 'audit.read'],
  engineer: ['org.read', 'audit.read'],
};

export interface IPlatformUser extends Document {
  name: string;
  email: string;
  password: string;
  role: PlatformRole;
  isActive: boolean;
  /** Bumped to revoke every outstanding token for this account. */
  tokenVersion: number;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(password: string): Promise<boolean>;
}

const platformUserSchema = new Schema<IPlatformUser>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    role: { type: String, enum: PLATFORM_ROLES, required: true, default: 'support', index: true },
    isActive: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date },
  },
  { timestamps: true, tenantScoped: false } as never,
);

platformUserSchema.pre('save', async function (next) {
  const user = this as unknown as IPlatformUser;
  if (!this.isModified('password')) return next();
  user.password = await bcrypt.hash(user.password, 10);
  next();
});

platformUserSchema.methods.comparePassword = function (password: string): Promise<boolean> {
  return bcrypt.compare(password, (this as IPlatformUser).password);
};

/** Capabilities for a platform role; empty for an unknown one. */
export function platformCapabilities(role?: string | null): string[] {
  if (!role) return [];
  return PLATFORM_ROLE_CAPABILITIES[role as PlatformRole] ?? [];
}

export default mongoose.model<IPlatformUser>('PlatformUser', platformUserSchema);
