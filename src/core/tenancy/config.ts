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
 * The organization that owns data written before organizations existed.
 *
 * Every document written before tenancy carries no `orgId`, and every one of
 * them belongs to the institute the platform grew out of — there was no other.
 * That is what makes `{ orgId: X }` unsafe as a blanket read filter during the
 * migration (it would hide those rows from their owner) and what makes it SAFE
 * for everyone else: no other organization has any un-attributed data to lose.
 *
 *   LEGACY_DATA_ORG_ID   explicit, for a claim-mode deployment that still serves
 *                        the legacy institute's un-backfilled users.
 *   pinned mode          the pinned organization — api-legacy IS that institute.
 *   otherwise            none: un-attributed rows are visible to nobody.
 */
export function legacyDataOrgId(): string | null {
  const explicit = (process.env.LEGACY_DATA_ORG_ID || '').trim();
  if (explicit) return explicit;
  return tenantMode() === 'pinned' ? pinnedOrgId() : null;
}

export type ReadScope = 'none' | 'strict' | 'legacy-inclusive';

/**
 * How reads are narrowed for a request scoped to `orgId`.
 *
 * ── Why this no longer waits for `enforce` ──────────────────────────────────
 * It used to: reads were filtered ONLY under enforce, and under warn the plugin
 * observed and changed nothing. That protected the legacy institute's
 * un-backfilled rows, and it also meant that on a multi-tenant deployment one
 * organization's administrator could list — and approve — another
 * organization's users. Measured, not theorised: 11 of 17 admin endpoints
 * leaked, and a cross-tenant approval succeeded.
 *
 * Both concerns are answered by scoping the filter to WHO is asking:
 *
 *   strict            `{ orgId: X }`. Every organization except the legacy
 *                     owner — they were created through onboarding, which stamps
 *                     everything, so there is nothing un-attributed to lose.
 *   legacy-inclusive  `{ orgId: X or none }`. The legacy owner only, and only
 *                     until enforce: its own rows plus the un-attributed ones
 *                     (which are, by construction, its own), and never another
 *                     organization's.
 *   none              No tenant (pre-migration production, an explicit
 *                     `withoutTenantScope`) or `TENANT_ENFORCEMENT=off`, the
 *                     documented emergency escape hatch.
 *
 * `warn` therefore still means "do not throw on a missing context" and "the
 * backfill has not run" — it no longer means "a known tenant may read other
 * tenants' data". No tenant-facing request depends on `enforce` for isolation.
 */
export function readScopeFor(orgId: string | null | undefined): ReadScope {
  if (!orgId) return 'none';
  const enforcement = tenantEnforcement();
  if (enforcement === 'off') return 'none';
  if (enforcement === 'enforce') return 'strict';
  return orgId === legacyDataOrgId() ? 'legacy-inclusive' : 'strict';
}

/** The filter `readScopeFor` describes, ready to merge into a query; null for none. */
export function readFilterFor(orgId: string | null | undefined): Record<string, unknown> | null {
  switch (readScopeFor(orgId)) {
    case 'strict':
      return { orgId };
    case 'legacy-inclusive':
      // `$in` with null matches a missing field as well as an explicit null.
      return { orgId: { $in: [orgId, null] } };
    default:
      return null;
  }
}

/**
 * Are reads for a known tenant filtered at all? True in every mode but `off`.
 *
 * Kept for callers that only need the yes/no; the shape of the filter comes
 * from `readFilterFor`, because it differs for the legacy owner.
 */
export function shouldFilterReads(): boolean {
  return tenantEnforcement() !== 'off';
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

/**
 * May a file be stored without an organization?
 *
 * ── Why this is a question at all ───────────────────────────────────────────
 * `putTenantFile` is unconditionally fail-closed: no organization, no write.
 * That is right for a deployment whose isolation is live, and wrong for the one
 * serving abhigyan-gurukul-app today, where there is no organization on most
 * requests and never has been. Homework uploads started returning
 * STORAGE_ACCESS_DENIED for a guarantee the deployment is not yet making.
 *
 * ── Why it is tied to enforcement and not a new flag ────────────────────────
 * `TENANT_ENFORCEMENT=enforce` already means exactly the thing being asked
 * here: the backfill has run, every document carries an orgId, reads are
 * filtered and a missing context throws. A deployment in that state must not
 * accept an unattributed file — there is no legacy surface left to be
 * compatible with.
 *
 * Under `warn` — today's production, and every developer machine — isolation is
 * explicitly NOT being relied upon: the plugin does not filter a single read.
 * Refusing a write there enforces, in one subsystem only, a guarantee the rest
 * of the system is not making, which is how a storage change took down an
 * unrelated feature.
 *
 * So this is not a new global boolean. It is a reading of the switch that
 * already exists, and flipping that switch turns the compatibility path off
 * along with everything else it turns on.
 */
export function legacyStorageCompatEnabled(): boolean {
  return tenantEnforcement() !== 'enforce';
}

/** One-line summary for the startup banner, so misconfiguration is visible. */
export function describeTenancy(): string {
  const mode = tenantMode();
  const enforcement = tenantEnforcement();
  const org = mode === 'pinned' ? pinnedOrgId() ?? '<UNSET>' : 'from token claim';
  return `TENANT_MODE=${mode} TENANT_ENFORCEMENT=${enforcement} org=${org} cron=${shouldRunScheduledJobs() ? 'on' : 'off'}`;
}
