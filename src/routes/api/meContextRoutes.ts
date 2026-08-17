/**
 * GET /api/me/context — the single call a client makes to know everything.
 *
 * Organization, branding, user, permissions, enabled modules, limits, usage and
 * configuration in one response. Both clients render every dynamic decision
 * from this payload: which tabs exist, which pickers offer what, which colours
 * paint, which limits warn.
 *
 * ── Why one endpoint and not several ────────────────────────────────────────
 * A client assembling its own view of a tenant from five endpoints will get a
 * torn read eventually — modules from before a change, branding from after.
 * One payload with one `version` is atomic, cacheable, and lets a socket
 * announce "refetch" with a single number.
 *
 * ADDITIVE: no existing endpoint changes. The legacy app never calls this.
 */

import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { currentOrgId, withoutTenantScope } from '../../core/tenancy';
import { getEntitlement } from '../../core/entitlements/resolve';

const router = Router();

router.get('/context', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as unknown as { user?: Record<string, unknown> }).user;
    const orgId = currentOrgId();

    if (!orgId) {
      // Pre-migration, or a deployment with no tenancy configured. Returning a
      // usable shape with nulls beats a 500: a client that has to special-case
      // an error response here would need that branch forever.
      return res.json({
        organization: null,
        user: user ?? null,
        permissions: [],
        modules: [],
        limits: {},
        usage: {},
        configuration: {},
        version: 0,
      });
    }

    const [org, entitlement] = await Promise.all([
      withoutTenantScope('context:read-org', async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Org = require('../../models/Org').default;
        return Org.findById(orgId).lean();
      }),
      getEntitlement(orgId),
    ]);

    const organization = org as {
      _id?: unknown;
      name?: string;
      slug?: string;
      status?: string;
      branding?: Record<string, unknown>;
      locale?: Record<string, unknown>;
    } | null;

    return res.json({
      organization: organization
        ? {
            id: String(organization._id),
            name: organization.name,
            slug: organization.slug,
            status: organization.status,
            branding: organization.branding ?? {},
            locale: organization.locale ?? {},
          }
        : null,
      user: user
        ? {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            classLevel: user.classLevel,
            batch: user.batch,
          }
        : null,
      // Permission-based RBAC lands in a later phase. Returning the role now
      // keeps the response shape stable, so adding real permissions later is
      // additive rather than a breaking change for clients already reading it.
      permissions: [],
      modules: entitlement.modules,
      limits: entitlement.limits,
      usage: {},
      configuration: {},
      subscriptionStatus: entitlement.status,
      writable: entitlement.writable,
      version: entitlement.version,
    });
  } catch (error) {
    console.error('[me/context] failed:', error);
    return res.status(500).json({ message: 'Failed to resolve context' });
  }
});

export default router;
