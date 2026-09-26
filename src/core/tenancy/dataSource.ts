/**
 * Which database this process serves — and the rules that follow from it.
 *
 * ── Two databases, two kinds of account ─────────────────────────────────────
 *   abhigyangurukul           the LEGACY system: the original institute's
 *                             accounts, none of which belongs to an
 *                             organization.
 *   abhigyangurukul_console   the ORGANIZATION system: every onboarded
 *                             institute, isolated by `orgId` (claim mode).
 *
 * The same code can be pointed at either by changing MONGO_URI. Before this
 * file, changing MONGO_URI was ALL that changed: with `TENANT_MODE=claim` still
 * in `.env`, a process connected to the legacy database demanded an
 * organization on every legacy account and refused each one with
 * TENANT_REQUIRED ("This account is not attached to an organization"). Worse,
 * booting against the legacy database created the organization system's
 * collections and indexes in it, and seeded a bootstrap administrator there.
 *
 * So the DATABASE decides, at boot:
 *
 *   legacy database  →  legacy (pre-migration) mode, whatever TENANT_MODE says
 *                       (an explicit `pinned` + ORG_ID is left alone — that is
 *                       a deliberate api-legacy configuration, not a leftover);
 *                       nothing is created, indexed or seeded at startup; no
 *                       cron and no background workers.
 *
 * And in legacy mode, an account that belongs to an organization is refused —
 * at sign-in and on every request (`refusesOrganizationAccounts`). Organization
 * accounts belong to the organization system, and a process without tenant
 * isolation must never serve them.
 *
 * Nothing here names a database. The connection is MONGO_URI; which database
 * names are "legacy" is LEGACY_DB_NAMES (comma-separated). Both come from the
 * environment, so switching MONGO_URI between a legacy and an organization
 * database switches the mode with it. With LEGACY_DB_NAMES unset, no database
 * is treated as legacy and TENANT_MODE applies exactly as configured.
 */

import mongoose from 'mongoose';
import { pinnedOrgId, tenantEnforcement, tenantMode } from './config';

/** The database name in a mongodb:// or mongodb+srv:// URI, or null. */
export function databaseNameOf(uri: string | null | undefined): string | null {
  const match = String(uri ?? '').match(
    /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/([^?]*)/,
  );
  const name = match ? decodeURIComponent(match[1] || '').trim() : '';
  return name || null;
}

/** The database names configured as legacy (LEGACY_DB_NAMES). Empty when unset. */
export function legacyDatabaseNames(): Set<string> {
  return new Set(
    (process.env.LEGACY_DB_NAMES || '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Is this process connected (or about to connect) to a legacy database? */
export function isLegacyDatabase(
  uri: string | null | undefined = process.env.MONGO_URI,
): boolean {
  const name = databaseNameOf(uri);
  return Boolean(name && legacyDatabaseNames().has(name.toLowerCase()));
}

/**
 * A deployment that serves only accounts WITHOUT an organization: legacy
 * (pre-migration) mode — pinned by default, with no ORG_ID. Not the explicit
 * `TENANT_ENFORCEMENT=off` kill switch, which keeps its defined meaning.
 */
export function refusesOrganizationAccounts(): boolean {
  return (
    tenantEnforcement() !== 'off' && tenantMode() === 'pinned' && !pinnedOrgId()
  );
}

/** What the clients are told: which experience this deployment's accounts get. */
export function deploymentKind(): 'platform' | 'legacy' {
  return tenantMode() === 'claim' ? 'platform' : 'legacy';
}

/** The refusal an organization account receives from a legacy deployment. */
export const ORGANIZATION_ACCOUNT_REFUSAL = {
  status: 403,
  code: 'ORGANIZATION_ACCOUNT',
  message:
    'This account belongs to an organization. Sign in through your organization instead.',
} as const;

export interface DataSourcePolicy {
  database: string | null;
  legacy: boolean;
  changes: string[];
}

/**
 * Apply the database's rules to this process. Called once, at boot, before
 * tenancy is registered and before any model can reach the database.
 */
export function applyDataSourcePolicy(): DataSourcePolicy {
  const database = databaseNameOf(process.env.MONGO_URI);
  const legacy = isLegacyDatabase(process.env.MONGO_URI);
  const changes: string[] = [];
  if (!legacy) return { database, legacy, changes };

  // Claim mode is the organization system's. On the legacy database it can
  // only refuse every account, so it is a leftover, not a choice. Empty rather
  // than deleted: a later dotenv load would restore a deleted key.
  if ((process.env.TENANT_MODE || '').trim().toLowerCase() === 'claim') {
    process.env.TENANT_MODE = '';
    process.env.TENANT_ENFORCEMENT = '';
    process.env.ORG_ID = '';
    process.env.LEGACY_DATA_ORG_ID = '';
    changes.push(
      'TENANT_MODE=claim ignored: the legacy database runs in legacy (pre-migration) mode',
    );
  }

  // Nothing is created or indexed by starting up. Mongoose would otherwise
  // create every model's collection and build every index — including the
  // organization system's — in the legacy database.
  mongoose.set('autoCreate', false);
  mongoose.set('autoIndex', false);
  changes.push('collection and index creation disabled');

  // No scheduled or background work from this process against the legacy
  // database, unless someone deliberately asks for it.
  if (process.env.LEGACY_DB_BACKGROUND_JOBS !== 'true') {
    for (const key of [
      'ENABLE_CRON',
      'PPT_WORKER_EMBEDDED',
      'APP_BUILD_WORKER_EMBEDDED',
    ]) {
      if (process.env[key] !== 'false') {
        process.env[key] = 'false';
        changes.push(`${key}=false`);
      }
    }
  }

  return { database, legacy, changes };
}
