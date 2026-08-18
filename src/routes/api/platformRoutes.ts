/**
 * /api/platform/* — the master admin surface.
 *
 * `router.use(platformAuthMiddleware)` at the top means a route added later
 * cannot be left unguarded by forgetting a middleware — the guard is structural
 * rather than per-route discipline. Every route additionally declares the
 * platform capability it needs, so a `support` account cannot change a plan.
 *
 * Routes here are thin: validation, capability, delegate to `core/platform/*`,
 * audit. All the logic lives in services that are reused by the onboarding
 * orchestrator and the tests.
 */

import { Router, Request, Response } from 'express';
import { platformAuthMiddleware, requirePlatformCapability } from '../../middlewares/platformAuth';
import { withoutTenantScope } from '../../core/tenancy';
import { getEntitlement } from '../../core/entitlements/resolve';
import { listPlatformAudit, recordPlatformAction } from '../../core/platform/audit';
import { onboardOrganization } from '../../core/platform/onboarding';
import {
  createOrganization,
  listOrganizations,
  getOrganizationDetail,
  setOrganizationStatus,
  updateOrganization,
  setOrganizationConfig,
  setOrganizationPolicy,
  setSubscription,
  listOrgUsers,
  listOrgRoles,
  listModules,
  listPlans,
  upsertPlan,
  createCustomRole,
  OrgSlugTaken,
} from '../../core/platform/organizations';
import type { PlatformRequestUser } from '../../middlewares/platformAuth';
import { PLATFORM_ROLES } from '../../models/PlatformUser';

const router = Router();

router.use(platformAuthMiddleware);

/** Wrap a handler so a thrown error becomes a clean 500 rather than a hang. */
function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof OrgSlugTaken) {
        return res.status(409).json({ message: error.message, code: error.code });
      }
      console.error(`[platform] ${req.method} ${req.path} failed:`, error);
      return res.status(500).json({ message: (error as Error).message || 'Platform request failed' });
    }
  };
}

// ── Session ────────────────────────────────────────────────────────────────

router.get('/me', (req: Request, res: Response) => {
  const staff = (req as Request & { platformUser?: PlatformRequestUser }).platformUser;
  return res.json({ platformUser: staff });
});

// ── Dashboard ──────────────────────────────────────────────────────────────

router.get(
  '/dashboard',
  requirePlatformCapability('org.read'),
  handle(async (_req, res) => {
    const summary = await withoutTenantScope('platform:dashboard', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Org = require('../../models/Org').default;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const User = require('../../models/User').default;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Subscription = require('../../models/Subscription').default;

      const [orgs, byStatus, users, subs] = await Promise.all([
        Org.countDocuments({}),
        Org.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
        User.countDocuments({}),
        Subscription.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
      ]);

      return {
        organizations: orgs,
        organizationsByStatus: Object.fromEntries(
          (byStatus as { _id: string; n: number }[]).map((r) => [r._id ?? 'unknown', r.n]),
        ),
        users,
        subscriptionsByStatus: Object.fromEntries(
          (subs as { _id: string; n: number }[]).map((r) => [r._id ?? 'unknown', r.n]),
        ),
        modules: listModules().length,
      };
    });

    const recent = await listPlatformAudit({ limit: 10 });
    return res.json({ summary, recentActivity: recent });
  }),
);

// ── Organizations ──────────────────────────────────────────────────────────

router.get(
  '/orgs',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const result = await listOrganizations({
      search: req.query.search as string,
      status: req.query.status as string,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      skip: req.query.skip ? Number(req.query.skip) : undefined,
    });
    return res.json(result);
  }),
);

router.post(
  '/orgs',
  requirePlatformCapability('org.manage'),
  handle(async (req, res) => {
    const { name, slug } = req.body ?? {};
    if (!name || !slug) {
      return res.status(400).json({ message: 'name and slug are required' });
    }
    const org = await createOrganization(req.body);
    await recordPlatformAction(req, {
      action: 'org.create',
      orgId: String(org._id),
      entity: 'Org',
      entityId: String(org._id),
      metadata: { name, slug },
    });
    return res.status(201).json({ organization: org });
  }),
);

/** The complete onboarding journey in one call. */
router.post(
  '/orgs/onboard',
  requirePlatformCapability('org.manage'),
  handle(async (req, res) => {
    if (!req.body?.organization?.name || !req.body?.organization?.slug) {
      return res.status(400).json({ message: 'organization.name and organization.slug are required' });
    }
    const result = await onboardOrganization(req.body);
    await recordPlatformAction(req, {
      action: 'org.onboard',
      orgId: result.orgId,
      entity: 'Org',
      entityId: result.orgId,
      metadata: { slug: result.slug, complete: result.complete, steps: result.steps },
    });
    // 207 when some step failed: the organization exists and is partially
    // configured, which is neither a success nor a clean failure, and the
    // console needs to show exactly which steps to retry.
    return res.status(result.complete ? 201 : 207).json(result);
  }),
);

router.get(
  '/orgs/:orgId',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const detail = await getOrganizationDetail(req.params.orgId);
    if (!detail) return res.status(404).json({ message: 'Organization not found' });
    return res.json(detail);
  }),
);

router.patch(
  '/orgs/:orgId',
  requirePlatformCapability('org.manage'),
  handle(async (req, res) => {
    const updated = await updateOrganization(req.params.orgId, req.body ?? {});
    if (!updated) return res.status(404).json({ message: 'Organization not found' });
    await recordPlatformAction(req, {
      action: 'org.update',
      orgId: req.params.orgId,
      entity: 'Org',
      entityId: req.params.orgId,
      changes: req.body,
    });
    return res.json({ organization: updated });
  }),
);

router.post(
  '/orgs/:orgId/status',
  requirePlatformCapability('org.manage'),
  handle(async (req, res) => {
    const { status } = req.body ?? {};
    const allowed = ['trialing', 'active', 'past_due', 'suspended', 'cancelled', 'terminated'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: `status must be one of: ${allowed.join(', ')}` });
    }
    const updated = await setOrganizationStatus(req.params.orgId, status);
    if (!updated) return res.status(404).json({ message: 'Organization not found' });
    await recordPlatformAction(req, {
      action: `org.status.${status}`,
      orgId: req.params.orgId,
      entity: 'Org',
      entityId: req.params.orgId,
      changes: { status },
    });
    return res.json({ organization: updated });
  }),
);

router.get(
  '/orgs/:orgId/users',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => {
    const result = await listOrgUsers(
      req.params.orgId,
      req.query.limit ? Number(req.query.limit) : 50,
      req.query.skip ? Number(req.query.skip) : 0,
    );
    return res.json(result);
  }),
);

router.get(
  '/orgs/:orgId/roles',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => res.json({ roles: await listOrgRoles(req.params.orgId) })),
);

router.post(
  '/orgs/:orgId/roles',
  requirePlatformCapability('org.manage'),
  handle(async (req, res) => {
    const { key, name, permissions } = req.body ?? {};
    if (!key || !name || !Array.isArray(permissions)) {
      return res.status(400).json({ message: 'key, name and permissions[] are required' });
    }
    const role = await createCustomRole(req.params.orgId, req.body);
    await recordPlatformAction(req, {
      action: 'org.role.upsert',
      orgId: req.params.orgId,
      entity: 'Role',
      entityId: role.id,
      metadata: { key, granted: role.granted.length, rejected: role.rejected },
    });
    return res.status(201).json(role);
  }),
);

// ── Organization configuration ─────────────────────────────────────────────

router.put(
  '/orgs/:orgId/config',
  requirePlatformCapability('org.manage'),
  handle(async (req, res) => {
    const counts = await setOrganizationConfig(req.params.orgId, req.body ?? {});
    await recordPlatformAction(req, {
      action: 'org.config.update',
      orgId: req.params.orgId,
      entity: 'OrgConfig',
      metadata: counts,
    });
    return res.json({ applied: counts });
  }),
);

router.put(
  '/orgs/:orgId/policy',
  requirePlatformCapability('org.manage'),
  handle(async (req, res) => {
    const policy = await setOrganizationPolicy(req.params.orgId, req.body ?? {});
    await recordPlatformAction(req, {
      action: 'org.policy.update',
      orgId: req.params.orgId,
      entity: 'OrgPolicy',
      changes: req.body,
    });
    return res.json({ policy });
  }),
);

// ── Entitlements and subscriptions ─────────────────────────────────────────

router.get(
  '/orgs/:orgId/entitlement',
  requirePlatformCapability('org.read'),
  handle(async (req, res) => res.json({ entitlement: await getEntitlement(req.params.orgId) })),
);

router.put(
  '/orgs/:orgId/subscription',
  // Deliberately requires subscription.manage, NOT org.manage: a support
  // account may configure a customer's classes but must not change what they
  // are paying for.
  requirePlatformCapability('subscription.manage'),
  handle(async (req, res) => {
    const entitlement = await setSubscription(req.params.orgId, req.body ?? {});
    await recordPlatformAction(req, {
      action: 'org.subscription.update',
      orgId: req.params.orgId,
      entity: 'Subscription',
      changes: req.body,
      metadata: { modules: entitlement.modules.length, version: entitlement.version },
    });
    return res.json({ entitlement });
  }),
);

// ── Catalogue ──────────────────────────────────────────────────────────────

router.get(
  '/modules',
  requirePlatformCapability('org.read'),
  handle(async (_req, res) => res.json({ modules: listModules() })),
);

router.get(
  '/plans',
  requirePlatformCapability('org.read'),
  handle(async (_req, res) => res.json({ plans: await listPlans() })),
);

router.put(
  '/plans',
  requirePlatformCapability('plan.manage'),
  handle(async (req, res) => {
    const { key, name, modules } = req.body ?? {};
    if (!key || !name || !Array.isArray(modules)) {
      return res.status(400).json({ message: 'key, name and modules[] are required' });
    }
    const plan = await upsertPlan(req.body);
    await recordPlatformAction(req, {
      action: 'plan.upsert',
      entity: 'Plan',
      entityId: String((plan as { _id?: unknown })?._id ?? key),
      changes: req.body,
    });
    return res.json({ plan });
  }),
);

// ── Platform staff ─────────────────────────────────────────────────────────

router.get(
  '/staff',
  requirePlatformCapability('staff.manage'),
  handle(async (_req, res) => {
    const staff = await withoutTenantScope('platform:list-staff', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PlatformUser = require('../../models/PlatformUser').default;
      return PlatformUser.find({}).select('name email role isActive lastLoginAt createdAt').lean();
    });
    return res.json({ staff });
  }),
);

router.post(
  '/staff',
  requirePlatformCapability('staff.manage'),
  handle(async (req, res) => {
    const { name, email, password, role } = req.body ?? {};
    if (!name || !email || !password || !PLATFORM_ROLES.includes(role)) {
      return res.status(400).json({
        message: `name, email, password and role (${PLATFORM_ROLES.join('|')}) are required`,
      });
    }
    const created = await withoutTenantScope('platform:create-staff', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PlatformUser = require('../../models/PlatformUser').default;
      const user = await PlatformUser.create({ name, email, password, role, isActive: true });
      return { id: String(user._id), name: user.name, email: user.email, role: user.role };
    });
    await recordPlatformAction(req, {
      action: 'staff.create',
      entity: 'PlatformUser',
      entityId: (created as { id: string }).id,
      metadata: { email, role },
    });
    return res.status(201).json({ staff: created });
  }),
);

router.post(
  '/staff/:id/status',
  requirePlatformCapability('staff.manage'),
  handle(async (req, res) => {
    const { isActive } = req.body ?? {};
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ message: 'isActive (boolean) is required' });
    }
    const updated = await withoutTenantScope('platform:staff-status', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PlatformUser = require('../../models/PlatformUser').default;
      // Deactivating also bumps tokenVersion, so outstanding tokens stop
      // working immediately rather than at expiry. Disabling an account that
      // keeps working for 15 minutes is not disabling it.
      return PlatformUser.findByIdAndUpdate(
        req.params.id,
        { $set: { isActive }, $inc: { tokenVersion: 1 } },
        { new: true },
      )
        .select('name email role isActive')
        .lean();
    });
    if (!updated) return res.status(404).json({ message: 'Platform user not found' });
    await recordPlatformAction(req, {
      action: isActive ? 'staff.activate' : 'staff.deactivate',
      entity: 'PlatformUser',
      entityId: req.params.id,
    });
    return res.json({ staff: updated });
  }),
);

// ── Audit ──────────────────────────────────────────────────────────────────

router.get(
  '/audit',
  requirePlatformCapability('audit.read'),
  handle(async (req, res) => {
    const entries = await listPlatformAudit({
      orgId: req.query.orgId as string,
      actorId: req.query.actorId as string,
      action: req.query.action as string,
      limit: req.query.limit ? Number(req.query.limit) : 100,
    });
    return res.json({ entries });
  }),
);

export default router;
