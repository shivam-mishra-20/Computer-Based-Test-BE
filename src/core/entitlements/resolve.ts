/**
 * Entitlement resolution — turning a commercial record into an answer.
 *
 *   plan terms (the PlanVersion the subscription was sold) ∪ addOns − removals,
 *   then overrides applied LAST
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
  /** When the subscription next changes by itself; a read after it re-resolves. */
  nextTransitionAt?: Date | null;
  /** Whether `limits` are enforced (a lifecycle-managed subscription), or only shown. */
  limitsEnforced?: boolean;
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
 * neither is ever invoiced. Either flag — on the Org or on its Subscription —
 * is enough, so no lifecycle state of a subscription can downgrade them.
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
    nextTransitionAt: null,
  };
}

/**
 * The entitlement for an organization with NO subscription record, created
 * before subscriptions existed (no `subscriptionRequired` marker).
 *
 * ── The most consequential default in this file ─────────────────────────────
 * If "no subscription" resolved to "no modules" for these, every route carrying
 * `requireModule()` would begin returning 403 the moment this shipped — the
 * same class of outage as the defaulted-pinned 503, and for the same reason:
 * a safe default for COMMERCE is not a safe default for BEHAVIOUR.
 *
 * So an existing, unsubscribed organization keeps everything until the
 * platform decides how to bring it onto a plan — a deliberate act by platform
 * staff, never a side effect of deploying this code.
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
    nextTransitionAt: null,
  };
}

/**
 * The entitlement for an organization the platform created after
 * subscriptions existed, before it has one: core modules only.
 *
 * Approval creates an organization; it does not sell it anything. A paid module
 * appears when a subscription — a trial or a payment — grants it, and if
 * creating that subscription fails part way, the organization is left with
 * less, never with everything.
 */
function unassignedEntitlement(orgId: string): ResolvedEntitlement {
  return {
    orgId,
    modules: expandDependencies([]),
    limits: {},
    status: 'unassigned',
    writable: true,
    version: 0,
    resolvedAt: new Date(),
    nextTransitionAt: null,
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
 * The pure decision: which entitlement an organization gets, from what is on
 * record. Exported so every branch is testable without a database.
 */
export function decideEntitlement(input: {
  orgId: string;
  org: { status?: string; isPlatformOwned?: boolean; subscriptionRequired?: boolean } | null;
  subscription: {
    status: string;
    isPlatformOwned?: boolean;
    /** Set when the lifecycle manages it — see Subscription.managedSince. */
    managedSince?: Date | null;
    addOns?: string[];
    removals?: string[];
    overrides?: { modules?: string[]; limits?: Record<string, number> };
  } | null;
  terms: { modules?: string[]; limits?: Record<string, number> } | null;
  nextTransitionAt?: Date | null;
  writableStatuses: string[];
}): ResolvedEntitlement {
  const { orgId, org, subscription, terms } = input;

  /**
   * TWO independent statuses gate writability, and both must permit it.
   *
   *   Org.status           the tenant lifecycle, controlled by platform staff
   *   Subscription.status  the commercial state
   *
   * They are genuinely different questions. Suspending an ORGANIZATION is an
   * administrative act — a compliance hold, an offboarding — and it must block
   * writes even while the subscription still reads `active`.
   */
  const orgStatus = org?.status;
  const orgPermitsWrites = !orgStatus || input.writableStatuses.includes(orgStatus);

  if (org?.isPlatformOwned || subscription?.isPlatformOwned) {
    const resolved = platformOwnedEntitlement(orgId, subscription?.status ?? orgStatus ?? 'platform_owned');
    resolved.writable = orgPermitsWrites;
    return resolved;
  }

  if (!subscription) {
    const resolved = org?.subscriptionRequired ? unassignedEntitlement(orgId) : unsubscribedEntitlement(orgId);
    // An org suspended before it was ever subscribed must still be read-only.
    resolved.writable = orgPermitsWrites;
    if (orgStatus && !org?.subscriptionRequired) resolved.status = orgStatus;
    return resolved;
  }

  /**
   * Only a subscription the lifecycle MANAGES has its status and limits
   * enforced. One written before the lifecycle existed was never held to
   * either — its `writable: false` was computed but enforced nowhere, and its
   * limits were display-only — so it keeps exactly that access until staff act
   * on it. Deploying enforcement must not, by itself, change what an existing
   * organization can do. Modules were always enforced and still are.
   */
  const managed = Boolean(subscription.managedSince);

  return {
    orgId,
    modules: computeModules({
      planModules: terms?.modules ?? [],
      addOns: subscription.addOns,
      removals: subscription.removals,
      overrideModules: subscription.overrides?.modules,
    }),
    limits: computeLimits(terms?.limits ?? {}, subscription.overrides?.limits ?? {}),
    status: subscription.status,
    writable: managed ? input.writableStatuses.includes(subscription.status) && orgPermitsWrites : orgPermitsWrites,
    version: 0,
    resolvedAt: new Date(),
    nextTransitionAt: managed ? input.nextTransitionAt ?? null : null,
    limitsEnforced: managed,
  };
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
    const EntitlementModel = require('../../models/Entitlement').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { WRITABLE_STATUSES } = require('../../models/Subscription');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Org = require('../../models/Org').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { termsForSubscription } = require('../subscriptions/catalogue');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { nextTransitionAt } = require('../subscriptions/lifecycle');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { stateOf } = require('../subscriptions/service');

    const [subscription, org] = await Promise.all([
      Subscription.findOne({ orgId }).lean(),
      Org.findById(orgId).select('status isPlatformOwned subscriptionRequired').lean(),
    ]);

    const terms = subscription && !subscription.isPlatformOwned ? await termsForSubscription(subscription) : null;
    const resolved = decideEntitlement({
      orgId,
      org,
      subscription,
      terms,
      nextTransitionAt: subscription ? nextTransitionAt(stateOf(subscription)) : null,
      writableStatuses: WRITABLE_STATUSES,
    });

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
          nextTransitionAt: resolved.nextTransitionAt ?? null,
          limitsEnforced: Boolean(resolved.limitsEnforced),
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
 * Has the subscription behind this snapshot changed by itself since it was
 * resolved? A trial that ended at 09:00 must be over at 09:00 — not at the
 * next daily sweep, and not never on a deployment where the sweep is off.
 */
function isStale(value: ResolvedEntitlement, now = Date.now()): boolean {
  if (!value.nextTransitionAt) return false;
  const at = new Date(value.nextTransitionAt).getTime();
  return Number.isFinite(at) && at <= now;
}

async function catchUp(orgId: string, value: ResolvedEntitlement): Promise<ResolvedEntitlement> {
  if (!isStale(value)) return value;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { advanceSubscription } = require('../subscriptions/service');
    const { events } = await advanceSubscription(orgId);
    // Nothing moved (already advanced elsewhere): refresh the snapshot anyway,
    // so a stale nextTransitionAt is not re-checked on every request.
    return events.length ? (await getStoredEntitlement(orgId)) ?? value : resolveEntitlement(orgId, 'lazy-catch-up');
  } catch (error) {
    // The clock failing to move is not a reason to fail the request; the
    // sweep, or the next read, will try again.
    console.error(`[entitlements] catch-up failed for org ${orgId}:`, (error as Error).message);
    return value;
  }
}

async function getStoredEntitlement(orgId: string): Promise<ResolvedEntitlement | null> {
  const stored = await withoutTenantScope('entitlements:read', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const EntitlementModel = require('../../models/Entitlement').default;
    return EntitlementModel.findOne({ orgId }).lean();
  });
  if (!stored) return null;
  const value: ResolvedEntitlement = {
    orgId,
    modules: (stored as { modules: string[] }).modules ?? [],
    limits: (stored as { limits: Record<string, number> }).limits ?? {},
    status: (stored as { status: string }).status,
    writable: (stored as { writable: boolean }).writable !== false,
    version: (stored as { version: number }).version ?? 1,
    resolvedAt: (stored as { resolvedAt: Date }).resolvedAt ?? new Date(),
    nextTransitionAt: (stored as { nextTransitionAt?: Date | null }).nextTransitionAt ?? null,
    limitsEnforced: (stored as { limitsEnforced?: boolean }).limitsEnforced === true,
  };
  await writeCache(orgId, value);
  return value;
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
  if (cached) return catchUp(orgId, cached);

  const stored = await getStoredEntitlement(orgId);
  if (stored) return catchUp(orgId, stored);

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
