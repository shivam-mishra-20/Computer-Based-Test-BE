/**
 * Legacy regression gate — the real app, the real api-legacy configuration,
 * a verified restore of production.
 *
 * ── What this is, and what it is not ────────────────────────────────────────
 * This is the deployment plan's Step 2 executed as far as it can be executed
 * without a deployment. It boots the actual Express app with EXACTLY the
 * api-legacy environment (pinned + ORG_ID + warn + cron off), points it at the
 * scratch restore — a fingerprint-verified copy of production, already
 * backfilled to Org 001 — and drives the endpoints the legacy Abhigyan app
 * actually calls.
 *
 * It is NOT a substitute for verifying the deployed service. It cannot catch
 * anything about Railway's build, its environment, or its networking. What it
 * DOES catch is the far likelier failure: the api-legacy configuration itself
 * breaking a workflow, against real data shapes rather than fixtures.
 *
 * ── Endpoint selection ──────────────────────────────────────────────────────
 * Taken from docs/baselines/legacy-client-surface-*.txt — the 158 routes the
 * legacy mobile app was measured to consume. The subset below covers each
 * workflow the deployment plan names, biased toward reads because a regression
 * harness must not mutate a restore it also verifies.
 *
 *   npx ts-node --transpile-only scripts/safety/legacy-regression.test.ts \
 *     --scratch-suffix restore_2026_08_17
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { config } from 'dotenv';
import { assertNotProduction, configureDnsForSrv, redactUri, requireEnv } from './lib';

config();

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] ?? null : null;
}

function deriveScratchUri(productionUri: string, suffix: string): string {
  const m = productionUri.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/);
  if (!m) throw new Error('MONGO_URI could not be parsed.');
  return `${m[1]}${m[2]}_${suffix}${m[3] ?? ''}`;
}

const PROBE_EMAIL = 'zz-legacy-regression-probe@internal.test';
const PROBE_PASSWORD = 'Probe!Passw0rd-2026';

let failures = 0;
let checks = 0;
const workflowResults: { workflow: string; ok: boolean; detail: string }[] = [];

function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

interface Res {
  status: number;
  json: unknown;
  raw: string;
}

function request(
  port: number,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        timeout: 25_000,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* non-JSON is fine — status is what matters */
          }
          resolve({ status: res.statusCode ?? 0, json: parsed, raw });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`timeout on ${method} ${path}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * A legacy workflow passes when it does NOT return a server error and is not
 * refused by the tenancy layer.
 *
 * 4xx is acceptable: many of these need data this restore may not have, and a
 * 404 for a missing record is correct behaviour, not a regression. What must
 * never appear is a 5xx, or a 503 TENANT_NOT_CONFIGURED — those mean the
 * api-legacy configuration itself broke the endpoint.
 */
function workflowOk(res: Res): boolean {
  if (res.status >= 500) return false;
  if (res.status === 503) return false;
  const code = (res.json as { code?: string } | null)?.code;
  return code !== 'TENANT_CONTEXT_MISSING' && code !== 'TENANT_NOT_CONFIGURED';
}

async function main() {
  const productionUri = requireEnv('MONGO_URI');
  const suffix = arg('--scratch-suffix');
  if (!suffix) {
    console.error('Usage: legacy-regression.test.ts --scratch-suffix <suffix>');
    process.exit(2);
  }
  const uri = deriveScratchUri(productionUri, suffix);
  assertNotProduction(uri, productionUri); // creates a probe user — never production

  configureDnsForSrv();

  // ── EXACT api-legacy configuration ──────────────────────────────────────
  process.env.MONGO_URI = uri;
  process.env.TENANT_MODE = 'pinned';
  process.env.TENANT_ENFORCEMENT = 'warn';
  process.env.ENABLE_CRON = 'false';
  process.env.PPT_WORKER_EMBEDDED = 'false';

  // Redis off for this harness. Two reasons, both deliberate:
  //   1. It would otherwise connect to the SHARED PRODUCTION Redis, and a test
  //      run has no business writing rate-limit keys or Socket.IO traffic there.
  //   2. `config/redis.ts` documents that everything Redis backs here is
  //      optional — rate limiting degrades to an in-memory store. Turning it off
  //      exercises a supported configuration rather than a broken one.
  process.env.REDIS_ENABLED = 'false';

  // `server.ts` installs this so a floated rejection from a third-party client
  // cannot kill a healthy server — since Node 15 an unhandled rejection
  // terminates the process. This harness boots `app` WITHOUT server.ts, so it
  // inherited none of that and a single Redis command timeout crashed the whole
  // run. Mirroring it here keeps the harness as tolerant as the real server.
  process.on('unhandledRejection', (reason) => {
    console.warn(
      '  ⚠ unhandled rejection (harness continues, as production does):',
      reason instanceof Error ? reason.message : String(reason),
    );
  });

  // Registered before the app compiles any model.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registerTenancy } = require('../../src/core/tenancy');
  registerTenancy();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mongoose = require('mongoose');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { withoutTenantScope } = require('../../src/core/tenancy/context');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Org = require('../../src/models/Org').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const User = require('../../src/models/User').default;

  const org001 = await withoutTenantScope('regression:find-org', () =>
    Org.findOne({ slug: 'abhigyan' }),
  );
  if (!org001) throw new Error('Org 001 missing — seed and backfill this database first.');
  const orgId = String(org001._id);
  process.env.ORG_ID = orgId;

  console.log(`[legacy-regression] target : ${redactUri(uri)}`);
  console.log(`[legacy-regression] config : TENANT_MODE=pinned ORG_ID=${orgId} ENFORCEMENT=warn\n`);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const app = require('../../src/app').default;
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  let probeId: string | null = null;

  try {
    // ── Probe account ─────────────────────────────────────────────────────
    // Created through the MODEL so the pre-save hook hashes the password, and
    // deliberately WITHOUT an explicit orgId — whether the plugin stamps it is
    // one of the things under test.
    await withoutTenantScope('regression:cleanup-probe', () =>
      User.deleteOne({ email: PROBE_EMAIL }),
    );

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { runWithTenant } = require('../../src/core/tenancy/context');
    const probe = await runWithTenant({ orgId, source: 'test' }, () =>
      User.create({
        name: 'Legacy Regression Probe',
        email: PROBE_EMAIL,
        password: PROBE_PASSWORD,
        role: 'admin',
        status: 'approved',
      }),
    );
    probeId = String(probe._id);

    // ── orgId stamping on write ───────────────────────────────────────────
    console.log('orgId stamping (pinned mode)');
    const stamped = await withoutTenantScope('regression:read-probe', () =>
      User.findById(probeId).lean(),
    );
    check(
      'a newly written document receives orgId = Org 001',
      String((stamped as { orgId?: string })?.orgId) === orgId,
      `got orgId=${String((stamped as { orgId?: string })?.orgId)}`,
    );

    // ── Authentication ────────────────────────────────────────────────────
    console.log('\nauthentication');
    const login = await request(port, 'POST', '/api/auth/login', undefined, {
      email: PROBE_EMAIL,
      password: PROBE_PASSWORD,
    });
    const token = (login.json as { token?: string } | null)?.token;
    check('POST /api/auth/login succeeds', login.status === 200 && Boolean(token), `status ${login.status}`);

    if (!token) {
      throw new Error('login failed — cannot exercise authenticated workflows');
    }

    const me = await request(port, 'GET', '/api/auth/me', token);
    check('GET /api/auth/me returns the session', me.status === 200, `status ${me.status}`);

    // ── Legacy workflows ──────────────────────────────────────────────────
    // Every path below is one the legacy mobile app or web admin calls.
    const workflows: { workflow: string; method: string; path: string }[] = [
      { workflow: 'dashboard', method: 'GET', path: '/api/users/dashboard' },
      { workflow: 'users', method: 'GET', path: '/api/users' },
      { workflow: 'students', method: 'GET', path: '/api/teacher/students' },
      { workflow: 'teachers', method: 'GET', path: '/api/users?role=teacher' },
      { workflow: 'exams', method: 'GET', path: '/api/exams' },
      { workflow: 'exam attempt (assigned)', method: 'GET', path: '/api/attempts/assigned' },
      { workflow: 'attempt history', method: 'GET', path: '/api/attempts/mine' },
      { workflow: 'results', method: 'GET', path: '/api/results' },
      { workflow: 'offline results', method: 'GET', path: '/api/offline-results/student/upcoming' },
      { workflow: 'question bank', method: 'GET', path: '/api/ai/questions/class/11' },
      { workflow: 'attendance', method: 'GET', path: '/api/attendance/my' },
      { workflow: 'attendance summary', method: 'GET', path: '/api/attendance/summary' },
      { workflow: 'notifications', method: 'GET', path: '/api/notifications' },
      { workflow: 'files (materials)', method: 'GET', path: '/api/materials' },
      { workflow: 'scheduling', method: 'GET', path: '/api/schedule' },
      { workflow: 'schedule live', method: 'GET', path: '/api/schedule/live' },
      { workflow: 'homework', method: 'GET', path: '/api/homework' },
      { workflow: 'courses', method: 'GET', path: '/api/courses' },
      { workflow: 'announcements', method: 'GET', path: '/api/announcements' },
      { workflow: 'doubts', method: 'GET', path: '/api/doubts' },
      { workflow: 'leaderboard', method: 'GET', path: '/api/leaderboard' },
      { workflow: 'admin settings', method: 'GET', path: '/api/admin/settings' },
      { workflow: 'admin audit logs', method: 'GET', path: '/api/admin/audit-logs' },
      { workflow: 'batches', method: 'GET', path: '/api/teacher/batches' },
      { workflow: 'syllabus', method: 'GET', path: '/api/syllabus' },
      { workflow: 'study resources', method: 'GET', path: '/api/resources' },
      { workflow: 'holidays', method: 'GET', path: '/api/holidays' },
      { workflow: 'leaves', method: 'GET', path: '/api/leaves' },
    ];

    console.log('\nlegacy workflows through api-legacy config');
    for (const w of workflows) {
      let res: Res;
      try {
        res = await request(port, w.method, w.path, token);
      } catch (error) {
        res = { status: 0, json: null, raw: String(error) };
      }
      const ok = workflowOk(res);
      workflowResults.push({ workflow: w.workflow, ok, detail: `${res.status}` });
      check(`${w.workflow.padEnd(24)} ${w.method} ${w.path} → ${res.status}`, ok,
        res.status >= 500 ? res.raw.slice(0, 200) : 'refused by the tenancy layer');
    }

    // ── Unscoped operations during the run ────────────────────────────────
    console.log('\nwarn-mode observation for this run');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getUnscopedReport } = require('../../src/core/tenancy/plugin');
    const unscoped = getUnscopedReport() as { model: string; operation: string; count: number }[];
    if (unscoped.length) {
      for (const u of unscoped.slice(0, 15)) {
        console.log(`    ! ${u.model}.${u.operation}  ×${u.count}`);
      }
    }
    check(
      'no unscoped tenant operations during legacy workflows',
      unscoped.length === 0,
      `${unscoped.length} distinct unscoped operation(s) — each is a path the ` +
        `pinned context did not reach`,
    );
  } finally {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { withoutTenantScope: cleanup } = require('../../src/core/tenancy/context');
      await cleanup('regression:cleanup', () => User.deleteOne({ email: PROBE_EMAIL }));
      console.log('\n  probe account removed');
    } catch (error) {
      console.error('  cleanup failed:', (error as Error).message);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mongoose.connection.close();
  }

  const passed = workflowResults.filter((w) => w.ok).length;
  console.log(`\n─── workflows: ${passed}/${workflowResults.length} ───`);

  if (failures) {
    console.error(`\nLEGACY REGRESSION FAILED — ${failures} of ${checks} checks.`);
    process.exit(1);
  }
  console.log(`All ${checks} legacy regression checks passed.`);
  process.exit(0);
}

main().catch((error) => {
  console.error('[legacy-regression] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
