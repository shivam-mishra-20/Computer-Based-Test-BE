/**
 * The allowlist of routes permitted to run without a tenant context.
 *
 * ── Why an allowlist and not a flag on each route ───────────────────────────
 * A bypass scattered across ten route files is a bypass nobody can audit. This
 * file is the single answer to "what can run unscoped, and who decided that".
 * Every entry carries a reason string that reaches the logs, and the list is
 * asserted by a test, so adding one is a visible, reviewable act rather than a
 * one-line edit buried in a feature branch.
 *
 * ── When these apply ────────────────────────────────────────────────────────
 * ONLY in `claim` mode, and ONLY when no organization could be resolved. In
 * `pinned` mode (api-legacy) a context always exists, so these routes run
 * scoped to Org 001 — which is both correct and stricter. The bypass exists
 * for the genuine pre-authentication case: resolving which organization an
 * email belongs to necessarily happens before there is a context to resolve it
 * in.
 *
 * ── Classification ──────────────────────────────────────────────────────────
 *   pre-auth        Runs before a token exists. Must resolve an org itself.
 *   public-global   Genuinely public data, no tenant dimension.
 *   platform-global Platform operations, authenticated inside the handler.
 *   diagnostic      Health/liveness. Touches no tenant data.
 */

export type BypassClassification =
  | 'pre-auth'
  | 'public-global'
  | 'platform-global'
  | 'diagnostic';

export interface PublicRouteEntry {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | '*';
  /** Express-style path with `:params`. Matched against the full request path. */
  path: string;
  classification: BypassClassification;
  /** Reaches the logs via withoutTenantScope. Keep it stable and greppable. */
  reason: string;
  /** Why this is safe to run unscoped. Reviewed, not assumed. */
  justification: string;
}

export const PUBLIC_ROUTE_ALLOWLIST: PublicRouteEntry[] = [
  // ── Pre-authentication ───────────────────────────────────────────────────
  {
    method: 'POST',
    path: '/api/auth/login',
    classification: 'pre-auth',
    reason: 'auth:login-resolve-org',
    justification:
      'Credentials must be checked before an organization is known. The handler ' +
      'resolves the org from the matched account and issues a token carrying it.',
  },
  {
    method: 'POST',
    path: '/api/auth/register',
    classification: 'pre-auth',
    reason: 'auth:register',
    justification: 'Account creation precedes any session; the org comes from the invite or host.',
  },
  {
    method: 'POST',
    path: '/api/auth/public-register',
    classification: 'pre-auth',
    reason: 'auth:public-register',
    justification: 'Institute self-registration, pending admin approval. No session yet.',
  },
  {
    method: 'POST',
    path: '/api/auth/public-register-teacher',
    classification: 'pre-auth',
    reason: 'auth:public-register-teacher',
    justification:
      'Staff application form, submitted by someone with no account. Creates a ' +
      'pending record for admin review; grants no access on its own.',
  },
  {
    method: 'POST',
    path: '/api/auth/learner-register',
    classification: 'pre-auth',
    reason: 'auth:learner-register',
    justification:
      'Public learner signup. Belongs to the platform-owned public organization, ' +
      'which the handler assigns; there is no session at this point.',
  },
  {
    method: 'POST',
    path: '/api/auth/forgot-password',
    classification: 'pre-auth',
    reason: 'auth:forgot-password',
    justification: 'Reached by someone who cannot log in, so by definition has no context.',
  },
  {
    method: 'POST',
    path: '/api/auth/reset-password',
    classification: 'pre-auth',
    reason: 'auth:reset-password',
    justification: 'Authorised by a single-use emailed token, not by a session.',
  },
  {
    method: 'GET',
    path: '/api/auth/public-student-batch-config',
    classification: 'pre-auth',
    reason: 'auth:public-batch-config',
    justification:
      'Populates the registration form before an account exists. Returns configuration, ' +
      'never student data. NOTE: becomes per-org config in P4 and should leave this list then.',
  },

  // ── Public / guest flows ─────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/class-requests/options',
    classification: 'public-global',
    reason: 'public:class-request-options',
    justification: 'Dropdown options for the guest enquiry form. No tenant data.',
  },
  {
    method: 'GET',
    path: '/api/scholarship/tests',
    classification: 'public-global',
    reason: 'public:scholarship-browse',
    justification: 'Scholarship tests are deliberately open to prospective students with no account.',
  },
  {
    method: 'GET',
    path: '/api/scholarship/tests/:testId',
    classification: 'public-global',
    reason: 'public:scholarship-browse',
    justification:
      'Single scholarship test detail, same open-by-design audience as the list. ' +
      'Returns question metadata only; answers are never included.',
  },
  {
    method: 'POST',
    path: '/api/scholarship/attempts',
    classification: 'public-global',
    reason: 'public:scholarship-attempt',
    justification:
      'Guest sits a scholarship test. Subsequent calls are authorised by the ' +
      'per-attempt key header, not by a session.',
  },
  {
    method: 'GET',
    path: '/api/scholarship/attempts/:attemptId',
    classification: 'public-global',
    reason: 'public:scholarship-attempt',
    justification: 'Guarded by X-Scholarship-Attempt-Key rather than by a session.',
  },
  {
    method: 'POST',
    path: '/api/scholarship/attempts/:attemptId/answer',
    classification: 'public-global',
    reason: 'public:scholarship-attempt',
    justification:
      'Answer submission for an in-progress guest attempt. Authorised by the ' +
      'per-attempt key header, which scopes it to one attempt the caller created.',
  },
  {
    method: 'POST',
    path: '/api/scholarship/attempts/:attemptId/submit',
    classification: 'public-global',
    reason: 'public:scholarship-attempt',
    justification:
      'Answer submission for an in-progress guest attempt. Authorised by the ' +
      'per-attempt key header, which scopes it to one attempt the caller created.',
  },
  {
    method: 'GET',
    path: '/api/scholarship/public/results/:token',
    classification: 'public-global',
    reason: 'public:scholarship-result',
    justification: 'Result link shared with the candidate; the token is the authorisation.',
  },

  // ── Diagnostics ──────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/health',
    classification: 'diagnostic',
    reason: 'diagnostic:health',
    justification: 'Liveness probe. Touches no tenant data.',
  },
  {
    method: 'GET',
    path: '/api/tests/health',
    classification: 'diagnostic',
    reason: 'diagnostic:health',
    justification:
      'Liveness probe used by the platform host and uptime monitoring. Returns ' +
      'process status only and reads no collection.',
  },
  {
    method: 'GET',
    path: '/api/metrics/health',
    classification: 'diagnostic',
    reason: 'diagnostic:health',
    justification:
      'Liveness probe used by the platform host and uptime monitoring. Returns ' +
      'process status only and reads no collection.',
  },
];

/**
 * Deliberately NOT allowlisted, and why. Kept beside the list so the reasoning
 * survives, and so nobody "fixes" a 403 by adding one of these without reading
 * this note.
 *
 *   GET  /api/auth/login            405 stub, touches no database.
 *   GET  /api/auth/register         405 stub, touches no database.
 *   GET  /api/automation/logs       Authenticates INSIDE the handler by verifying a
 *                                   JWT from a query parameter (EventSource cannot
 *                                   set headers). Not unguarded — the contract
 *                                   snapshot mislabels it because it only reads
 *                                   middleware.
 *   POST /api/auth/welcome-tutorial/complete
 *                                   Same pattern: verifies a JWT inline. Once
 *                                   claim-mode tokens carry orgId, the middleware
 *                                   establishes the context from that token, so no
 *                                   bypass is needed.
 *   POST /api/webhooks/attendance   NOT allowlisted on purpose. It is currently
 *                                   unauthenticated (its signature check is
 *                                   commented out) and it WRITES. Allowlisting it
 *                                   would bless that. It needs a real signature
 *                                   check and an org resolved from the payload —
 *                                   tracked as a security finding, not papered over
 *                                   here.
 *   GET  /api/org/branding          Unauthenticated by design — a login page has to
 *                                   be painted before the credential that would
 *                                   reveal the branding is submitted. Allowlisting
 *                                   it would BREAK it: an allowlisted route runs
 *                                   inside `withoutTenantScope`, `currentOrgId()`
 *                                   returns null, and the endpoint would answer
 *                                   `organization: null` for every request. It
 *                                   needs the context the middleware resolves from
 *                                   the Host or `X-Org-Id`, which is exactly what
 *                                   NOT allowlisting it provides. Returns name,
 *                                   slug, status, branding and locale only —
 *                                   nothing an institute's own login page does not
 *                                   already show the world.
 */
export const DELIBERATELY_NOT_ALLOWLISTED = [
  'GET /api/auth/login',
  'GET /api/auth/register',
  'GET /api/automation/logs',
  'POST /api/auth/welcome-tutorial/complete',
  'POST /api/webhooks/attendance',
  'GET /api/org/branding',
] as const;

/** Compile `/api/x/:id` into a matcher. Params match a single path segment. */
function toPattern(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${source}/?$`);
}

const COMPILED = PUBLIC_ROUTE_ALLOWLIST.map((entry) => ({
  entry,
  pattern: toPattern(entry.path),
}));

/** The allowlist entry for a request, or null when it is not allowlisted. */
export function findPublicRoute(method: string, path: string): PublicRouteEntry | null {
  const upper = method.toUpperCase();
  const clean = path.split('?')[0];
  for (const { entry, pattern } of COMPILED) {
    if (entry.method !== '*' && entry.method !== upper) continue;
    if (pattern.test(clean)) return entry;
  }
  return null;
}
