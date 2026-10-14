/**
 * Does the address an app is about to be built with reach THIS organization?
 *
 * ── Why a build checks it ───────────────────────────────────────────────────
 * The API address is compiled into the APK. When it points at a server that
 * answers but does not hold the organization — `/api` on a shared host, which
 * is the existing Abhigyan system rather than the platform (`/platform-api`);
 * a staging server; a typo'd host that happens to resolve — every screen that
 * needs the institute quietly falls back: sign-in fails, branding is generic,
 * and the register screen says "Accounts are created for you" while the
 * console says registration is open. Nothing about the build itself fails, so
 * nothing would tell anyone until a student did.
 *
 * So readiness asks the address the same question the app asks first —
 * `GET <address>/org/branding` with the app's own organization hint — and
 * compares the answer with the organization being built.
 *
 * ── What blocks a build, and what only warns ────────────────────────────────
 * A server that ANSWERS with no organization, or another one, is a certain
 * fault: the build is refused, with the fix. A server that cannot be reached
 * from here, or answers something unexpected, may be fine from a phone (a
 * firewall, a server not started yet), so that is a warning and the build may
 * go ahead.
 *
 * ── Bounded ─────────────────────────────────────────────────────────────────
 * One GET, four seconds, no redirects followed, body read only as JSON and
 * only the organization id compared. Answers are remembered for a minute so a
 * console polling readiness does not probe on every render.
 */

export type ApiConnectionState = 'ok' | 'mismatch' | 'unreachable' | 'unexpected' | 'skipped';

export interface ApiConnection {
  state: ApiConnectionState;
  /** The address that was checked, as it will be compiled in. */
  url: string;
  /** One sentence an operator can act on. Empty when `ok` or `skipped`. */
  detail: string;
}

const TIMEOUT_MS = 4_000;
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; result: ApiConnection }>();

/** The `/platform-api` form of an address ending in `/api`, or null. */
function platformFormOf(base: string): string | null {
  return /\/api$/.test(base) ? base.replace(/\/api$/, '/platform-api') : null;
}

export async function checkApiConnection(input: {
  apiBaseUrl: string;
  orgId: string;
  /** The routing hint a dedicated build sends: its slug, else its id. */
  orgHint: string;
  /** The Android package / iOS bundle id, sent as the app sends it. */
  appId?: string;
}): Promise<ApiConnection> {
  const base = String(input.apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  // An address the build rules already refuse is reported by them, once.
  if (!/^https?:\/\/[^/]+/i.test(base)) return { state: 'skipped', url: base, detail: '' };

  const key = `${base}|${input.orgId}|${input.orgHint}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;

  const result = await probe(base, input);
  cache.set(key, { at: Date.now(), result });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  return result;
}

async function probe(
  base: string,
  input: { orgId: string; orgHint: string; appId?: string },
): Promise<ApiConnection> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Org-Id': input.orgHint || input.orgId };
  if (input.appId) headers['X-App-Id'] = input.appId;

  let response: Response;
  try {
    response = await fetch(`${base}/org/branding`, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const why = (err as Error)?.name === 'TimeoutError' ? 'no answer within 4 seconds' : 'the connection failed';
    return {
      state: 'unreachable',
      url: base,
      detail: `Could not reach ${base} from this server (${why}). The app will use this address — make sure it is the platform API and that it is reachable from a phone.`,
    };
  }

  if (response.status >= 300 && response.status < 400) {
    return {
      state: 'unexpected',
      url: base,
      detail: `${base} redirects elsewhere (HTTP ${response.status}). The app does not follow that for every request — use the final address.`,
    };
  }
  if (!response.ok) {
    const suggestion = platformFormOf(base);
    return {
      state: 'unexpected',
      url: base,
      detail:
        `${base} answered HTTP ${response.status} where the platform API answers 200.` +
        (suggestion ? ` If this host also runs the existing system, the platform address is ${suggestion}.` : ''),
    };
  }

  let found: { id?: unknown; slug?: unknown } | null = null;
  try {
    const body = (await response.json()) as { organization?: { id?: unknown; slug?: unknown } | null };
    found = body?.organization ?? null;
  } catch {
    return {
      state: 'unexpected',
      url: base,
      detail: `${base} answered, but not like the platform API (no JSON). Check that the address ends in /platform-api.`,
    };
  }

  if (found && String(found.id ?? '') === String(input.orgId)) {
    return { state: 'ok', url: base, detail: '' };
  }

  const suggestion = platformFormOf(base);
  const consequence =
    'An app built with it would not find its institute: sign-in, branding and registration would all fail, ' +
    'and the register screen would say accounts are created for you.';
  const fix = suggestion
    ? `It ends in /api, which on a shared server is the existing system — set the API base URL to ${suggestion}.`
    : 'Set the API base URL to the platform API of the server that holds this organization.';
  return {
    state: 'mismatch',
    url: base,
    detail: found
      ? `${base} answers for a different organization (${String(found.slug ?? found.id)}). ${consequence} ${fix}`
      : `${base} is reachable but does not know this organization. ${consequence} ${fix}`,
  };
}
