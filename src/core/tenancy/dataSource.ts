/**
 * Which database this process serves — and the rules that follow from it.
 *
 * ── Two realms, two databases ───────────────────────────────────────────────
 *   /api/*            the EXISTING system (abhigyan-gurukul-main and
 *                     abhigyan-gurukul-app) over its own database —
 *                     `abhigyangurukul` in production. None of its accounts
 *                     belongs to an organization, and none ever has to.
 *   /platform-api/*   the ORGANIZATION platform over `abhigyangurukul_console`,
 *                     isolated by `orgId` (claim mode).
 *
 * Which realm a process is comes from core/realm/realm.ts: the main process is
 * the existing system; the platform runtime is forked from it with
 * SERVICE_REALM=platform. This file applies each realm's rules at boot.
 *
 * ── Why the existing system ignores TENANT_MODE=claim ───────────────────────
 * The regression this closes: after the platform work was merged, a process
 * serving the existing database with `TENANT_MODE=claim` in its environment
 * ran the organization system's authorization on every /api/* request. Sign-in
 * succeeded (it refuses only accounts that DO belong to an organization), and
 * the very next request — `GET /api/auth/me` — answered 403 TENANT_REQUIRED
 * ("This account is not attached to an organization") for every existing
 * account. The earlier guard depended on LEGACY_DB_NAMES naming the database;
 * a deployment without it fell straight through.
 *
 * Now the realm decides, not the database's name: /api/* is the existing
 * system, so the organization system's settings (claim mode, and `enforce`
 * without a pinned organization) are not applied to it — whatever the
 * environment says and whatever the database is called. Every configuration
 * that was not the organization system's (nothing set, `pinned` + ORG_ID, the
 * `off` escape hatch) keeps exactly its earlier meaning.
 *
 * In the existing realm, an account that belongs to an organization is refused
 * — at sign-in and on every request (`refusesOrganizationAccounts`).
 * Organization accounts belong to /platform-api/*, and a process without tenant
 * isolation must never serve them.
 *
 * ── What starting up may do to a database ───────────────────────────────────
 * The existing database is live production. Starting this process against it
 * creates no collection, builds no index and seeds no account: the platform's
 * models are compiled here too, and Mongoose would otherwise create their
 * collections and indexes in production at every boot. Its scheduled jobs and
 * workers run exactly as configured (ENABLE_CRON, PPT_WORKER_EMBEDDED) — they
 * are the existing system's own. Only the platform's mobile-build worker and
 * organization-deletion runner, which have nothing to do on this database, stay
 * in the platform realm (server.ts).
 *
 * LEGACY_DB_NAMES remains, as a guard: the platform refuses to start on a
 * database listed there.
 */

import mongoose from 'mongoose';
import { pinnedOrgId, tenantEnforcement, tenantMode } from './config';
import {
  assertSeparateDatabases,
  databaseNameOf as realmDatabaseNameOf,
  existingDatabaseUri,
  platformDatabaseUri,
  RealmConfigurationError,
  serviceRealm,
  type ServiceRealm,
} from '../realm/realm';

/** The database name in a mongodb:// or mongodb+srv:// URI, or null. */
export const databaseNameOf = realmDatabaseNameOf;

/** The database names configured as legacy (LEGACY_DB_NAMES). Empty when unset. */
export function legacyDatabaseNames(): Set<string> {
  return new Set(
    (process.env.LEGACY_DB_NAMES || '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Is this URI's database one of those listed in LEGACY_DB_NAMES? */
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
  realm: ServiceRealm;
  database: string | null;
  /** True for the existing system (the name predates the realms). */
  legacy: boolean;
  changes: string[];
}

let configuredEnvironment: NodeJS.ProcessEnv | null = null;

/**
 * The environment as the operator configured it, before a boot policy adjusted
 * it. The platform runtime is derived from THIS: the existing realm's policy
 * sets aside the organization system's settings for itself, and those are
 * exactly the settings the platform runtime needs.
 */
export function configuredEnv(): NodeJS.ProcessEnv {
  return configuredEnvironment ?? process.env;
}

/** Test seam: the configured environment is captured once per process. */
export function __resetConfiguredEnvForTests(): void {
  configuredEnvironment = null;
}

/**
 * Apply this process's realm rules. Called once, at boot, before tenancy is
 * registered and before any model can reach the database. Throws
 * RealmConfigurationError for a configuration that must not start.
 */
export function applyDataSourcePolicy(): DataSourcePolicy {
  if (!configuredEnvironment) configuredEnvironment = { ...process.env };
  return serviceRealm() === 'platform' ? applyPlatformPolicy() : applyExistingPolicy();
}

function applyExistingPolicy(): DataSourcePolicy {
  const changes: string[] = [];

  // ONE database: MONGODB_URI, or MONGO_URI where that is what is set. Every
  // later reader (db.ts, the workers, the index CLI) reads MONGO_URI.
  const uri = existingDatabaseUri();
  if (uri && (process.env.MONGO_URI || '').trim() !== uri) {
    process.env.MONGO_URI = uri;
    changes.push('MONGO_URI set from MONGODB_URI');
  }
  const database = databaseNameOf(uri);
  // A platform database that is this one is a platform misconfiguration: it is
  // reported, and the platform is not started (server.ts) — /api/* is not
  // taken down for it.
  try {
    assertSeparateDatabases(uri, platformDatabaseUri());
  } catch (error) {
    changes.push(`platform not started: ${(error as Error).message}`);
  }

  // The organization system's settings are the platform's, not /api/*'s.
  // Empty rather than deleted: a later dotenv load would restore a deleted key.
  const mode = (process.env.TENANT_MODE || '').trim().toLowerCase();
  if (mode === 'claim') {
    process.env.TENANT_MODE = '';
    process.env.TENANT_ENFORCEMENT = '';
    process.env.ORG_ID = '';
    process.env.LEGACY_DATA_ORG_ID = '';
    changes.push(
      'TENANT_MODE=claim not applied: /api/* is the existing system — organization rules apply on /platform-api/* only',
    );
  } else if (
    (process.env.TENANT_ENFORCEMENT || '').trim().toLowerCase() === 'enforce' &&
    !(process.env.ORG_ID || '').trim()
  ) {
    // Enforce with no pinned organization can only refuse: there is no
    // context to enforce. It is the platform's setting.
    process.env.TENANT_ENFORCEMENT = '';
    changes.push('TENANT_ENFORCEMENT=enforce not applied: /api/* has no organization to enforce');
  }

  // Starting up must not change the live database: no collection is created
  // and no index is built by booting. (Also passed to the connection in db.ts.)
  mongoose.set('autoCreate', false);
  mongoose.set('autoIndex', false);
  changes.push('collection and index creation at startup disabled');

  return { realm: 'existing', database, legacy: true, changes };
}

function applyPlatformPolicy(): DataSourcePolicy {
  const changes: string[] = [];
  const uri = (process.env.MONGO_URI || '').trim();
  if (!uri) throw new RealmConfigurationError('The platform runtime has no database (MONGO_URI is not set).');
  const database = databaseNameOf(uri);

  // Forked by the gateway, the runtime is told its database twice (MONGO_URI
  // and PLATFORM_MONGODB_URI); the two must agree.
  const declared = platformDatabaseUri();
  if (declared && (databaseNameOf(declared) || '').toLowerCase() !== (database || '').toLowerCase()) {
    throw new RealmConfigurationError(
      `The platform runtime is connected to "${database}" but PLATFORM_MONGODB_URI names "${databaseNameOf(declared)}".`,
    );
  }
  if (isLegacyDatabase(uri)) {
    throw new RealmConfigurationError(
      `"${database}" is listed in LEGACY_DB_NAMES: the organization platform must not run on the existing system's database.`,
    );
  }

  if ((process.env.TENANT_MODE || '').trim().toLowerCase() !== 'claim') {
    process.env.TENANT_MODE = 'claim';
    changes.push('TENANT_MODE=claim (the platform is organization-aware)');
  }
  if ((process.env.ORG_ID || '').trim()) {
    process.env.ORG_ID = '';
    changes.push('ORG_ID not applied (it pins one organization; the platform serves many)');
  }
  if (process.env.DB_BOOT_SCHEMA_SYNC === 'false') {
    mongoose.set('autoCreate', false);
    mongoose.set('autoIndex', false);
    changes.push('collection and index creation at startup disabled (DB_BOOT_SCHEMA_SYNC=false)');
  }

  return { realm: 'platform', database, legacy: false, changes };
}
