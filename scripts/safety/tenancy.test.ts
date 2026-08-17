/**
 * Tenancy behaviour tests — no database, no network, under a second.
 *
 * These exist to prove the two properties the whole migration rests on:
 *
 *   1. WARN MODE NEVER FILTERS A READ.
 *      During the warn period orgId is not backfilled yet. If observation
 *      subtracted documents, every screen in production would go blank the
 *      moment this shipped. This is the property that makes the change safe to
 *      deploy to a live system.
 *
 *   2. ENFORCE MODE FAILS CLOSED.
 *      No context means throw — never fall back to an organization, never
 *      return unscoped results, never log-and-continue.
 *
 * They inspect the query object the plugin produced rather than hitting Mongo,
 * so they can gate a pull request.
 *
 *   npx ts-node scripts/safety/tenancy.test.ts
 */

import mongoose from 'mongoose';
import { tenantPlugin, resetUnscopedReport, getUnscopedReport } from '../../src/core/tenancy/plugin';
import {
  runWithTenant,
  withoutTenantScope,
  runWithoutAnyContext,
} from '../../src/core/tenancy/context';
import { TenantContextMissing } from '../../src/core/tenancy/errors';

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function setEnv(enforcement: string, mode = 'pinned') {
  process.env.TENANT_ENFORCEMENT = enforcement;
  process.env.TENANT_MODE = mode;
}

// Two models: one scoped, one deliberately exempt like Org/Plan/PlatformUser.
mongoose.plugin(tenantPlugin);

interface TestDoc {
  title?: string;
  classLevel?: string;
  name?: string;
  orgId?: string;
}

const Scoped = mongoose.model<TestDoc>(
  'TestScoped',
  new mongoose.Schema<TestDoc>({ title: String, classLevel: String }),
);
const Exempt = mongoose.model<TestDoc>(
  'TestExempt',
  new mongoose.Schema<TestDoc>({ name: String }, { tenantScoped: false } as never),
);

/** The filter the plugin ended up applying to a query. */
function filterOf(query: mongoose.Query<unknown, unknown>): Record<string, unknown> {
  // Running the pre hooks without a live connection: exec() would try to
  // connect, so the hooks are invoked directly against the query object.
  const hooks = (query as unknown as { _hooks?: unknown })._hooks;
  void hooks;
  return query.getFilter() as Record<string, unknown>;
}

async function runHooks(query: mongoose.Query<unknown, unknown>): Promise<Error | null> {
  try {
    await new Promise<void>((resolve, reject) => {
      (query as unknown as { _callQueryPreHooks?: unknown });
      // mongoose exposes pre-hook execution through the internal kareem
      // instance; calling it directly is what lets these tests avoid a database.
      const model = (query as unknown as { model: { hooks: { execPre: Function } } }).model;
      model.hooks.execPre(
        (query as unknown as { op: string }).op,
        query,
        [],
        (err?: Error) => (err ? reject(err) : resolve()),
      );
    });
    return null;
  } catch (error) {
    return error as Error;
  }
}

async function main() {
  console.log('Tenancy plugin behaviour\n');

  // ── Schema fields ────────────────────────────────────────────────────────
  console.log('schema');
  check('scoped model gains orgId', Boolean(Scoped.schema.path('orgId')));
  check('scoped model gains branchId', Boolean(Scoped.schema.path('branchId')));
  check('orgId is NOT required in P1', Scoped.schema.path('orgId').isRequired !== true);
  check('exempt model has no orgId', !Exempt.schema.path('orgId'));

  // ── Property 1: warn never filters ───────────────────────────────────────
  console.log('\nwarn mode — the property that makes this deployable');
  setEnv('warn');
  resetUnscopedReport();

  {
    const query = Scoped.find({ classLevel: '11' });
    await runHooks(query);
    const filter = filterOf(query);
    check(
      'WARN + context: read is NOT filtered by orgId',
      filter.orgId === undefined,
      `filter was ${JSON.stringify(filter)} — warn mode must not subtract documents`,
    );
  }

  await runWithTenant({ orgId: 'ORG_001', source: 'test' }, async () => {
    const query = Scoped.find({ classLevel: '11' });
    await runHooks(query);
    const filter = filterOf(query);
    check(
      'WARN inside a tenant context: still NOT filtered',
      filter.orgId === undefined,
      `filter was ${JSON.stringify(filter)}`,
    );
    check('original criteria preserved', filter.classLevel === '11');
  });

  {
    resetUnscopedReport();
    await runWithoutAnyContext(async () => {
      const query = Scoped.find({});
      const error = await runHooks(query);
      check('WARN without context: does NOT throw', error === null, String(error?.message));
    });
    const report = getUnscopedReport();
    check('WARN without context: records the event for the gate', report.length > 0);
  }

  // ── Property 2: enforce fails closed ─────────────────────────────────────
  console.log('\nenforce mode — fail closed');
  setEnv('enforce');

  await runWithTenant({ orgId: 'ORG_001', source: 'test' }, async () => {
    const query = Scoped.find({ classLevel: '11' });
    await runHooks(query);
    const filter = filterOf(query);
    check('ENFORCE + context: read IS filtered by orgId', filter.orgId === 'ORG_001');
    check('ENFORCE: original criteria preserved', filter.classLevel === '11');
  });

  await runWithoutAnyContext(async () => {
    const query = Scoped.find({});
    const error = await runHooks(query);
    check(
      'ENFORCE without context: THROWS',
      error instanceof TenantContextMissing || error?.name === 'TenantContextMissing',
      `got ${error ? error.name + ': ' + error.message : 'no error — THIS IS A LEAK'}`,
    );
  });

  await runWithoutAnyContext(async () => {
    const query = Scoped.find({});
    const error = await runHooks(query);
    const filter = filterOf(query);
    check(
      'ENFORCE without context: does NOT fall back to an org',
      error !== null && filter.orgId === undefined,
      'a fallback org would silently serve another tenant',
    );
  });

  // ── Explicit opt-out ─────────────────────────────────────────────────────
  console.log('\nwithoutTenantScope');
  await withoutTenantScope('test:auth-resolve-org-by-email', async () => {
    const query = Scoped.find({});
    const error = await runHooks(query);
    check('ENFORCE + opt-out: does not throw', error === null, String(error?.message));
    check('ENFORCE + opt-out: not filtered', filterOf(query).orgId === undefined);
  });

  let rejectedEmptyReason = false;
  try {
    withoutTenantScope('', () => undefined);
  } catch {
    rejectedEmptyReason = true;
  }
  check('opt-out requires a reason (keeps the audit grep complete)', rejectedEmptyReason);

  // ── Exempt models ────────────────────────────────────────────────────────
  console.log('\nexempt collections');
  await runWithoutAnyContext(async () => {
    const query = Exempt.find({});
    const error = await runHooks(query);
    check('exempt model is never scoped and never throws', error === null);
  });

  // ── off ──────────────────────────────────────────────────────────────────
  console.log('\noff — emergency escape hatch');
  setEnv('off');
  await runWithoutAnyContext(async () => {
    const query = Scoped.find({});
    const error = await runHooks(query);
    check('OFF without context: inert', error === null && filterOf(query).orgId === undefined);
  });

  // ── Cron gating regression ───────────────────────────────────────────────
  console.log('\ncron gating (production-behaviour regression)');
  {
    delete process.env.TENANT_MODE;
    delete process.env.ENABLE_CRON;
    // Re-read the module fresh so the env change is observed.
    const cfgPath = require.resolve('../../src/core/tenancy/config');
    delete require.cache[cfgPath];
    const cfg = require('../../src/core/tenancy/config');
    check(
      'no TENANT_MODE set (today\'s production): cron STILL RUNS',
      cfg.shouldRunScheduledJobs() === true,
      'a defaulted pinned mode must not silently disable attendance sync',
    );
    process.env.TENANT_MODE = 'pinned';
    delete require.cache[cfgPath];
    const cfg2 = require('../../src/core/tenancy/config');
    check('explicit TENANT_MODE=pinned (api-legacy): cron disabled', cfg2.shouldRunScheduledJobs() === false);
  }

  console.log('');
  if (failures) {
    console.error(`TENANCY TESTS FAILED — ${failures} of ${checks} checks.`);
    process.exit(1);
  }
  console.log(`All ${checks} tenancy checks passed.`);
  process.exit(0);
}

main().catch((error) => {
  console.error('tenancy.test.ts crashed:', error);
  process.exit(1);
});
