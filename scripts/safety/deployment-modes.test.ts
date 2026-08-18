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
