/**
 * /api/platform/* — the master admin surface.
 *
 * Mounted behind `platformAuthMiddleware`, which rejects on token audience
 * before any handler runs. A tenant user cannot reach these routes regardless
 * of their role or permissions.
 *
 * Deliberately minimal for P2: enough to prove the audience separation works
 * and to read organization state. Org CRUD, plan management and billing belong
 * to the console phase.
 */

import { Router, Request, Response } from 'express';
import { platformAuthMiddleware, requirePlatformCapability } from '../../middlewares/platformAuth';
import { withoutTenantScope } from '../../core/tenancy';
import type { PlatformRequestUser } from '../../middlewares/platformAuth';

const router = Router();

// EVERY route below requires a platform-audience token. Applied at router level
// so a new route cannot be added without it by forgetting a middleware.
router.use(platformAuthMiddleware);

/** Who am I, and what may I do. */
router.get('/me', (req: Request, res: Response) => {
  const staff = (req as Request & { platformUser?: PlatformRequestUser }).platformUser;
  return res.json({ platformUser: staff });
});

/** Organizations — the platform's own view across every tenant. */
router.get(
  '/orgs',
  requirePlatformCapability('org.read'),
  async (_req: Request, res: Response) => {
    try {
      const orgs = await withoutTenantScope('platform:list-orgs', async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Org = require('../../models/Org').default;
        return Org.find({}).select('name slug status isPlatformOwned createdAt').lean();
      });
      return res.json({ organizations: orgs });
    } catch (error) {
      console.error('[platform] list orgs failed:', error);
      return res.status(500).json({ message: 'Failed to list organizations' });
    }
  },
);

/**
 * Entitlements are readable here and writable ONLY here.
 *
 * There is deliberately no equivalent route under /api/org/* — a tenant that
 * could write its own Subscription could grant itself every paid module.
 */
router.get(
  '/orgs/:orgId/entitlement',
  requirePlatformCapability('org.read'),
  async (req: Request, res: Response) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getEntitlement } = require('../../core/entitlements/resolve');
      const entitlement = await getEntitlement(req.params.orgId);
      return res.json({ entitlement });
    } catch (error) {
      console.error('[platform] entitlement read failed:', error);
      return res.status(500).json({ message: 'Failed to resolve entitlement' });
    }
  },
);

export default router;
