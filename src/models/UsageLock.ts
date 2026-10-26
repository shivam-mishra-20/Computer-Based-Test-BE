import mongoose, { Document, Schema } from 'mongoose';

/**
 * A short lease on one organization's one limited resource.
 *
 * Not a counter and not a source of truth: it holds NO usage. It exists only so
 * that "count what is used, then create one more" happens for one request at a
 * time per (organization, resource). Without it, two requests for the last
 * free seat both count N−1 and both create, and the organization ends at N+1.
 *
 * Why a lease document rather than a transaction: it serializes every path the
 * same way whether or not the deployment supports transactions (a developer's
 * standalone mongod does not), and it does not require threading a session
 * through handlers that were written without one. The lease expires on its
 * own, so a process that dies holding it blocks that resource for seconds, not
 * forever.
 *
 * Platform-owned and NOT tenant-scoped: written only by core/subscriptions/usage.
 */

export interface IUsageLock extends Document {
  orgId: string;
  resource: string;
  /** The request holding the lease, or null when free. */
  holder: string | null;
  expiresAt: Date;
}

const usageLockSchema = new Schema<IUsageLock>(
  {
    orgId: { type: String, required: true },
    resource: { type: String, required: true },
    holder: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false, tenantScoped: false } as never,
);

// One lease per (organization, resource): what makes acquiring it atomic.
usageLockSchema.index({ orgId: 1, resource: 1 }, { unique: true });

export default mongoose.model<IUsageLock>('UsageLock', usageLockSchema);
