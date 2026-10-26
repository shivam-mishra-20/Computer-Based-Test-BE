/**
 * Which browser origins may call this API — explicitly configured, nothing else.
 *
 * ── What this replaced ──────────────────────────────────────────────────────
 * Every `*.vercel.app` and `*.railway.app` origin was allowed, with
 * credentials. Anyone can host a page under those suffixes. No credential
 * travels in a cookie today, so it exposed no session — but "any website on two
 * public hosting platforms" is not a trust boundary, and the first cookie added
 * would have made it one.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *   exact       an origin listed in CORS_ORIGIN (scheme + host + port, exactly)
 *   preview     a host ending in a suffix listed in CORS_PREVIEW_SUFFIXES — a
 *               team's OWN preview namespace (e.g. `-acme.vercel.app`), never a
 *               bare platform suffix: `.vercel.app` alone is refused at config
 *   localhost   http://localhost / 127.0.0.1 on any port — only when
 *               NODE_ENV is not "production"
 *   org domain  on the platform realm, a host listed in an organization's own
 *               `domains` (set by platform staff) — the caller checks this, as
 *               it needs the database
 *
 * ── Rollout switch ──────────────────────────────────────────────────────────
 * CORS_LEGACY_WILDCARDS=true restores the old `*.vercel.app`/`*.railway.app`
 * allowance, and every origin let in ONLY by it is logged — so production can
 * deploy this, read which real frontends still depend on the wildcard, add them
 * to CORS_ORIGIN, and then drop the switch. Absent, the policy is strict.
 *
 * Pure (configuration in, verdict out): scripts/safety/ops-hardening.test.ts.
 */

export interface CorsPolicy {
  origins: Set<string>;
  previewSuffixes: string[];
  allowLocalhost: boolean;
  legacyWildcards: boolean;
}

export type CorsVerdict =
  | 'allow'
  | 'allow-legacy'
  | 'check-org-domain'
  | 'deny';

/** Used only when CORS_ORIGIN is unset — the origins this API has always served. */
export const DEFAULT_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'https://computer-based-test.vercel.app',
  'https://examease-pi.vercel.app',
  'https://computer-based-test-be-production.up.railway.app',
  'https://abhigyangurukul.com',
  'https://www.abhigyangurukul.com',
  'http://abhigyangurukul.com',
  'http://www.abhigyangurukul.com',
];

const PUBLIC_PLATFORM_SUFFIXES = [
  '.vercel.app',
  '.railway.app',
  '.up.railway.app',
  '.netlify.app',
  '.onrender.com',
];

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/** A preview suffix must name a team's own namespace, not a whole hosting platform. */
export function isAcceptableSuffix(suffix: string): boolean {
  const s = suffix.trim().toLowerCase();
  if (!s || !/^[-.a-z0-9]+$/.test(s)) return false;
  return !PUBLIC_PLATFORM_SUFFIXES.includes(s.startsWith('.') ? s : `.${s}`);
}

export function corsPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CorsPolicy {
  const listed = (env.CORS_ORIGIN || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const raw = env.CORS_ORIGIN ? listed : DEFAULT_ORIGINS;
  const origins = new Set(
    raw.map(normalizeOrigin).filter((o): o is string => Boolean(o)),
  );
  const previewSuffixes = (env.CORS_PREVIEW_SUFFIXES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(isAcceptableSuffix);
  return {
    origins,
    previewSuffixes,
    allowLocalhost: (env.NODE_ENV || '').trim().toLowerCase() !== 'production',
    legacyWildcards:
      (env.CORS_LEGACY_WILDCARDS || '').trim().toLowerCase() === 'true',
  };
}

/** The verdict for an Origin header that is present (no Origin is the caller's concern). */
export function corsVerdict(origin: string, policy: CorsPolicy): CorsVerdict {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return 'deny';
  if (policy.origins.has(normalized)) return 'allow';
  const url = new URL(normalized);
  const host = url.hostname;
  if (policy.allowLocalhost && (host === 'localhost' || host === '127.0.0.1'))
    return 'allow';
  if (
    url.protocol === 'https:' &&
    policy.previewSuffixes.some((suffix) => host.endsWith(suffix))
  )
    return 'allow';
  if (
    policy.legacyWildcards &&
    (host.endsWith('.vercel.app') || host.endsWith('.railway.app'))
  )
    return 'allow-legacy';
  return url.protocol === 'https:' ? 'check-org-domain' : 'deny';
}
