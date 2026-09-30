/**
 * The realm rules, without a database: which process is which system, what
 * each may connect to, and which authorization model its requests get.
 *
 * The regression these pin: a process serving the EXISTING database with
 * `TENANT_MODE=claim` in its environment ran the organization platform's
 * authorization on every /api/* request — sign-in succeeded, and the next
 * request (GET /api/auth/me) answered 403 TENANT_REQUIRED for every existing
 * account. The existing system now never runs claim mode, whatever the
 * environment says; the platform runtime always does.
 *
 *   npm run safety:realm-policy
 */

import { databaseNameOf, platformJwtSecret, platformRedisNames, platformRuntimeEnv, platformUpstreamPath, serviceRealm, existingDatabaseUri, assertSeparateDatabases, RealmConfigurationError } from '../../src/core/realm/realm';

let total = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  total++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}
function section(title: string): void {
  console.log(`\n${title}`);
}
function throwsRealm(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof RealmConfigurationError;
  }
}

const EXISTING = 'mongodb+srv://user:pass@cluster0.example.net/abhigyangurukul?retryWrites=true&w=majority';
const EXISTING_OTHER_OPTIONS = 'mongodb+srv://user:pass@cluster0.example.net/abhigyangurukul?retryWrites=true';
const PLATFORM = 'mongodb+srv://user:pass@cluster0.example.net/abhigyangurukul_console?retryWrites=true&w=majority';
const SECRET = 'x'.repeat(48);

/** Run `fn` with exactly this environment, then restore the real one. */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

async function main() {
  console.log('\nREALM POLICY  (pure — no database)');

  /* ── Which realm ─────────────────────────────────────────────────────── */
  section('which realm a process is');
  check('no SERVICE_REALM → the existing system', serviceRealm({}) === 'existing');
  check('SERVICE_REALM=platform → the platform', serviceRealm({ SERVICE_REALM: 'platform' }) === 'platform');
  check('case and spaces do not matter', serviceRealm({ SERVICE_REALM: ' Platform ' }) === 'platform');
  check('anything else → the existing system', serviceRealm({ SERVICE_REALM: 'console' }) === 'existing');

  /* ── The existing system's database ──────────────────────────────────── */
  section("the existing system's database");
  check('MONGO_URI alone', existingDatabaseUri({ MONGO_URI: EXISTING }) === EXISTING);
  check('MONGODB_URI alone', existingDatabaseUri({ MONGODB_URI: EXISTING }) === EXISTING);
  check(
    'both naming the same database (options differ) → MONGODB_URI',
    existingDatabaseUri({ MONGODB_URI: EXISTING_OTHER_OPTIONS, MONGO_URI: EXISTING }) === EXISTING_OTHER_OPTIONS,
  );
  check(
    'both naming DIFFERENT databases → refused, never guessed',
    throwsRealm(() => existingDatabaseUri({ MONGODB_URI: EXISTING, MONGO_URI: PLATFORM })),
  );
  check('database names are read from the URI path', databaseNameOf(PLATFORM) === 'abhigyangurukul_console');

  section('the two realms never share a database');
  check('different databases → fine', !throwsRealm(() => assertSeparateDatabases(EXISTING, PLATFORM)));
  check('the same database → refused', throwsRealm(() => assertSeparateDatabases(EXISTING, EXISTING_OTHER_OPTIONS)));
  check(
    'the same database in another case → refused',
    throwsRealm(() => assertSeparateDatabases(EXISTING, EXISTING.replace('/abhigyangurukul?', '/AbhigyanGurukul?'))),
  );
  check(
    'a platform URI with no database name → refused',
    throwsRealm(() => assertSeparateDatabases(EXISTING, 'mongodb+srv://u:p@cluster0.example.net/?x=1')),
  );
  check('no platform configured → nothing to compare', !throwsRealm(() => assertSeparateDatabases(EXISTING, null)));

  /* ── Sessions: one key per realm ─────────────────────────────────────── */
  section('each realm signs its own sessions');
  const derived = platformJwtSecret({ JWT_SECRET: SECRET });
  check('the platform key is derived, not the existing key', derived !== SECRET && /^[0-9a-f]{64}$/.test(derived));
  check('…deterministically (every instance agrees)', platformJwtSecret({ JWT_SECRET: SECRET }) === derived);
  check('…and changes when JWT_SECRET changes', platformJwtSecret({ JWT_SECRET: SECRET + 'y' }) !== derived);
  check(
    'PLATFORM_JWT_SECRET, when set, is used as is',
    platformJwtSecret({ JWT_SECRET: SECRET, PLATFORM_JWT_SECRET: 'p'.repeat(40) }) === 'p'.repeat(40),
  );
  check('a short PLATFORM_JWT_SECRET is refused', throwsRealm(() => platformJwtSecret({ PLATFORM_JWT_SECRET: 'short' })));
  check('no JWT_SECRET at all is refused', throwsRealm(() => platformJwtSecret({})));

  /* ── The platform runtime's environment ──────────────────────────────── */
  section("the platform runtime's environment");
  const configured: NodeJS.ProcessEnv = {
    MONGO_URI: EXISTING,
    MONGO_URI_DIRECT: 'mongodb://h1,h2/abhigyangurukul?replicaSet=x',
    PLATFORM_MONGODB_URI: PLATFORM,
    TENANT_MODE: 'claim',
    TENANT_ENFORCEMENT: 'enforce',
    ORG_ID: 'org-001',
    JWT_SECRET: SECRET,
    PORT: '5000',
    AI_QUEUE_NAME: 'ai-ppt-pipeline',
    ENABLE_CRON: 'true',
    PPT_WORKER_EMBEDDED: 'true',
    CORS_ORIGIN: 'https://abhigyangurukul.com',
  };
  const env = platformRuntimeEnv(configured, { primary: true, gatewayKey: 'k'.repeat(64) });
  check('it is the platform realm', env.SERVICE_REALM === 'platform');
  check('its ONLY database is the platform one', env.MONGO_URI === PLATFORM && env.MONGODB_URI === undefined);
  check(
    "it never inherits the existing system's direct URI (the SRV fallback)",
    env.MONGO_URI_DIRECT === '',
    `got ${env.MONGO_URI_DIRECT}`,
  );
  check(
    'PLATFORM_MONGODB_URI_DIRECT is its fallback when given',
    platformRuntimeEnv({ ...configured, PLATFORM_MONGODB_URI_DIRECT: 'mongodb://p1/abhigyangurukul_console' }, {
      primary: true,
      gatewayKey: 'k',
    }).MONGO_URI_DIRECT === 'mongodb://p1/abhigyangurukul_console',
  );
  check('organization-aware: claim mode, no pinned organization', env.TENANT_MODE === 'claim' && env.ORG_ID === '');
  check('the enforcement setting is the platform’s to keep', env.TENANT_ENFORCEMENT === 'enforce');
  check('its own session key', env.JWT_SECRET === derived && env.JWT_SECRET !== SECRET);
  check('loopback only, on a port the OS picks', env.REALM_LISTEN_HOST === '127.0.0.1' && env.PORT === '0');
  check('the gateway key is passed', env.REALM_GATEWAY_KEY === 'k'.repeat(64));
  check('primary / not primary is passed', env.REALM_INSTANCE_PRIMARY === 'true' &&
    platformRuntimeEnv(configured, { primary: false, gatewayKey: 'k' }).REALM_INSTANCE_PRIMARY === 'false');
  const redis = platformRedisNames(configured);
  check('its AI jobs have their own queue', env.AI_QUEUE_NAME === 'ai-ppt-pipeline-platform' && redis.aiQueue === env.AI_QUEUE_NAME);
  check('its sockets have their own Redis channel', env.SOCKET_ADAPTER_KEY === 'socket.io-platform');
  check('its cache and rate-limit keys have their own namespace', env.REDIS_KEY_NAMESPACE === 'platform:');
  check('mobile builds keep the queue they were queued under', env.APP_BUILD_QUEUE_NAME === 'app-builds');
  check(
    "the existing system's cron is not repeated there by default",
    env.ENABLE_CRON === 'false' &&
      platformRuntimeEnv({ ...configured, PLATFORM_ENABLE_CRON: 'true' }, { primary: true, gatewayKey: 'k' }).ENABLE_CRON === 'true',
  );
  check(
    'its AI worker follows PLATFORM_PPT_WORKER_EMBEDDED, else PPT_WORKER_EMBEDDED',
    env.PPT_WORKER_EMBEDDED === 'true' &&
      platformRuntimeEnv({ ...configured, PLATFORM_PPT_WORKER_EMBEDDED: 'false' }, { primary: true, gatewayKey: 'k' })
        .PPT_WORKER_EMBEDDED === 'false',
  );
  check(
    'PLATFORM_CORS_ORIGIN, when set, replaces CORS_ORIGIN there only',
    env.CORS_ORIGIN === 'https://abhigyangurukul.com' &&
      platformRuntimeEnv({ ...configured, PLATFORM_CORS_ORIGIN: 'https://app.example.com' }, { primary: true, gatewayKey: 'k' })
        .CORS_ORIGIN === 'https://app.example.com',
  );
  check('the operator environment is not modified', configured.MONGO_URI === EXISTING && configured.TENANT_MODE === 'claim');
  check('no PLATFORM_MONGODB_URI → refused', throwsRealm(() => platformRuntimeEnv({ MONGO_URI: EXISTING, JWT_SECRET: SECRET }, { primary: true, gatewayKey: 'k' })));
  check(
    'a platform database that IS the existing one → refused',
    throwsRealm(() => platformRuntimeEnv({ MONGO_URI: EXISTING, PLATFORM_MONGODB_URI: EXISTING_OTHER_OPTIONS, JWT_SECRET: SECRET }, { primary: true, gatewayKey: 'k' })),
  );

  /* ── /platform-api/* → the runtime ───────────────────────────────────── */
  section('/platform-api/* maps onto the runtime’s own routes');
  const cases: [string, string | null][] = [
    ['/platform-api/auth/login', '/api/auth/login'],
    ['/platform-api/users?role=admin&page=2', '/api/users?role=admin&page=2'],
    ['/platform-api/health', '/api/health'],
    ['/platform-api', '/api'],
    ['/platform-api/', '/api'],
    ['/platform-api?x=1', '/api?x=1'],
    ['/platform-apix/users', null],
    ['/api/users', null],
    ['/platform', null],
  ];
  for (const [input, expected] of cases) {
    const got = platformUpstreamPath(input);
    check(`${input} → ${expected ?? '(not the platform)'}`, got === expected, `got ${got}`);
  }

  /* ── The boot policies ───────────────────────────────────────────────── */
  /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */
  const dataSource = require('../../src/core/tenancy/dataSource');
  const mongoose = require('mongoose');
  const { principalOf } = require('../../src/middlewares/authMiddleware');
  /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */
  const policyWith = (env2: Record<string, string | undefined>) =>
    withEnv(env2, () => {
      dataSource.__resetConfiguredEnvForTests();
      const policy = dataSource.applyDataSourcePolicy();
      // Evaluated HERE: principalOf reads the environment when it is called.
      return {
        policy,
        env: { ...process.env },
        principals: {
          none: principalOf({}).kind as string,
          org: principalOf({ orgId: 'org-x' }).kind as string,
        },
        configured: { ...dataSource.configuredEnv() },
        kind: dataSource.deploymentKind(),
        refuses: dataSource.refusesOrganizationAccounts(),
      };
    });

  section("the existing system (/api/*) — the reported configuration: TENANT_MODE=claim, no LEGACY_DB_NAMES");
  {
    let noOrg = '';
    let withOrg = '';
    const run = withEnv(
      { MONGO_URI: EXISTING, TENANT_MODE: 'claim', TENANT_ENFORCEMENT: 'warn', LEGACY_DATA_ORG_ID: 'x', ENABLE_CRON: 'true', PPT_WORKER_EMBEDDED: 'true' },
      () => {
        dataSource.__resetConfiguredEnvForTests();
        const policy = dataSource.applyDataSourcePolicy();
        noOrg = principalOf({}).kind;
        withOrg = principalOf({ orgId: 'someorg' }).kind;
        return { policy, env: { ...process.env }, configured: { ...dataSource.configuredEnv() }, kind: dataSource.deploymentKind() };
      },
    );
    check('realm: existing, on its own database', run.policy.realm === 'existing' && run.policy.database === 'abhigyangurukul');
    check('claim mode is set aside for /api/*', run.env.TENANT_MODE === '' && run.env.TENANT_ENFORCEMENT === '' && run.env.LEGACY_DATA_ORG_ID === '');
    check('an existing account (no organization) → the legacy path, NOT TENANT_REQUIRED', noOrg === 'legacy', `got ${noOrg}`);
    check('an organization account → refused here (it belongs to /platform-api/*)', withOrg === 'organization-account', `got ${withOrg}`);
    check('clients are told "legacy"', run.kind === 'legacy');
    check("the existing system's cron and PPT worker are left exactly as configured", run.env.ENABLE_CRON === 'true' && run.env.PPT_WORKER_EMBEDDED === 'true');
    check('nothing is created or indexed at boot', mongoose.get('autoCreate') === false && mongoose.get('autoIndex') === false);
    check('the configured environment is kept for the platform runtime', run.configured.TENANT_MODE === 'claim');
  }

  section('the existing system — configurations that were never the platform’s keep their meaning');
  {
    const none = policyWith({ MONGO_URI: EXISTING });
    check(
      'nothing set (today’s production) → unchanged, no org required',
      none.env.TENANT_MODE === undefined && none.principals.none === 'legacy' && none.refuses === true && none.policy.changes.length === 1,
      JSON.stringify(none.policy.changes),
    );
    const pinned = policyWith({ MONGO_URI: EXISTING, TENANT_MODE: 'pinned', ORG_ID: 'org-001', TENANT_ENFORCEMENT: 'warn' });
    check('pinned + ORG_ID (api-legacy) → left exactly as configured', pinned.env.TENANT_MODE === 'pinned' && pinned.env.ORG_ID === 'org-001' && pinned.principals.none === 'tenant');
    const off = policyWith({ MONGO_URI: EXISTING, TENANT_ENFORCEMENT: 'off' });
    check('TENANT_ENFORCEMENT=off (the escape hatch) keeps its meaning', off.env.TENANT_ENFORCEMENT === 'off' && off.principals.org === 'legacy');
    const enforce = policyWith({ MONGO_URI: EXISTING, TENANT_ENFORCEMENT: 'enforce' });
    check('enforce with no pinned organization → set aside (it can only refuse here)', enforce.env.TENANT_ENFORCEMENT === '' && enforce.principals.none === 'legacy');
    const viaNewName = policyWith({ MONGODB_URI: EXISTING });
    check('MONGODB_URI is honoured (MONGO_URI is set from it for every reader)', viaNewName.env.MONGO_URI === EXISTING && viaNewName.policy.database === 'abhigyangurukul');
    const samePlatform = policyWith({ MONGO_URI: EXISTING, PLATFORM_MONGODB_URI: EXISTING_OTHER_OPTIONS });
    check(
      'a platform URI naming THIS database is reported — and /api/* still starts',
      samePlatform.policy.realm === 'existing' && samePlatform.policy.changes.some((c: string) => /platform not started/.test(c)),
    );
    check('two different existing databases → refused at boot', throwsRealm(() => policyWith({ MONGODB_URI: EXISTING, MONGO_URI: PLATFORM })));
  }

  section('the platform runtime (/platform-api/*)');
  {
    const platform = policyWith({ SERVICE_REALM: 'platform', MONGO_URI: PLATFORM, PLATFORM_MONGODB_URI: PLATFORM, TENANT_MODE: '', ORG_ID: 'org-001' });
    check('realm: platform, on the platform database', platform.policy.realm === 'platform' && platform.policy.database === 'abhigyangurukul_console');
    check('claim mode, always; no pinned organization', platform.env.TENANT_MODE === 'claim' && platform.env.ORG_ID === '');
    check('an account with no organization → TENANT_REQUIRED (the console rule)', platform.principals.none === 'unattached');
    check('an organization account → its own organization', platform.principals.org === 'tenant');
    check('clients are told "platform"', platform.kind === 'platform');
    check(
      'refused on a database listed in LEGACY_DB_NAMES',
      throwsRealm(() => policyWith({ SERVICE_REALM: 'platform', MONGO_URI: EXISTING, LEGACY_DB_NAMES: 'abhigyangurukul' })),
    );
    check(
      'refused when told two different databases',
      throwsRealm(() => policyWith({ SERVICE_REALM: 'platform', MONGO_URI: PLATFORM, PLATFORM_MONGODB_URI: EXISTING })),
    );
    check('refused with no database at all', throwsRealm(() => policyWith({ SERVICE_REALM: 'platform' })));
    const standalone = policyWith({ SERVICE_REALM: 'platform', MONGO_URI: PLATFORM });
    check('standalone (a fixture, a dedicated deployment) → runs on MONGO_URI', standalone.policy.realm === 'platform');
  }

  console.log(`\n  ${total - failures}/${total} checks passed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
