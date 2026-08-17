/**
 * Tenancy runtime configuration.
 *
 * ONE codebase produces two deployments. Which one this process is depends
 * entirely on environment, never on a build flag or a separate branch:
 *
 *   api-legacy    TENANT_MODE=pinned  ORG_ID=<org 001>
 *                 Serves abhigyan-gurukul-app. The tenant context is fixed by
 *                 configuration, so requests from a client that knows nothing
 *                 about organizations still run inside a real context.
 *
 *   api-platform  TENANT_MODE=claim
 *                 Serves the new clients. Tenancy comes from the signed token.
 *
 * `pinned` is NOT a "default org" fallback. The distinction matters and is the
 * whole reason the fail-closed rule survives: in pinned mode a context is
 * always present and always explicit; there is no code path where a missing
 * context silently resolves to an organization.
 */

export type TenantMode = 'pinned' | 'claim';

/**
 * How strictly the Mongoose plugin behaves.
 *
 *   off      plugin inert. Escape hatch for an emergency; not a normal setting.
 *   warn     OBSERVE ONLY. Reads are never modified, writes are stamped.
 *            This is what makes the migration safe to deploy — see the comment
 *            on `shouldFilterReads` for why filtering must not happen yet.
 *   enforce  Reads filtered by orgId, writes stamped, missing context throws.
 */
export type TenantEnforcement = 'off' | 'warn' | 'enforce';

function readEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  console.warn(
    `[tenancy] ${name}="${raw}" is not one of ${allowed.join('|')} — falling back to "${fallback}".`,
  );
  return fallback;
}

/**
 * Defaults are deliberately the SAFEST values, not the most useful ones.
 *
 * A process started with no tenancy environment at all — a script, a one-off
 * container, a developer's machine — behaves exactly as it did before this
 * module existed: pinned mode with warn enforcement changes no query results.
 * Getting the environment wrong therefore degrades to today's behaviour rather
 * than to a broken or a leaky one.
 */
export function tenantMode(): TenantMode {
  return readEnum<TenantMode>('TENANT_MODE', ['pinned', 'claim'], 'pinned');
}

export function tenantEnforcement(): TenantEnforcement {
  return readEnum<TenantEnforcement>('TENANT_ENFORCEMENT', ['off', 'warn', 'enforce'], 'warn');
}

/**
 * The organization this process is pinned to, in `pinned` mode.
 *
 * Returns null when unset. Callers must treat null as "cannot establish a
 * context" rather than inventing one.
 */
export function pinnedOrgId(): string | null {
  const raw = (process.env.ORG_ID || '').trim();
  return raw || null;
}

/**
 * Reads are filtered ONLY under enforce.
 *
 * This is the single most important line in the migration. During the warn
 * period `orgId` has not been backfilled yet, so most documents do not carry
 * the field. Adding `{ orgId: X }` to a read at that point matches nothing and
 * every screen in production goes blank — the exact catastrophe warn mode
 * exists to avoid. Observation must not change results.
 */
export function shouldFilterReads(): boolean {
  return tenantEnforcement() === 'enforce';
}

/**
 * Writes are stamped under warn AND enforce.
 *
 * Stamping is additive: it sets a field on documents being created anyway, and
 * nothing reads that field until enforce. Doing it during the warn period means
 * every document written from the moment this ships already carries its orgId,
 * which shrinks the backfill to pre-existing rows and removes the race where
 * a document created mid-backfill is missed.
 */
export function shouldStampWrites(): boolean {
  return tenantEnforcement() !== 'off';
}

/** Missing context is fatal only under enforce; under warn it is logged. */
export function shouldThrowOnMissingContext(): boolean {
  return tenantEnforcement() === 'enforce';
}

/**
 * Was TENANT_MODE *explicitly* set to pinned, as opposed to defaulting to it?
 *
 * The distinction is load-bearing and is not a style preference. `tenantMode()`
 * defaults to `pinned` because that is the safest tenancy behaviour — but
 * today's production sets no TENANT_MODE at all, so deriving "this is the
 * legacy deployment, disable cron" from the defaulted value would switch off
 * the attendance syncs and the EOD reminder on the live system the moment this
 * ships. Cron may only be disabled by a deliberate act.
 */
export function isExplicitlyPinned(): boolean {
  return (process.env.TENANT_MODE || '').trim().toLowerCase() === 'pinned';
}

/**
 * Has tenancy been deliberately configured on this process at all?
 *
 * False means "pre-migration": the deployment predates tenancy configuration
 * and must behave exactly as it did before. Today's production sets none of
 * these variables, so this is the state the live system is in right now.
 *
 * This distinction is load-bearing and has already caught the same class of bug
 * twice — once where a defaulted `pinned` mode would have silently disabled
 * cron, and once where it would have made the request middleware 503 EVERY
 * request. A safe default for tenancy is not automatically a safe default for
 * behaviour, and the two must be decided separately.
 */
export function tenancyConfigured(): boolean {
  return Boolean(
    (process.env.TENANT_MODE || '').trim() ||
      (process.env.ORG_ID || '').trim() ||
      (process.env.TENANT_ENFORCEMENT || '').trim(),
  );
}

/**
 * Cron runs everywhere EXCEPT a deployment explicitly pinned as api-legacy.
 *
 * If both deployments scheduled the same jobs, Abhigyan would receive two
 * attendance syncs and two EOD reminders a day. Duplicate side effects look
 * like data corruption and are miserable to trace back to their cause.
 */
export function shouldRunScheduledJobs(): boolean {
  if ((process.env.ENABLE_CRON || '').trim().toLowerCase() === 'false') return false;
  return !isExplicitlyPinned();
}

/** One-line summary for the startup banner, so misconfiguration is visible. */
export function describeTenancy(): string {
  const mode = tenantMode();
  const enforcement = tenantEnforcement();
  const org = mode === 'pinned' ? pinnedOrgId() ?? '<UNSET>' : 'from token claim';
  return `TENANT_MODE=${mode} TENANT_ENFORCEMENT=${enforcement} org=${org} cron=${shouldRunScheduledJobs() ? 'on' : 'off'}`;
}
