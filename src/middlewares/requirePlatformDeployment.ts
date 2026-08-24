/**
 * Deployment isolation for the platform administration surface.
 *
 * ── The problem this closes ─────────────────────────────────────────────────
 * One codebase produces two deployments. `/api/platform/*` belongs to exactly
 * one of them — api-platform, the private control-plane host — but it was
 * mounted unconditionally, so api-legacy served it too. api-legacy is the
 * institute-facing deployment on a public hostname.
 *
 * That was inert only by accident: production has no platform staff, so every
 * login there failed. Cutover Step 25 creates the first owner in the SHARED
 * database, and from that moment the same credentials would open every
 * organization, plan, subscription and staff endpoint on a customer's public
 * host. The separate token audience does not help — the token is genuine; it
 * is the route being reachable there at all that is wrong.
 *
 * ── Why a 404, and why THIS 404 ─────────────────────────────────────────────
 * `next('router')` exits the mount stack without responding, so Express's own
 * unmatched-route handler answers. The result is byte-identical to the route
 * never having been mounted — same status, same content-type, same body. A
 * bespoke `{"message":"Not available here"}` would be a different shape from
 * every other unmatched path on the host, and that difference is itself the
 * disclosure: it tells a prober that a platform API exists somewhere.
 *
 * A 403 would be worse still. "Forbidden" confirms the surface is real.
 *
 * ── The operator still needs to know ────────────────────────────────────────
 * Silence to the caller means the server log is the only diagnostic left for
 * someone who has misconfigured api-platform and cannot understand why their
 * console 404s. So a refusal is logged — throttled, because an internet-facing
 * host gets scanned for admin paths continuously and an unthrottled line here
 * is a log-flooding vector.
 *
 * ── Evaluated per request, not at mount ─────────────────────────────────────
 * `tenantMode()` reads the environment each call. That costs nothing and makes
 * the behaviour directly testable: one booted app can be driven through both
 * modes, which is how the integration test proves the gate rather than proving
 * that two separate processes were configured differently.
 */

import { NextFunction, Request, Response } from 'express';
import { tenantMode } from '../core/tenancy/config';

/** One line per minute is enough to diagnose a misconfiguration. */
const LOG_INTERVAL_MS = 60_000;
let lastLoggedAt = 0;
let suppressed = 0;

export function requirePlatformDeployment(req: Request, res: Response, next: NextFunction) {
  if (tenantMode() === 'claim') return next();

  const now = Date.now();
  if (now - lastLoggedAt >= LOG_INTERVAL_MS) {
    const extra = suppressed > 0 ? ` (${suppressed} similar suppressed)` : '';
    console.warn(
      `[platform-gate] refused ${req.method} ${req.originalUrl} — ` +
        `TENANT_MODE is not "claim", so the platform surface is not served by this ` +
        `deployment. This is correct for api-legacy. If this IS api-platform, its ` +
        `TENANT_MODE is wrong.${extra}`,
    );
    lastLoggedAt = now;
    suppressed = 0;
  } else {
    suppressed++;
  }

  // Leave the mount stack without responding. Express answers exactly as it
  // would for a path nothing is mounted on.
  return next('router');
}

/** Test seam: the throttle is module state and would leak between cases. */
export function __resetPlatformGateLog() {
  lastLoggedAt = 0;
  suppressed = 0;
}
