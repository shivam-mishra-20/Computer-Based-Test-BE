import mongoose, { Document, Schema } from 'mongoose';

/**
 * A tenant-owned role: a named set of permissions.
 *
 * ── Why roles are documents, not an enum ────────────────────────────────────
 * `role: { enum: ['admin','teacher','student'] }` cannot express "Centre
 * Manager" or "Counsellor". Any global enum forces every customer into
 * Abhigyan's org chart, and adding a role for one customer would be a schema
 * change deployed to all of them.
 *
 * ── System vs custom ────────────────────────────────────────────────────────
 * `isSystem` roles are seeded from templates and are not editable. A customer
 * who breaks their own Org Admin role locks themselves out, and recovering that
 * requires platform intervention — worse than the flexibility is worth. Custom
 * roles are entirely theirs.
 *
 * Tenant-scoped by the global plugin, so one organization can never see or
 * assign another's roles.
 */

export interface IRole extends Document {
  orgId: string;
  branchId?: string | null;
  /** Stable identifier, unique within the organization. */
  key: string;
  name: string;
  description?: string;
  /** Always sanitized against the closed vocabulary before saving. */
  permissions: string[];
  isSystem: boolean;
  /** Which template this was seeded from, for later template upgrades. */
  templateKey?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const roleSchema = new Schema<IRole>(
  {
    key: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String },
    permissions: [{ type: String }],
    isSystem: { type: Boolean, default: false },
    templateKey: { type: String },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

roleSchema.index({ orgId: 1, key: 1 }, { unique: true });

export default mongoose.model<IRole>('Role', roleSchema);
