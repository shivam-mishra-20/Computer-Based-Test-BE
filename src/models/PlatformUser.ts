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

/** Every capability the platform recognises. */
export const PLATFORM_CAPABILITIES = [
  'org.read', 'org.manage',
  'plan.manage',
  'subscription.manage',
  'entitlement.manage',
  'billing.manage',
  'staff.manage',
  'impersonate',
  'audit.read',
] as const;

/**
 * What each platform role may do. Deliberately coarse — there are four of them
 * and they are all employees, so the fine-grained vocabulary tenants get would
 * be ceremony without benefit.
 *
 * `owner` holds everything by construction rather than by an enumerated list.
 * The first draft listed owner's capabilities by hand, omitted `org.read`, and
 * produced the most privileged role on the platform being unable to open the
 * dashboard. A list that has to be kept in sync with another list will
 * eventually not be.
 */
export const PLATFORM_ROLE_CAPABILITIES: Record<PlatformRole, string[]> = {
  owner: [...PLATFORM_CAPABILITIES],
  support: ['org.read', 'impersonate', 'audit.read'],
  billing: ['org.read', 'plan.manage', 'subscription.manage', 'billing.manage', 'audit.read'],
  engineer: ['org.read', 'audit.read'],
};

/**
 * Does `held` satisfy `required`?
 *
 * A `.manage` capability implies the matching `.read`. "May change it but may
 * not see it" is not a coherent grant, and encoding the implication here means
 * a new `x.manage` capability cannot be added while forgetting `x.read`.
 */
export function satisfiesCapability(held: string[], required: string): boolean {
  if (held.includes(required)) return true;
  if (required.endsWith('.read')) {
    return held.includes(required.replace(/\.read$/, '.manage'));
  }
  return false;
}

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
