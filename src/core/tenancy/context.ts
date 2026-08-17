/**
 * The tenant context — who this unit of work belongs to.
 *
 * Backed by AsyncLocalStorage so it follows the request through every await,
 * every service call and every callback without being threaded through 805
 * function signatures by hand. That is the entire reason this approach was
 * chosen: editing 805 call sites means missing some, and a missed call site is
 * a cross-tenant read.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * Every unit of work that touches the database runs inside `runWithTenant`.
 * Requests get one from middleware. Background jobs open their OWN from the
 * job payload — never inheriting whatever happened to be open when they were
 * enqueued, which would attribute Tenant A's job to whoever triggered the
 * processing tick.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  /** The organization every query in this unit of work is scoped to. */
  orgId: string;
  /** Optional partition inside the org. Schema-level only in P1. */
  branchId?: string | null;
  /** Present for request-bound work; absent for cron and system jobs. */
  userId?: string | null;
  /** Where this context came from — invaluable when debugging a leak. */
  source: 'pinned' | 'claim' | 'job' | 'cron' | 'script' | 'test';
}

/** An explicitly unscoped unit of work. See `withoutTenantScope`. */
export interface UnscopedContext {
  unscoped: true;
  /** Mandatory justification, so `grep` produces a complete audit list. */
  reason: string;
}

type Store = TenantContext | UnscopedContext;

const storage = new AsyncLocalStorage<Store>();

export function isUnscoped(store: Store | undefined): store is UnscopedContext {
  return Boolean(store && (store as UnscopedContext).unscoped === true);
}

/** The active context, or undefined when there is none. */
export function getStore(): Store | undefined {
  return storage.getStore();
}

/** The active tenant context, or null when absent or explicitly unscoped. */
export function getTenantContext(): TenantContext | null {
  const store = storage.getStore();
  if (!store || isUnscoped(store)) return null;
  return store;
}

/** The active orgId, or null. Convenience for the plugin's hot path. */
export function currentOrgId(): string | null {
  return getTenantContext()?.orgId ?? null;
}

/** True when the caller has deliberately opted out of scoping. */
export function inUnscopedBlock(): boolean {
  return isUnscoped(storage.getStore());
}

/** The reason string of the active unscoped block, for logging. */
export function unscopedReason(): string | null {
  const store = storage.getStore();
  return isUnscoped(store) ? store.reason : null;
}

/**
 * Run `fn` inside a tenant context. Everything it touches is scoped to `orgId`.
 */
export function runWithTenant<T>(context: TenantContext, fn: () => T): T {
  if (!context.orgId) {
    throw new Error('runWithTenant requires a non-empty orgId — refusing to open an empty context.');
  }
  return storage.run(context, fn);
}

/**
 * The ONLY sanctioned way to run an unscoped query.
 *
 * `reason` is mandatory and is expected to be a stable identifier, because the
 * complete list of legitimate bypasses has to be reviewable:
 *
 *     grep -rn "withoutTenantScope(" src/
 *
 * Legitimate cases are narrow and mostly pre-authentication — resolving which
 * organization an email belongs to necessarily happens before there is a
 * context to resolve it in. Everything else should be scoped.
 *
 * Nesting inside a tenant context is allowed and deliberately does not warn:
 * a scoped request may still need one global lookup, and forcing it to unwind
 * the context first would be worse.
 */
export function withoutTenantScope<T>(reason: string, fn: () => T): T {
  if (!reason || !reason.trim()) {
    throw new Error(
      'withoutTenantScope requires a reason. It exists so every bypass is greppable and reviewable.',
    );
  }
  return storage.run({ unscoped: true, reason: reason.trim() }, fn);
}

/**
 * Run `fn` with NO context at all.
 *
 * Used by tests to prove the plugin fails closed. Not for production code —
 * production either has a tenant or explicitly opts out with a reason.
 */
export function runWithoutAnyContext<T>(fn: () => T): T {
  return storage.exit(fn);
}
