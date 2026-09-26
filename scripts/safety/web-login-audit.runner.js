/**
 * Runs the browser sign-in suites end to end, and cleans up after itself.
 *
 *   1. builds client-platform-web into `.next-e2e` (beside, never over, a
 *      developer's running `next dev`), pointed at two local fixture backends;
 *   2. starts them on SCRATCH databases:
 *        :5071  the organization system  (claim mode, `…_console_scratch_app`)
 *        :5072  the legacy system        (`p6_client_platform_web_scratch`,
 *               listed in LEGACY_DB_NAMES, so the real legacy policy applies)
 *      and the web on :3210;
 *   3. runs `web-login-audit` and `web-single-login` against them;
 *   4. restarts :5071 as ONE backend serving the legacy database at the
 *      organization address (a developer switching MONGO_URI) and runs the
 *      audit's `single-legacy` phase;
 *   5. stops every process it started — whatever happened.
 *
 * Neither fixture backend creates collections (the shared cluster sits at its
 * collection cap): the legacy one because the legacy-database policy turns
 * Mongoose's autoCreate/autoIndex off, the organization one via
 * P6_AUTO_CREATE=false.
 *
 *   node scripts/safety/web-login-audit.runner.js [--skip-build] [--only audit|single-login|single-legacy]
 *
 * Environment: MONGO_URI (from .env — only its cluster and credentials are
 * used), WEB_DIR (default ../client-platform-web), SCRATCH_DB_NAME (default
 * abhigyangurukul_console_scratch_app), LEGACY_SCRATCH_DB_NAME (default
 * p6_client_platform_web_scratch), WL_LOGS (default the OS temp directory).
 */
require('dotenv').config({ quiet: true });
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const WEB_DIR = path.resolve(
  process.env.WEB_DIR || path.join(ROOT, '..', 'client-platform-web'),
);
const LOGS = process.env.WL_LOGS || path.join(os.tmpdir(), 'web-login-audit');
const PLATFORM_PORT = 5071;
const LEGACY_PORT = 5072;
const WEB_PORT = 3210;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const CONSOLE_SCRATCH =
  process.env.SCRATCH_DB_NAME || 'abhigyangurukul_console_scratch_app';
const LEGACY_SCRATCH =
  process.env.LEGACY_SCRATCH_DB_NAME || 'p6_client_platform_web_scratch';
const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex > -1 ? args[onlyIndex + 1] : null;

fs.mkdirSync(LOGS, { recursive: true });

function withDatabase(uri, name) {
  const m = uri.match(
    /^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/,
  );
  if (!m) throw new Error('MONGO_URI could not be parsed.');
  return `${m[1]}${name}${m[3] || ''}`;
}

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) throw new Error('MONGO_URI is not set.');
for (const name of [CONSOLE_SCRATCH, LEGACY_SCRATCH]) {
  if (!/(^|[_-])scratch([_-]|$)/i.test(name))
    throw new Error(`Refusing "${name}": not a scratch database.`);
}

const started = [];

function start(label, command, commandArgs, options) {
  const log = fs.openSync(path.join(LOGS, `${label}.log`), 'w');
  const child = spawn(command, commandArgs, {
    ...options,
    shell: process.platform === 'win32',
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  started.push({ label, child });
  console.log(
    `[runner] started ${label} (pid ${child.pid}) → ${path.join(LOGS, `${label}.log`)}`,
  );
  return child;
}

function stop(entry) {
  if (!entry || entry.child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(entry.child.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
  } else {
    try {
      process.kill(entry.child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  console.log(`[runner] stopped ${entry.label}`);
}

function stopAll() {
  while (started.length) stop(started.pop());
}

function stopLabel(label) {
  const i = started.findIndex((s) => s.label === label);
  if (i > -1) stop(started.splice(i, 1)[0]);
}

function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('error', () => resolve(0));
    req.setTimeout(4000, () => req.destroy());
  });
}

async function waitFor(url, label, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const status = await get(url);
    if (status >= 200 && status < 500) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `${label} did not come up at ${url} within ${Math.round(timeoutMs / 1000)}s (see ${LOGS}).`,
  );
}

function run(label, command, commandArgs, options) {
  console.log(`\n[runner] ${label}`);
  const res = spawnSync(command, commandArgs, {
    ...options,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  return res.status === null ? 1 : res.status;
}

function fixture(label, port, database, extraEnv) {
  return start(label, 'node', ['scripts/safety/p6-fixture-server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      P6_MONGO_URI: withDatabase(MONGO_URI, database),
      P6_PORT: String(port),
      CORS_ORIGIN: WEB,
      AUTH_RATE_LIMIT_MAX: '5000',
      PUBLIC_FORM_RATE_LIMIT_MAX: '5000',
      ...extraEnv,
    },
  });
}

async function main() {
  const results = [];

  if (!skipBuild) {
    // `next build` rewrites tsconfig.json to include its types folder; put it back.
    const tsconfig = path.join(WEB_DIR, 'tsconfig.json');
    const original = fs.readFileSync(tsconfig, 'utf8');
    try {
      const status = run(
        'building client-platform-web into .next-e2e',
        'npx',
        ['next', 'build'],
        {
          cwd: WEB_DIR,
          env: {
            ...process.env,
            NEXT_DIST_DIR: '.next-e2e',
            NEXT_PUBLIC_API_BASE_URL: `http://127.0.0.1:${PLATFORM_PORT}/api`,
            NEXT_PUBLIC_LEGACY_API_BASE_URL: `http://127.0.0.1:${LEGACY_PORT}/api`,
            NODE_OPTIONS: '--max-old-space-size=6144',
            NEXT_TELEMETRY_DISABLED: '1',
          },
        },
      );
      if (status !== 0) throw new Error(`next build failed (${status}).`);
    } finally {
      fs.writeFileSync(tsconfig, original);
    }
  }

  fixture('platform', PLATFORM_PORT, CONSOLE_SCRATCH, {
    P6_MODE: 'platform',
    P6_AUTO_CREATE: 'false',
  });
  fixture('legacy', LEGACY_PORT, LEGACY_SCRATCH, {
    P6_MODE: 'legacy',
    LEGACY_DB_NAMES: LEGACY_SCRATCH,
  });
  start(
    'web',
    'npx',
    ['next', 'start', '-p', String(WEB_PORT), '-H', '127.0.0.1'],
    {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        NEXT_DIST_DIR: '.next-e2e',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    },
  );
  await waitFor(
    `http://127.0.0.1:${PLATFORM_PORT}/api/health`,
    'the organization system',
  );
  await waitFor(
    `http://127.0.0.1:${LEGACY_PORT}/api/health`,
    'the legacy system',
  );
  await waitFor(`${WEB}/login`, 'the web');

  const suiteEnv = {
    ...process.env,
    SCRATCH_DB_NAME: CONSOLE_SCRATCH,
    WL_WEB: WEB,
    WL_PLATFORM_PORT: String(PLATFORM_PORT),
    WL_LEGACY_PORT: String(LEGACY_PORT),
    WL_LEGACY_URI: withDatabase(MONGO_URI, LEGACY_SCRATCH),
  };
  const ts = ['ts-node', '--transpile-only'];

  if (!only || only === 'audit') {
    results.push([
      'web-login-audit (two systems)',
      run(
        'web-login-audit — two systems',
        'npx',
        [...ts, 'scripts/safety/web-login-audit.e2e.test.ts'],
        { cwd: ROOT, env: suiteEnv },
      ),
    ]);
  }
  if (!only || only === 'single-login') {
    results.push([
      'web-single-login',
      run(
        'web-single-login',
        'npx',
        [...ts, 'scripts/safety/web-single-login.e2e.test.ts'],
        { cwd: ROOT, env: suiteEnv },
      ),
    ]);
  }
  if (!only || only === 'single-legacy') {
    // One backend at the organization address, over the legacy database —
    // configured exactly as a developer's `.env` would be: claim mode, with the
    // database listed in LEGACY_DB_NAMES.
    stopLabel('platform');
    stopLabel('legacy');
    fixture('platform-legacy-db', PLATFORM_PORT, LEGACY_SCRATCH, {
      P6_MODE: 'platform',
      LEGACY_DB_NAMES: LEGACY_SCRATCH,
    });
    await waitFor(
      `http://127.0.0.1:${PLATFORM_PORT}/api/health`,
      'the single legacy backend',
    );
    results.push([
      'web-login-audit (one backend, legacy database)',
      run(
        'web-login-audit — one backend, legacy database',
        'npx',
        [...ts, 'scripts/safety/web-login-audit.e2e.test.ts'],
        {
          cwd: ROOT,
          env: { ...suiteEnv, WL_PHASE: 'single-legacy' },
        },
      ),
    ]);
  }

  console.log('\n[runner] results');
  for (const [name, status] of results)
    console.log(`  ${status === 0 ? 'PASS' : 'FAIL'}  ${name}`);
  return results.every(([, status]) => status === 0) ? 0 : 1;
}

let code = 1;
main()
  .then((c) => {
    code = c;
  })
  .catch((e) => {
    console.error('[runner]', e.message);
    code = 1;
  })
  .finally(() => {
    stopAll();
    process.exit(code);
  });
process.on('SIGINT', () => {
  stopAll();
  process.exit(130);
});
