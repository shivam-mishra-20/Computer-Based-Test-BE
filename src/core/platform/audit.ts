/**
 * Recording platform-staff actions.
 *
 * One helper, used by every mutating platform route. Keeping it in one place
 * means the shape stays consistent and a new route cannot invent its own
 * half-populated record.
 */

import type { Request } from 'express';
import { withoutTenantScope } from '../tenancy/context';
import type { PlatformRequestUser } from '../../middlewares/platformAuth';

export interface AuditInput {
  action: string;
  orgId?: string;
  entity?: string;
  entityId?: string;
  changes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Write an audit record. Never throws.
 *
 * ── Why failures are swallowed ──────────────────────────────────────────────
 * An audit write failing must not fail the operation it was recording. If the
 * audit collection is unavailable, refusing to suspend a delinquent
 * organization is the wrong trade — the action is the point, the record is
 * evidence of it. The failure is logged loudly so it is visible, and a
 * persistently broken audit is an operational problem to fix, not a reason to
 * block administration.
 */
export async function recordPlatformAction(
  req: Request,
  input: AuditInput,
): Promise<void> {
  const staff = (req as Request & { platformUser?: PlatformRequestUser }).platformUser;

  try {
    await withoutTenantScope('platform:audit-write', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PlatformAudit = require('../../models/PlatformAudit').default;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PlatformUser = require('../../models/PlatformUser').default;

      // The email is denormalised on purpose: a staff account may later be
      // deleted, and an audit trail naming an id that no longer resolves is
      // barely better than no trail at all.
      let actorEmail: string | undefined;
      if (staff?.id) {
        const account = await PlatformUser.findById(staff.id).select('email').lean();
        actorEmail = (account as { email?: string } | null)?.email;
      }

      await PlatformAudit.create({
        actorId: staff?.id,
        actorEmail,
        actorRole: staff?.role,
        action: input.action,
        orgId: input.orgId,
        entity: input.entity,
        entityId: input.entityId,
        changes: input.changes,
        metadata: input.metadata,
        ip: req.ip,
      });
    });
  } catch (error) {
    console.error(
      `[platform-audit] FAILED to record "${input.action}":`,
      (error as Error).message,
    );
  }
}

export interface AuditQuery {
  orgId?: string;
  actorId?: string;
  action?: string;
  limit?: number;
  before?: Date;
}

export async function listPlatformAudit(query: AuditQuery) {
  return withoutTenantScope('platform:audit-read', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const PlatformAudit = require('../../models/PlatformAudit').default;

    const filter: Record<string, unknown> = {};
    if (query.orgId) filter.orgId = query.orgId;
    if (query.actorId) filter.actorId = query.actorId;
    if (query.action) filter.action = new RegExp(String(query.action), 'i');
    if (query.before) filter.createdAt = { $lt: query.before };

    return PlatformAudit.find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(query.limit ?? 100, 500))
      .lean();
  });
}
