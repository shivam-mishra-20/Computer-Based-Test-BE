/**
 * Deployment-mode behaviour, exercised through the REAL Express app.
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 * Every other tenancy test drives the layer directly. None of them would have
 * caught the bug this file was written for:
 *
 *   `tenantMode()` defaults to 'pinned' (the safest TENANCY behaviour), and
 *   production sets no TENANT_* variables at all. The middleware's pinned
 *   branch found no ORG_ID and returned 503 — so deploying the tenancy work to
 *   production as-is would have failed EVERY REQUEST. A total outage, caused by
 *   a default chosen to be safe.
 *
 * The lesson generalises: a safe default for tenancy is not automatically a safe
 * default for behaviour. The two have to be decided separately, and the only way
 * to be sure is to boot the app with the environment production actually has.
 *
 * Uses supertest-free plain http against an ephemeral port so it needs no new
 * dependency and no database for the routes it exercises.
 *
 *   npx ts-node --transpile-only scripts/safety/deployment-modes.test.ts
 */

import http from 'http';
import type { AddressInfo } from 'net';

// Registered before app import — models compile on require.
import { registerTenancy } from '../../src/core/tenancy';

process.env.ENABLE_CRON = 'false';
process.env.PPT_WORKER_EMBEDDED = 'false';

// Redis off, for the same two reasons the other app-booting harnesses use:
// it would otherwise reach the SHARED PRODUCTION Redis, and a command timeout
// there made this suite fail intermittently INSIDE the chained safety run while
// passing on its own. A flaky check in a safety suite is worse than no check —
// people learn to re-run red until it goes green. config/redis.ts documents
// that everything Redis backs here is optional.
process.env.REDIS_ENABLED = 'false';

// server.ts installs this; booting `app` alone inherits none of it, and since
// Node 15 one floated rejection from a third-party client terminates the
// process mid-suite.
process.on('unhandledRejection', (reason) => {
  console.warn(
    '  ⚠ unhandled rejection (harness continues, as production does):',
    reason instanceof Error ? reason.message : String(reason),
  );
});

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

/** Clear every tenancy variable, then apply the given ones. */
function setEnv(env: Record<string, string>) {
  for (const key of ['TENANT_MODE', 'ORG_ID', 'TENANT_ENFORCEMENT']) delete process.env[key];
  Object.assign(process.env, env);
}

function request(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('request timed out'));
    });
  });
}

/** POST with a JSON body, for the one unauthenticated platform route. */
function post(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: string; contentType: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        timeout: 8000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: text,
            contentType: String(res.headers['content-type'] ?? ''),
          }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timed out')); });
    req.write(payload);
    req.end();
  });
}

/** GET that also reports the content-type, for the indistinguishability check. */
function getFull(
  port: number,
  path: string,
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 8000 }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: text,
          contentType: String(res.headers['content-type'] ?? ''),
        }),
      );
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timed out')); });
  });
}

/** Representative platform routes: reads, an admin list, and the audit trail. */
const PLATFORM_PROBES: string[] = [
  '/api/platform/me',
  '/api/platform/orgs',
  '/api/platform/dashboard',
  '/api/platform/staff',
  '/api/platform/audit',
];

async function main() {
  console.log('Deployment-mode behaviour (real Express app)\n');

  registerTenancy();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const app = require('../../src/app').default;

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    // ── The outage scenario ────────────────────────────────────────────────
    // Exactly today's production environment: nothing configured.
    console.log("production's CURRENT env (no TENANT_* set at all)");
    setEnv({});
    {
      const res = await request(port, '/api/health');
      check(
        'health endpoint does NOT 503 — pre-migration deploys must keep serving',
        res.status === 200,
        `got ${res.status} — this is the total-outage bug: a defaulted 'pinned' ` +
          `mode with no ORG_ID must not refuse every request`,
      );
      const root = await request(port, '/');
      check('root endpoint still serves', root.status === 200, `got ${root.status}`);
    }

    // ── Deliberate misconfiguration SHOULD refuse ─────────────────────────
    console.log('\nexplicit TENANT_MODE=pinned with NO ORG_ID (a real misconfiguration)');
    setEnv({ TENANT_MODE: 'pinned' });
    {
      const res = await request(port, '/api/health');
      check(
        '503 — someone asked for pinned and forgot the organization',
        res.status === 503,
        `got ${res.status}`,
      );
      check(
        'the refusal names the cause',
        res.body.includes('TENANT_NOT_CONFIGURED'),
        res.body.slice(0, 120),
      );
    }

    // ── api-legacy, correctly configured ──────────────────────────────────
    console.log('\napi-legacy config (pinned + ORG_ID + warn)');
    setEnv({ TENANT_MODE: 'pinned', ORG_ID: 'ORG_001_TEST', TENANT_ENFORCEMENT: 'warn' });
    {
      const res = await request(port, '/api/health');
      check('serves normally', res.status === 200, `got ${res.status}`);
    }

    // ── api-platform, correctly configured ────────────────────────────────
    console.log('\napi-platform config (claim + warn)');
    setEnv({ TENANT_MODE: 'claim', TENANT_ENFORCEMENT: 'warn' });
    {
      const res = await request(port, '/api/health');
      check('serves an unauthenticated diagnostic route', res.status === 200, `got ${res.status}`);
      const root = await request(port, '/');
      check('root still serves', root.status === 200, `got ${root.status}`);
    }

    // ======================================================================
    // PLATFORM SURFACE ISOLATION
    //
    // `/api/platform/*` belongs to api-platform alone. api-legacy is the
    // institute-facing deployment on a public hostname, and it has no business
    // exposing organization, plan, subscription or staff administration.
    //
    // Both modes are driven through ONE booted app, which is the point: the
    // gate is evaluated per request, so this proves the BEHAVIOUR rather than
    // proving that two separate processes were configured differently.
    // ======================================================================

    console.log('\napi-legacy (pinned) must not serve the platform surface');
    setEnv({ TENANT_MODE: 'pinned', ORG_ID: 'ORG_001_TEST', TENANT_ENFORCEMENT: 'warn' });
    {
      for (const path of PLATFORM_PROBES) {
        const res = await getFull(port, path);
        check(`GET ${path} -> 404`, res.status === 404, `got ${res.status}`);
      }

      // Login is the one unauthenticated platform route. A gate that closed the
      // authenticated routes and left the door itself open would be no gate at
      // all, so it gets its own check rather than riding on the loop above.
      const login = await post(port, '/api/platform/login', {
        email: 'someone@platform.test',
        password: 'whatever',
      });
      check('POST /api/platform/login -> 404', login.status === 404, `got ${login.status}`);
      check(
        '  and never reaches authentication',
        !/Invalid credentials/i.test(login.body),
        login.body.slice(0, 120),
      );

      // Indistinguishable from a path nothing is mounted on. A bespoke refusal
      // body would itself disclose that a platform API exists somewhere.
      const gated = await getFull(port, '/api/platform/orgs');
      const absent = await getFull(port, '/api/definitely-not-mounted');
      check(
        'the refusal is the SAME status as an unmounted path',
        gated.status === absent.status,
        `${gated.status} vs ${absent.status}`,
      );
      check(
        '  and the same content-type',
        gated.contentType === absent.contentType,
        `${gated.contentType} vs ${absent.contentType}`,
      );
      check(
        '  the body discloses nothing beyond the path that was asked for',
        !/tenant|claim|deployment|not available/i.test(gated.body),
        gated.body.slice(0, 160),
      );
    }

    console.log('\nthe CURRENT production env is closed too (no TENANT_MODE -> pinned)');
    setEnv({});
    {
      // This is the case that matters most: production sets no TENANT_MODE at
      // all, so it inherits the closed surface without anyone editing an env
      // file. The safe default is doing real work here, not just documenting.
      const res = await getFull(port, '/api/platform/orgs');
      check('platform surface absent when nothing is configured', res.status === 404, `got ${res.status}`);
      const login = await post(port, '/api/platform/login', { email: 'a@b.test', password: 'x' });
      check('  including login', login.status === 404, `got ${login.status}`);
    }

    console.log('\napi-platform (claim) serves it');
    setEnv({ TENANT_MODE: 'claim', TENANT_ENFORCEMENT: 'warn' });
    {
      for (const path of PLATFORM_PROBES) {
        const res = await getFull(port, path);
        check(
          `GET ${path} reaches authentication (401, not 404)`,
          res.status === 401,
          `got ${res.status}`,
        );
      }

      // The gate did not replace authentication: an unauthenticated read is
      // still refused by platformAuthMiddleware, in its own words.
      const me = await getFull(port, '/api/platform/me');
      check(
        '  and the refusal comes from the auth layer, not the gate',
        /credential/i.test(me.body),
        me.body.slice(0, 120),
      );

      // Login is reachable and still validates. A 400 for an empty body proves
      // the handler itself ran, and needs no database to show it.
      const malformed = await post(port, '/api/platform/login', { email: '', password: '' });
      check('POST /api/platform/login is reachable', malformed.status !== 404, `got ${malformed.status}`);
      check(
        "  and still validates its input",
        malformed.status === 400,
        `got ${malformed.status} - expected the handler's own 400`,
      );
    }

    console.log('\nthe tenant and legacy surfaces are unaffected in BOTH modes');
    for (const [label, env] of [
      ['pinned', { TENANT_MODE: 'pinned', ORG_ID: 'ORG_001_TEST', TENANT_ENFORCEMENT: 'warn' }],
      ['claim', { TENANT_MODE: 'claim', TENANT_ENFORCEMENT: 'warn' }],
    ] as [string, Record<string, string>][]) {
      setEnv(env);
      const health = await getFull(port, '/api/health');
      check(`${label}: /api/health still 200`, health.status === 200, `got ${health.status}`);
      const root = await getFull(port, '/');
      check(`${label}: / still 200`, root.status === 200, `got ${root.status}`);
      // A guarded TENANT route must still reach its own auth layer. 401 is the
      // proof: the router is mounted and running, and the platform gate did not
      // reach across into a surface it has no business touching.
      //
      // Chosen because authMiddleware refuses a missing token before any query,
      // so this needs no database — and this harness deliberately boots the app
      // without one. Probing POST /api/auth/login instead HUNG here, because
      // that handler does reach Mongo.
      const tenantRoute = await getFull(port, '/api/users');
      check(
        `${label}: GET /api/users still reaches tenant auth (401, not 404)`,
        tenantRoute.status === 401,
        `got ${tenantRoute.status} - the tenant surface must stay mounted`,
      );
      // A non-API path with its own handler, to show routing outside /api is
      // untouched as well.
      const friendly = await getFull(port, '/login');
      check(
        `${label}: /login still answers with its own handler`,
        friendly.status === 405,
        `got ${friendly.status}`,
      );
    }

    // ── The emergency switch ──────────────────────────────────────────────
    console.log('\nTENANT_ENFORCEMENT=off (emergency escape hatch)');
    setEnv({ TENANT_ENFORCEMENT: 'off' });
    {
      const res = await request(port, '/api/health');
      check('middleware is inert, app serves', res.status === 200, `got ${res.status}`);
    }

    setEnv({});
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log('');
  if (failures) {
    console.error(`DEPLOYMENT-MODE TESTS FAILED — ${failures} of ${checks}.`);
    process.exit(1);
  }
  console.log(`All ${checks} deployment-mode checks passed.`);
  // The app pulls in Redis and Firebase clients that keep the loop alive.
  process.exit(0);
}

main().catch((error) => {
  console.error('deployment-modes.test.ts crashed:', error);
  process.exit(1);
});
