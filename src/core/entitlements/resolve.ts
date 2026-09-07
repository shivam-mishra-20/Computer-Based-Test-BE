/**
 * Entitlement resolution — turning a commercial record into an answer.
 *
 *   plan.modules ∪ addOns − removals, then overrides applied LAST
 *   → expand dependencies and fold in core modules
 *   → materialize as a versioned Entitlement snapshot
 *   → cache in Redis
 *
 * Overrides come last on purpose: a negotiated Enterprise deal should never
 * require inventing a bespoke Plan just to change one limit, and applying them
 * before removals would let a removal silently undo a negotiated grant.
 */

import { withoutTenantScope } from '../tenancy/context';
import { expandDependencies, allModuleKeys, CORE_MODULE_KEYS } from './moduleRegistry';

export interface ResolvedEntitlement {
  orgId: string;
  modules: string[];
  limits: Record<string, number>;
  status: string;
  writable: boolean;
  version: number;
  resolvedAt: Date;
}

const CACHE_PREFIX = 't:';
const CACHE_TTL_SECONDS = 300;

/** Redis cache key for an organization's resolved entitlement. */
function cacheKey(orgId: string): string {
  return `${CACHE_PREFIX}${orgId}:ent`;
}

/**
 * ADR-12: platform-owned organizations are entitled to everything, always.
 *
 * Org 001 (Abhigyan) and Org 000 (public learning) are not customers. Letting
 * the commercial layer gate them would mean a bug in billing could switch off a
 * feature the institute's staff use daily — and there is no upside, because
 * neither is ever invoiced.
 */
function platformOwnedEntitlement(orgId: string, status: string): ResolvedEntitlement {
  return {
    orgId,
    modules: allModuleKeys(),
    limits: {},
    status,
    writable: true,
    version: 0,
    resolvedAt: new Date(),
  };
}

/**
 * The entitlement for an organization with NO subscription record.
 *
 * ── The most consequential default in this file ─────────────────────────────
 * Today no organization has a Subscription, because the collection is brand
 * new. If "no subscription" resolved to "no modules", every route carrying
 * `requireModule()` would begin returning 403 the moment this shipped — the
 * same class of outage as the defaulted-pinned 503, and for the same reason:
 * a safe default for COMMERCE is not a safe default for BEHAVIOUR.
 *
 * So an unsubscribed organization gets everything. Entitlement gating starts
 * mattering when a Subscription exists, which is a deliberate act performed by
 * platform staff — never a side effect of deploying this code.
 */
function unsubscribedEntitlement(orgId: string): ResolvedEntitlement {
  return {
    orgId,
    modules: allModuleKeys(),
    limits: {},
    status: 'unsubscribed',
    writable: true,
    version: 0,
    resolvedAt: new Date(),
  };
}

/**
 * Compute the module set from a subscription and its plan.
 *
 * Pure — no database, no cache — so the packaging rules can be tested directly.
 */
export function computeModules(input: {
  planModules?: string[];
  addOns?: string[];
  removals?: string[];
  overrideModules?: string[];
}): string[] {
  const base = new Set<string>(input.planModules ?? []);
  for (const key of input.addOns ?? []) base.add(key);
  for (const key of input.removals ?? []) base.delete(key);

  // Overrides last: a negotiated grant must survive a removal list.
  for (const key of input.overrideModules ?? []) base.add(key);

  // Core is never optional, and a module without its dependencies is a
  // packaging error that presents to the customer as a bug.
  return expandDependencies([...base]);
}

export function computeLimits(
  planLimits: Record<string, number | undefined> = {},
  overrideLimits: Record<string, number> = {},
): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const [key, value] of Object.entries(planLimits)) {
    if (typeof value === 'number') limits[key] = value;
  }
  for (const [key, value] of Object.entries(overrideLimits)) {
    limits[key] = value;
  }
  return limits;
}

/**
 * Resolve, persist and cache an organization's entitlement.
 *
 * Called on any subscription change — never per request.
 */
export async function resolveEntitlement(
  orgId: string,
  reason = 'manual',
): Promise<ResolvedEntitlement> {
  // Commercial collections are global by design; reading them is a sanctioned
  // cross-tenant operation.
  return withoutTenantScope('entitlements:resolve', async () => {
    // Required lazily so this module can be imported before models compile.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Subscription = require('../../models/Subscription').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Plan = require('../../models/Plan').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const EntitlementModel = require('../../models/Entitlement').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { WRITABLE_STATUSES } = require('../../models/Subscription');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Org = require('../../models/Org').default;

    const [subscription, org] = await Promise.all([
      Subscription.findOne({ orgId }),
      Org.findById(orgId).select('status').lean(),
    ]);

    /**
     * TWO independent statuses gate writability, and both must permit it.
     *
     *   Org.status           the tenant lifecycle, controlled by platform staff
     *   Subscription.status  the commercial state
     *
     * They are genuinely different questions. Suspending an ORGANIZATION is an
     * administrative act — a compliance hold, an offboarding — and it must block
     * writes even while the subscription still reads `active`. The first version
     * of this consulted only the subscription, so suspending an org through the
     * console changed its status and nothing else, which is the most misleading
     * possible outcome for whoever pressed the button.
     */
    const orgStatus = (org as { status?: string } | null)?.status;
    const orgPermitsWrites = !orgStatus || WRITABLE_STATUSES.includes(orgStatus as never);

    let resolved: ResolvedEntitlement;

    if (!subscription) {
      resolved = unsubscribedEntitlement(orgId);
      // An org suspended before it was ever subscribed must still be read-only.
      resolved.writable = orgPermitsWrites;
      if (orgStatus) resolved.status = orgStatus;
    } else if (subscription.isPlatformOwned) {
      resolved = platformOwnedEntitlement(orgId, subscription.status);
      resolved.writable = orgPermitsWrites;
    } else {
      const plan = subscription.planId ? await Plan.findById(subscription.planId) : null;

      const modules = computeModules({
        planModules: plan?.modules ?? [],
        addOns: subscription.addOns,
        removals: subscription.removals,
        overrideModules: subscription.overrides?.modules,
      });

      const limits = computeLimits(plan?.limits ?? {}, subscription.overrides?.limits ?? {});

      resolved = {
        orgId,
        modules,
        limits,
        status: subscription.status,
        writable: WRITABLE_STATUSES.includes(subscription.status) && orgPermitsWrites,
        version: 0,
        resolvedAt: new Date(),
      };
    }

    // Persist, bumping the version so clients can detect the change.
    const stored = await EntitlementModel.findOneAndUpdate(
      { orgId },
      {
        $set: {
          modules: resolved.modules,
          limits: resolved.limits,
          status: resolved.status,
          writable: resolved.writable,
          resolvedAt: resolved.resolvedAt,
          reason,
        },
        $inc: { version: 1 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    resolved.version = stored.version;

    await writeCache(orgId, resolved);
    return resolved;
  }) as Promise<ResolvedEntitlement>;
}

async function writeCache(orgId: string, value: ResolvedEntitlement): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { cacheService, isRedisEnabled } = require('../../config/redis');
    if (!isRedisEnabled) return;
    await cacheService.set(cacheKey(orgId), value, CACHE_TTL_SECONDS);
  } catch {
    // Cache failures must never break a request. Redis is optional here by
    // design — the snapshot in Mongo remains the source of truth.
  }
}

async function readCache(orgId: string): Promise<ResolvedEntitlement | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { cacheService, isRedisEnabled } = require('../../config/redis');
    if (!isRedisEnabled) return null;
    return (await cacheService.get(cacheKey(orgId))) as ResolvedEntitlement | null;
  } catch {
    return null;
  }
}

/**
 * The entitlement for an organization: cache, then snapshot, then resolve.
 *
 * The three-step fallback matters because the first request after a deploy has
 * a cold cache, and the first request for a brand-new organization has no
 * snapshot either. Neither should fail.
 */
export async function getEntitlement(orgId: string): Promise<ResolvedEntitlement> {
  const cached = await readCache(orgId);
  if (cached) return cached;

  const stored = await withoutTenantScope('entitlements:read', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const EntitlementModel = require('../../models/Entitlement').default;
    return EntitlementModel.findOne({ orgId }).lean();
  });

  if (stored) {
    const value: ResolvedEntitlement = {
      orgId,
      modules: (stored as { modules: string[] }).modules ?? [],
      limits: (stored as { limits: Record<string, number> }).limits ?? {},
      status: (stored as { status: string }).status,
      writable: (stored as { writable: boolean }).writable !== false,
      version: (stored as { version: number }).version ?? 1,
      resolvedAt: (stored as { resolvedAt: Date }).resolvedAt ?? new Date(),
    };
    await writeCache(orgId, value);
    return value;
  }

  return resolveEntitlement(orgId, 'lazy-first-read');
}

/** Drop the cached snapshot — call after any subscription write. */
export async function invalidateEntitlement(orgId: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { cacheService, isRedisEnabled } = require('../../config/redis');
    if (!isRedisEnabled) return;
    await cacheService.del(cacheKey(orgId));
  } catch {
    /* best effort */
  }
}

export function isCoreKey(key: string): boolean {
  return (CORE_MODULE_KEYS as readonly string[]).includes(key);
}
