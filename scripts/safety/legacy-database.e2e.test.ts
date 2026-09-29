/**
 * A server pointed at the LEGACY database behaves as the legacy system — proved
 * over real HTTP on a scratch database standing in for it.
 *
 * The situation this reproduces: MONGO_URI switched to the legacy database with
 * `TENANT_MODE=claim` still in `.env`. Every legacy account was then refused
 * with TENANT_REQUIRED ("This account is not attached to an organization"),
 * because claim mode demands an organization and legacy accounts have none.
 *
 * What must hold once the database is listed in LEGACY_DB_NAMES:
 *
 *   · claim mode is overridden to legacy (pre-migration) mode at boot, and
 *     nothing is created, indexed, seeded or scheduled;
 *   · legacy accounts sign in and use the API — no TENANT_REQUIRED;
 *   · organization accounts are refused: at sign-in, on refresh, and with a
 *     token issued elsewhere (ORGANIZATION_ACCOUNT);
 *   · organization registration and the platform API are not served;
 *   · clients are told `dataSource: 'legacy'`;
 *   · nothing is hardcoded: with LEGACY_DB_NAMES unset no database — not even
 *     the real legacy one's name — is treated as legacy, and the index CLI uses
 *     MONGO_URI only and refuses to change a legacy database.
 *
 * The scratch database stands in for the legacy one by being NAMED in
 * LEGACY_DB_NAMES — the same mechanism a real `.env` uses. Nothing here
 * connects to a production database.
 *
 *   npm run safety:legacy-database
 */

import { spawnSync } from 'child_process';
import { bootScratchApp, Checks, request } from './e2eHarness';

const RUN = `zz-legacydb-${process.pid}`;
const PASSWORD = 'Legacy-DB!2026';

async function main() {
  const t = new Checks();
  const { port, dbName, mongoose, close } = await bootScratchApp();

  /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */
  const { withoutTenantScope } = require('../../src/core/tenancy/context');
  const { clearOrgStateCache } = require('../../src/core/tenancy/orgState');
  const {
    signSessionToken,
    signSessionPair,
  } = require('../../src/core/auth/tokens');
  const dataSource = require('../../src/core/tenancy/dataSource');
  const Org = require('../../src/models/Org').default;
  const User = require('../../src/models/User').default;
  /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */

  const unscoped = <T>(fn: () => Promise<T>) =>
    withoutTenantScope('e2e:legacy-db', fn) as Promise<T>;
  const savedEnv = { ...process.env };
  const cleanup = async () => {
    await unscoped(async () => {
      const orgs = await Org.find({ slug: { $regex: '^zz-legacydb-' } })
        .select('_id')
        .lean();
      await User.deleteMany({ email: { $regex: '^zz-legacydb-' } });
      await Org.deleteMany({
        _id: { $in: orgs.map((o: { _id: unknown }) => o._id) },
      });
    });
  };

  try {
    await cleanup();
    console.log(
      `\nLEGACY DATABASE MODE  (scratch db standing in for the legacy one: ${dbName})`,
    );

    const org = await unscoped(() =>
      Org.create({
        name: 'Legacy DB Test Org',
        slug: `${RUN}-org`,
        status: 'active',
        mobile: { androidPackage: `com.zzlegacydb.p${process.pid}` },
      }),
    );
    const orgId = String(org._id);
    const person = (tag: string, extra: Record<string, unknown> = {}) =>
      unscoped(() =>
        User.create({
          name: `Legacy DB ${tag}`,
          email: `${RUN}-${tag}@example.test`,
          password: PASSWORD,
          role: 'admin',
          status: 'approved',
          ...extra,
        }),
      );
    const legacyUser = await person('legacy'); // no organization: a legacy account
    const orgUser = await person('org', { orgId }); // belongs to an organization
    const login = (tag: string, extra: Record<string, unknown> = {}) =>
      request(port, 'POST', '/api/auth/login', {
        body: {
          email: `${RUN}-${tag}@example.test`,
          password: PASSWORD,
          ...extra,
        },
      });

    /* ══ 0. The bug, as reported ═════════════════════════════════════════ */
    t.section(
      'before: claim mode on a legacy-style database (what was reported)',
    );
    delete process.env.LEGACY_DB_NAMES;
    const before = await login('legacy');
    const beforeMe = await request(port, 'GET', '/api/auth/me', {
      token: before.json?.token,
    });
    t.check(
      'a legacy account is refused with TENANT_REQUIRED ("not attached to an organization")',
      beforeMe.status === 403 && beforeMe.json?.code === 'TENANT_REQUIRED',
      `${beforeMe.status} ${beforeMe.raw.slice(0, 160)}`,
    );

    /* ══ 1. No name is hardcoded ═════════════════════════════════════════ */
    t.section(
      'nothing is hardcoded: the classification comes from the environment',
    );
    t.check(
      'LEGACY_DB_NAMES unset → the real legacy name is NOT treated as legacy',
      !dataSource.isLegacyDatabase(
        'mongodb+srv://u:p@h.example.net/abhigyangurukul',
      ),
    );
    t.check(
      '...nor is this scratch database',
      !dataSource.isLegacyDatabase(process.env.MONGO_URI),
    );
    process.env.LEGACY_DB_NAMES = `someother, ${dbName.toUpperCase()}`;
    t.check(
      'listed (any case, among others) → legacy',
      dataSource.isLegacyDatabase(process.env.MONGO_URI),
    );
    t.check(
      'the name is read from MONGO_URI',
      dataSource.databaseNameOf(process.env.MONGO_URI) === dbName,
    );

    /* ══ 2. The boot policy ══════════════════════════════════════════════ */
    t.section('boot policy on a listed database');
    process.env.TENANT_MODE = 'claim';
    process.env.TENANT_ENFORCEMENT = 'warn';
    process.env.ENABLE_CRON = 'true';
    process.env.PPT_WORKER_EMBEDDED = 'true';
    const policy = dataSource.applyDataSourcePolicy();
    clearOrgStateCache();
    t.check(
      'it is recognised as legacy',
      policy.legacy === true && policy.database === dbName,
    );
    t.check(
      'claim mode is overridden to legacy mode',
      process.env.TENANT_MODE === '' && process.env.TENANT_ENFORCEMENT === '',
    );
    t.check(
      'cron and embedded workers are off',
      process.env.ENABLE_CRON === 'false' &&
        process.env.PPT_WORKER_EMBEDDED === 'false',
    );
    t.check(
      'collections and indexes are not created',
      mongoose.get('autoCreate') === false &&
        mongoose.get('autoIndex') === false,
    );
    t.check(
      'clients are told this is a legacy deployment',
      dataSource.deploymentKind() === 'legacy',
    );

    /* ══ 3. Legacy accounts work ═════════════════════════════════════════ */
    t.section('legacy accounts sign in and use the API');
    const legacyLogin = await login('legacy');
    t.check(
      'sign-in succeeds',
      legacyLogin.status === 200 && Boolean(legacyLogin.json?.token),
      legacyLogin.raw.slice(0, 160),
    );
    const me = await request(port, 'GET', '/api/auth/me', {
      token: legacyLogin.json?.token,
    });
    t.check(
      'no TENANT_REQUIRED: /api/auth/me answers',
      me.status === 200 && me.json?.email === `${RUN}-legacy@example.test`,
      `${me.status} ${me.raw.slice(0, 160)}`,
    );
    const ctx = await request(port, 'GET', '/api/me/context', {
      token: legacyLogin.json?.token,
    });
    t.check(
      '/api/me/context says dataSource "legacy"',
      ctx.status === 200 &&
        ctx.json?.dataSource === 'legacy' &&
        ctx.json?.organization === null,
      ctx.raw.slice(0, 160),
    );
    const users = await request(port, 'GET', '/api/users?role=admin', {
      token: legacyLogin.json?.token,
    });
    t.check(
      'the legacy admin reaches admin data',
      users.status === 200 && Array.isArray(users.json),
      `${users.status} ${users.raw.slice(0, 120)}`,
    );

    /* ══ 4. Organization accounts are refused ════════════════════════════ */
    t.section('organization accounts are refused');
    const orgLogin = await login('org');
    t.check(
      'at sign-in (ORGANIZATION_ACCOUNT)',
      orgLogin.status === 403 &&
        orgLogin.json?.code === 'ORGANIZATION_ACCOUNT' &&
        !orgLogin.json?.token,
      `${orgLogin.status} ${orgLogin.raw.slice(0, 160)}`,
    );
    const foreignToken = signSessionToken({
      id: String(orgUser._id),
      role: 'admin',
      orgId,
      tokenVersion: 0,
    });
    const withToken = await request(port, 'GET', '/api/auth/me', {
      token: foreignToken,
    });
    t.check(
      'with a token issued by the organization system',
      withToken.status === 403 &&
        withToken.json?.code === 'ORGANIZATION_ACCOUNT',
      `${withToken.status} ${withToken.raw.slice(0, 160)}`,
    );
    const pair = signSessionPair({
      id: String(orgUser._id),
      role: 'admin',
      orgId,
      tokenVersion: 0,
    });
    const refreshed = await request(port, 'POST', '/api/auth/refresh', {
      body: { refreshToken: pair.refreshToken },
    });
    t.check(
      'on refresh',
      refreshed.status === 401 &&
        refreshed.json?.code === 'ORGANIZATION_ACCOUNT',
      `${refreshed.status} ${refreshed.raw.slice(0, 160)}`,
    );
    const orgRefusalMsg = String(orgLogin.json?.message ?? '');
    t.check(
      'the message says where to sign in instead',
      /belongs to an organization/i.test(orgRefusalMsg),
      orgRefusalMsg,
    );

    /* ══ 5. Organization system surfaces are closed ══════════════════════ */
    t.section('organization registration and the platform API are not served');
    const application = await request(
      port,
      'POST',
      '/api/public/organization-applications',
      { body: { organization: { name: 'x' } } },
    );
    t.check(
      'organization applications → 404',
      application.status === 404,
      `${application.status} ${application.raw.slice(0, 120)}`,
    );
    const registration = await request(
      port,
      'POST',
      '/api/public/organization-registration',
      { body: {} },
    );
    t.check(
      'organization registration → 404',
      registration.status === 404,
      `${registration.status}`,
    );
    const platform = await request(port, 'GET', '/api/platform/orgs');
    t.check(
      'the platform API → 404',
      platform.status === 404,
      `${platform.status}`,
    );

    /* ══ 6. The index CLI ════════════════════════════════════════════════ */
    t.section(
      'the index CLI uses MONGO_URI only and never changes a legacy database',
    );
    const cli = (env: Record<string, string>) =>
      spawnSync(
        'npx',
        ['ts-node', '--transpile-only', 'src/config/indexes.ts', 'create'],
        {
          env: { ...process.env, ...env },
          encoding: 'utf8',
          shell: process.platform === 'win32',
          timeout: 120000,
        },
      );
    const noUri = cli({ MONGO_URI: '' });
    t.check(
      'without MONGO_URI it stops (no hidden fallback connection)',
      noUri.status !== 0 &&
        /MONGO_URI is not set/.test(`${noUri.stdout}${noUri.stderr}`),
      `${noUri.status} ${`${noUri.stdout}${noUri.stderr}`.slice(-200)}`,
    );
    const legacyCli = cli({
      MONGO_URI: String(process.env.MONGO_URI),
      LEGACY_DB_NAMES: dbName,
    });
    t.check(
      'on a listed database it refuses to create indexes',
      legacyCli.status !== 0 &&
        /Refusing to create indexes/.test(
          `${legacyCli.stdout}${legacyCli.stderr}`,
        ),
      `${legacyCli.status} ${`${legacyCli.stdout}${legacyCli.stderr}`.slice(-200)}`,
    );
    void legacyUser;
  } finally {
    // Put the process back exactly as the harness left it.
    for (const key of Object.keys(process.env))
      if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    mongoose.set('autoCreate', true);
    mongoose.set('autoIndex', true);
    await cleanup().catch((e: Error) =>
      console.error('cleanup failed:', e.message),
    );
    await close();
  }
  t.report();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
