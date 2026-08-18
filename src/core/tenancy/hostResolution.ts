/**
 * Resolving an organization BEFORE anyone has logged in.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * `tenantContextMiddleware`'s docstring says a host or header is consulted
 * "when there is no token at all, which is the pre-authentication case (login
 * needs to know which organization to authenticate against before a token
 * exists)". The code did not actually do that: the hint was computed, used only
 * to detect a claim/host mismatch, and then discarded.
 *
 * Two things break without it:
 *
 *   1. Login is ambiguous. `User.email` is unique per organization now
 *      (`{ orgId, email }`), so two institutes may legitimately hold the same
 *      address. `User.findOne({ email })` with no context returns whichever
 *      document the index reaches first — a coin flip that authenticates
 *      someone into the wrong tenant.
 *
 *   2. A login page cannot be branded. Colours and a logo have to be on screen
 *      before the credential that would reveal them is submitted.
 *
 * ── Why a cache ─────────────────────────────────────────────────────────────
 * This runs on every unauthenticated request, including static-ish ones. A
 * database round trip there would be a new per-request cost on the hot path for
 * a value that changes when someone edits a domain list — which is close to
 * never. Sixty seconds is short enough that a domain change takes effect while
 * an admin is still watching, and long enough that the lookup is not a cost.
 *
 * Negative results are cached too, and deliberately: an unknown Host is what a
 * scanner or a stray CDN probe produces, and re-querying for each one is how a
 * cache becomes an amplifier.
 */

const TTL_MS = 60_000;

interface CacheEntry {
  orgId: string | null;
  at: number;
}

const cache = new Map<string, CacheEntry>();

/** Exposed for tests, and for an admin-triggered invalidation later. */
export function clearHostResolutionCache(): void {
  cache.clear();
}

/** `Abhigyan.Example.com:3000` -> `abhigyan.example.com` */
export function normalizeHost(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const host = String(raw).trim().toLowerCase().split(',')[0].trim();
  if (!host) return null;
  const withoutPort = host.replace(/:\d+$/, '');
  if (!withoutPort) return null;
  // Loopback and bare `localhost` identify a developer machine, never a tenant.
  // Returning them would make every local request look like an attempt to reach
  // an organization named "localhost", and the miss would be cached.
  if (
    withoutPort === 'localhost' ||
    withoutPort === '127.0.0.1' ||
    withoutPort === '::1' ||
    withoutPort === '0.0.0.0'
  ) {
    return null;
  }
  return withoutPort;
}

/**
 * Resolve an organization id from an explicit header or a request Host.
 *
 * `X-Org-Id` wins because it is explicit: it is what a client that already
 * knows its organization sends, and what the E2E harness uses to drive two
 * tenants through one deployment without a DNS entry for either. It is only a
 * ROUTING hint — it grants nothing, and any authenticated request re-derives
 * the organization from the signed claim instead.
 */
export async function resolveOrgFromRequest(input: {
  header?: string | null;
  host?: string | null;
}): Promise<string | null> {
  const explicit = (input.header || '').trim();
  const host = normalizeHost(input.host);
  const key = explicit ? `h:${explicit.toLowerCase()}` : host ? `d:${host}` : null;
  if (!key) return null;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.orgId;

  let orgId: string | null = null;
  try {
    // Required lazily: this module is imported by middleware that loads before
    // the models are compiled.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Org = require('../../models/Org').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { withoutTenantScope } = require('./context');

    const found = await withoutTenantScope('tenancy:resolve-org-from-request', async () => {
      if (explicit) {
        // An id, or a slug. Both are stable public identifiers; accepting either
        // means a caller does not have to know which one it holds.
        return Org.findOne({
          $or: [{ _id: explicit }, { slug: explicit.toLowerCase() }],
        })
          .select('_id')
          .lean()
          .catch(() => Org.findOne({ slug: explicit.toLowerCase() }).select('_id').lean());
      }
      return Org.findOne({ domains: host }).select('_id').lean();
    });

    orgId = found ? String((found as { _id: unknown })._id) : null;
  } catch {
    // A failed lookup must not fail the request. No context is the pre-existing
    // behaviour, and every path below this one already handles it.
    orgId = null;
  }

  cache.set(key, { orgId, at: Date.now() });
  return orgId;
}
