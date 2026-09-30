/**
 * Two systems, one backend — which one THIS process is, and what it may touch.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 *   /api/*            the existing production system (abhigyan-gurukul-main,
 *                     abhigyan-gurukul-app). Its database is MONGODB_URI —
 *                     MONGO_URI is still read, because every deployment that
 *                     exists today sets that one. Authentication and roles are
 *                     the ones those apps were built against, and no
 *                     organization is ever required.
 *   /platform-api/*   the organization platform (client-platform-web,
 *                     client-platform-app, platform-console). Its database is
 *                     PLATFORM_MONGODB_URI, and every request is authenticated
 *                     and authorized inside an organization.
 *
 * ── Why the platform runs in its own process ────────────────────────────────
 * Every model in this codebase is compiled once, on mongoose's default
 * connection, and almost every service imports its models directly. Choosing a
 * database per request would mean rewiring how ~70 models are reached. And the
 * tenancy configuration (TENANT_MODE, TENANT_ENFORCEMENT, ORG_ID, …) is process
 * environment: it cannot mean "organization required" for one request and
 * "no organization" for the next. So the realm is a property of a PROCESS:
 *
 *   the main process      realm "existing": serves /api/*, connected ONLY to
 *                         the existing database;
 *   the platform runtime  realm "platform": the same code, forked by the main
 *                         process with its own environment, connected ONLY to
 *                         the platform database, listening on loopback, and
 *                         reachable only through /platform-api/*.
 *
 * Neither process holds a connection to the other's database, so a request in
 * one realm cannot read or write the other's data — not through a model, not
 * through a raw driver call, not through a populate.
 *
 * SERVICE_REALM is set by the backend itself when it forks the platform
 * runtime. It is never taken from a request, a header, a token or a client.
 *
 * This module is pure (environment in, decisions out) so that every rule in it
 * is testable without a database: scripts/safety/realm-policy.test.ts.
 */

import crypto from 'crypto';

export type ServiceRealm = 'existing' | 'platform';

/** Which realm this process serves. Anything but an explicit "platform" is the existing system. */
export function serviceRealm(env: NodeJS.ProcessEnv = process.env): ServiceRealm {
  return (env.SERVICE_REALM || '').trim().toLowerCase() === 'platform' ? 'platform' : 'existing';
}

/** The database name in a mongodb:// or mongodb+srv:// URI, or null. */
export function databaseNameOf(uri: string | null | undefined): string | null {
  const match = String(uri ?? '').match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/([^?]*)/);
  const name = match ? decodeURIComponent(match[1] || '').trim() : '';
  return name || null;
}

/** A configuration the backend refuses to start with — said plainly, at boot. */
export class RealmConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealmConfigurationError';
  }
}

const trimmed = (value: string | undefined): string | null => {
  const text = (value || '').trim();
  return text || null;
};

/**
 * The existing system's database: MONGODB_URI, or MONGO_URI for the
 * deployments that already set it. Both set is fine while they name the same
 * database (MONGODB_URI is used); naming two DIFFERENT databases is refused
 * rather than guessed — one of them would be serving production.
 */
export function existingDatabaseUri(env: NodeJS.ProcessEnv = process.env): string | null {
  const preferred = trimmed(env.MONGODB_URI);
  const current = trimmed(env.MONGO_URI);
  if (preferred && current && preferred !== current) {
    const a = databaseNameOf(preferred);
    const b = databaseNameOf(current);
    if (!a || !b || a.toLowerCase() !== b.toLowerCase()) {
      throw new RealmConfigurationError(
        `MONGODB_URI ("${a ?? '?'}") and MONGO_URI ("${b ?? '?'}") name different databases. ` +
          'The existing system has ONE database: set MONGODB_URI (or MONGO_URI) only.',
      );
    }
  }
  return preferred ?? current;
}

/** The platform's database, or null when the platform is not configured here. */
export function platformDatabaseUri(env: NodeJS.ProcessEnv = process.env): string | null {
  return trimmed(env.PLATFORM_MONGODB_URI);
}

/**
 * The two databases must be two databases. Pointing both realms at one would
 * put organization accounts beside the existing accounts and undo the whole
 * separation, so it is refused at boot.
 */
export function assertSeparateDatabases(existingUri: string | null, platformUri: string | null): void {
  if (!platformUri) return;
  const platformDb = databaseNameOf(platformUri);
  if (!platformDb) {
    throw new RealmConfigurationError(
      'PLATFORM_MONGODB_URI names no database. Put the platform database name in its path, e.g. …/abhigyangurukul_console?…',
    );
  }
  const existingDb = databaseNameOf(existingUri);
  if (existingDb && existingDb.toLowerCase() === platformDb.toLowerCase()) {
    throw new RealmConfigurationError(
      `The existing system and the platform both point at the database "${platformDb}". ` +
        '/api/* and /platform-api/* must use different databases (MONGODB_URI and PLATFORM_MONGODB_URI).',
    );
  }
}

/**
 * The platform realm signs its sessions with its own key, so a credential from
 * one realm is not a credential in the other: an existing-system token sent to
 * /platform-api/* (or a platform token sent to /api/*) fails verification
 * instead of being looked up in a database it was never issued against.
 *
 * PLATFORM_JWT_SECRET when set; otherwise derived from JWT_SECRET with a fixed
 * label, so every instance derives the same key and no new secret has to be
 * provisioned for the split to be safe.
 */
export function platformJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = trimmed(env.PLATFORM_JWT_SECRET);
  if (explicit) {
    if (explicit.length < 32) {
      throw new RealmConfigurationError('PLATFORM_JWT_SECRET must be at least 32 characters.');
    }
    return explicit;
  }
  const base = trimmed(env.JWT_SECRET);
  if (!base) throw new RealmConfigurationError('JWT_SECRET is not set.');
  return crypto.createHmac('sha256', base).update('central-be:platform-realm:session-key:v1').digest('hex');
}

/** Redis names the platform runtime uses, so the two realms never share a queue, a room or a cache entry. */
export function platformRedisNames(env: NodeJS.ProcessEnv = process.env): {
  aiQueue: string;
  appBuildQueue: string;
  socketAdapterKey: string;
  keyNamespace: string;
} {
  return {
    aiQueue: trimmed(env.PLATFORM_AI_QUEUE_NAME) ?? `${trimmed(env.AI_QUEUE_NAME) ?? 'ai-ppt-pipeline'}-platform`,
    // Mobile builds exist only on the platform, so its queue keeps the name
    // builds were already queued under.
    appBuildQueue: trimmed(env.PLATFORM_APP_BUILD_QUEUE_NAME) ?? trimmed(env.APP_BUILD_QUEUE_NAME) ?? 'app-builds',
    socketAdapterKey: 'socket.io-platform',
    keyNamespace: 'platform:',
  };
}

/**
 * The environment the platform runtime is started with, derived from the
 * environment the operator configured (never from the main process after its
 * own boot policy has run).
 *
 * @param configured  the operator's environment
 * @param options.primary     whether this runtime may run singleton work
 *                            (cron, embedded workers) — false for every
 *                            cluster fork but one
 * @param options.gatewayKey  a per-boot secret the gateway presents, so the
 *                            runtime serves nothing that did not come through it
 */
export function platformRuntimeEnv(
  configured: NodeJS.ProcessEnv,
  options: { primary: boolean; gatewayKey: string },
): NodeJS.ProcessEnv {
  const platformUri = platformDatabaseUri(configured);
  if (!platformUri) throw new RealmConfigurationError('PLATFORM_MONGODB_URI is not set.');
  const existingUri = existingDatabaseUri(configured);
  assertSeparateDatabases(existingUri, platformUri);
  const redis = platformRedisNames(configured);

  const env: NodeJS.ProcessEnv = { ...configured };

  env.SERVICE_REALM = 'platform';

  // ONE database: the platform's. The existing system's URIs are removed, not
  // just overridden, so no code path in the runtime can fall back to them —
  // including db.ts's SRV fallback, which would otherwise pick up the existing
  // system's MONGO_URI_DIRECT.
  env.MONGO_URI = platformUri;
  delete env.MONGODB_URI;
  env.MONGO_URI_DIRECT = trimmed(configured.PLATFORM_MONGODB_URI_DIRECT) ?? '';

  // Organization-aware, always. ORG_ID pins a single organization and has no
  // meaning on the platform.
  env.TENANT_MODE = 'claim';
  env.ORG_ID = '';

  env.JWT_SECRET = platformJwtSecret(configured);

  // Loopback only, on a port the OS chooses; the runtime reports it back.
  env.PORT = '0';
  env.REALM_LISTEN_HOST = '127.0.0.1';
  env.REALM_GATEWAY_KEY = options.gatewayKey;
  env.REALM_INSTANCE_PRIMARY = options.primary ? 'true' : 'false';

  env.AI_QUEUE_NAME = redis.aiQueue;
  env.APP_BUILD_QUEUE_NAME = redis.appBuildQueue;
  env.SOCKET_ADAPTER_KEY = redis.socketAdapterKey;
  env.REDIS_KEY_NAMESPACE = redis.keyNamespace;

  // Scheduled jobs read the existing institute's integrations (the biometric
  // account, its reminders). They stay with the existing system unless the
  // platform is deliberately given its own.
  env.ENABLE_CRON = configured.PLATFORM_ENABLE_CRON === 'true' ? 'true' : 'false';
  // The platform's AI jobs have their own queue and need their own worker.
  env.PPT_WORKER_EMBEDDED =
    trimmed(configured.PLATFORM_PPT_WORKER_EMBEDDED) ?? trimmed(configured.PPT_WORKER_EMBEDDED) ?? '';
  env.APP_BUILD_WORKER_EMBEDDED = trimmed(configured.APP_BUILD_WORKER_EMBEDDED) ?? '';

  // CORS for the platform's own web hosts, when they differ.
  const platformCors = trimmed(configured.PLATFORM_CORS_ORIGIN);
  if (platformCors) env.CORS_ORIGIN = platformCors;

  return env;
}

/**
 * /platform-api/<rest> → the runtime's own /api/<rest>. The platform runtime
 * is the same application, so its routes keep their names inside it; only the
 * public prefix differs. Returns null for anything outside the namespace.
 */
export function platformUpstreamPath(url: string): string | null {
  const match = String(url || '').match(/^\/platform-api(\/[^?#]*)?(\?[^#]*)?$/);
  if (!match) return null;
  const rest = match[1] || '';
  const query = match[2] || '';
  if (rest === '' || rest === '/') return `/api${query}`;
  return `/api${rest}${query}`;
}
