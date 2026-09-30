/**
 * The bootstrap administrator — whether one may be created, and with what.
 *
 * ── No defaults ─────────────────────────────────────────────────────────────
 * The account comes only from credentials the operator set: ADMIN_EMAIL and
 * ADMIN_PASSWORD. There is no fallback address and no fallback password. A
 * default in source is a publicly known administrator account on every
 * deployment that forgot to set them — which is exactly what the old
 * hardcoded address-and-password fallback was.
 *
 *   both set                      create the account if it does not exist; an
 *                                 existing account is never changed (config/db.ts)
 *   either missing, production    refuse: the platform runtime does not start
 *                                 (server.ts), and nothing is created
 *   either missing, otherwise     no bootstrap administrator — said once at boot
 *
 * Only the platform realm ever creates one (config/db.ts): the existing
 * system's database is never written at boot, so /api/* needs neither variable.
 *
 * Pure (environment in, decision out), so the rule has exactly one definition.
 */

export type AdminBootstrap =
  | { action: 'create'; email: string; password: string; name: string }
  | { action: 'skip'; reason: string }
  | { action: 'refuse'; reason: string };

export function adminBootstrap(env: NodeJS.ProcessEnv = process.env): AdminBootstrap {
  const email = (env.ADMIN_EMAIL || '').trim();
  const password = env.ADMIN_PASSWORD || '';
  const name = (env.ADMIN_NAME || '').trim() || 'System Admin';

  if (email && password.trim()) return { action: 'create', email, password, name };

  const missing = [!email && 'ADMIN_EMAIL', !password.trim() && 'ADMIN_PASSWORD'].filter(Boolean);
  const reason = `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set`;
  if ((env.NODE_ENV || '').trim().toLowerCase() === 'production') return { action: 'refuse', reason };
  return { action: 'skip', reason };
}
