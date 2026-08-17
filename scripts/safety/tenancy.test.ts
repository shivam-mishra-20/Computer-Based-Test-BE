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

  // ── forEachOrg ───────────────────────────────────────────────────────────
  // Cron is the one place where "no tenant context" is the normal state, which
  // makes it the likeliest source of a silent cross-tenant mistake.
  console.log('\nforEachOrg — cron and scheduled work');
  setEnv('warn');
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { forEachOrg } = require('../../src/core/tenancy/forEachOrg');
    const { currentOrgId } = require('../../src/core/tenancy/context');

    // 1. Pinned deployment — exactly one org, taken from configuration.
    process.env.TENANT_MODE = 'pinned';
    process.env.ORG_ID = 'ORG_001';
    const seenPinned: (string | null)[] = [];
    const pinnedSummary = await forEachOrg('test-pinned', async () => {
      seenPinned.push(currentOrgId());
    });
    check('pinned: runs exactly once', pinnedSummary.total === 1 && pinnedSummary.succeeded === 1);
    check('pinned: inside the configured org context', seenPinned[0] === 'ORG_001');

    // 2. THE FALLBACK THAT KEEPS PRODUCTION WORKING.
    //    Today's production has no Org documents. If cron required them, the
    //    four daily attendance syncs would stop the moment this deployed.
    delete process.env.TENANT_MODE;
    delete process.env.ORG_ID;
    let ranWithoutOrgs = 0;
    const emptySummary = await forEachOrg('test-empty', async () => {
      ranWithoutOrgs++;
    });
    check(
      'no orgs seeded yet: work STILL RUNS (pre-migration behaviour preserved)',
      ranWithoutOrgs === 1 && emptySummary.mode === 'uncontextualized',
      'requiring Org documents would stop attendance sync on deploy',
    );

    // 3. Failure isolation — one org failing must not abort the rest.
    process.env.TENANT_MODE = 'pinned';
    process.env.ORG_ID = 'ORG_001';
    const failSummary = await forEachOrg('test-fail', async () => {
      throw new Error('simulated org failure');
    });
    check(
      'a failing org is reported, not rethrown',
      failSummary.failed === 1 && failSummary.succeeded === 0,
    );
    delete process.env.ORG_ID;
  }

  // ── tenantLookup ─────────────────────────────────────────────────────────
  // The plugin scopes the collection an aggregation runs ON but cannot reach
  // inside a $lookup — the joined collection is read without passing through
  // its own middleware.
  console.log('\ntenantLookup — the join the plugin cannot reach');
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { tenantLookup } = require('../../src/core/tenancy/tenantLookup');
    const spec = { from: 'users', localField: 'user', foreignField: '_id', as: 'student' };

    setEnv('warn');
    const warnStage = tenantLookup(spec) as any;
    check(
      'WARN: emits the plain stage, byte-identical to the original code',
      warnStage.$lookup.localField === 'user' &&
        warnStage.$lookup.foreignField === '_id' &&
        !warnStage.$lookup.pipeline,
      'a scoped sub-pipeline under warn would match nothing — orgId is not backfilled yet',
    );

    setEnv('enforce');
    await runWithTenant({ orgId: 'ORG_001', source: 'test' }, async () => {
      const stage = tenantLookup(spec) as any;
      const match = stage.$lookup.pipeline?.[0]?.$match;
      check('ENFORCE: emits a sub-pipeline', Array.isArray(stage.$lookup.pipeline));
      check('ENFORCE: sub-pipeline constrains orgId', match?.orgId === 'ORG_001');
      check(
        'ENFORCE: join predicate preserved alongside the orgId constraint',
        Boolean(match?.$expr),
        'dropping $expr would join every row in the collection',
      );
      check(
        'ENFORCE: orgId and join predicate share ONE $match',
        match?.orgId !== undefined && match?.$expr !== undefined,
        'separating them invites a refactor that drops the tenant constraint',
      );
    });

    // A global collection has no orgId — constraining it would match nothing.
    await runWithTenant({ orgId: 'ORG_001', source: 'test' }, async () => {
      const stage = tenantLookup({ ...spec, from: 'orgs', global: true }) as any;
      check('ENFORCE + global:true: stays a plain join', !stage.$lookup.pipeline);
    });

    // Inside an explicit opt-out the caller has taken responsibility.
    setEnv('enforce');
    await withoutTenantScope('test:lookup-optout', async () => {
      const stage = tenantLookup(spec) as any;
      check('ENFORCE + withoutTenantScope: plain join, opt-out honoured', !stage.$lookup.pipeline);
    });
  }

  // ── Public-route allowlist ───────────────────────────────────────────────
  console.log('\npublic-route allowlist — every bypass explicit and justified');
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {
      PUBLIC_ROUTE_ALLOWLIST,
      DELIBERATELY_NOT_ALLOWLISTED,
      findPublicRoute,
    } = require('../../src/core/tenancy/publicRoutes');

    check(
      'every entry carries a reason',
      PUBLIC_ROUTE_ALLOWLIST.every((e: any) => e.reason && e.reason.trim().length > 3),
    );
    check(
      'every entry carries a justification',
      PUBLIC_ROUTE_ALLOWLIST.every((e: any) => e.justification && e.justification.length > 20),
    );
    check(
      'every entry is classified',
      PUBLIC_ROUTE_ALLOWLIST.every((e: any) =>
        ['pre-auth', 'public-global', 'platform-global', 'diagnostic'].includes(e.classification),
      ),
    );

    // The count is asserted so the list cannot grow quietly. Changing it is
    // meant to require editing this number, which forces a reviewer to look.
    check(
      `allowlist size is exactly ${PUBLIC_ROUTE_ALLOWLIST.length} (update deliberately)`,
      PUBLIC_ROUTE_ALLOWLIST.length === 19,
      `got ${PUBLIC_ROUTE_ALLOWLIST.length} — if intentional, update the test`,
    );

    check('login is allowlisted', findPublicRoute('POST', '/api/auth/login') !== null);
    check(
      'param routes match',
      findPublicRoute('GET', '/api/scholarship/tests/abc123') !== null,
    );
    check(
      'method is respected — DELETE on an allowlisted GET path is NOT bypassed',
      findPublicRoute('DELETE', '/api/scholarship/tests') === null,
    );
    check(
      'tenant data routes are NOT bypassed',
      findPublicRoute('GET', '/api/users') === null &&
        findPublicRoute('GET', '/api/attempts/assigned') === null &&
        findPublicRoute('GET', '/api/exams') === null,
    );
    check(
      'prefix confusion rejected — /api/auth/loginX is not /api/auth/login',
      findPublicRoute('POST', '/api/auth/loginX') === null,
    );
    check(
      'the unauthenticated webhook is deliberately NOT allowlisted',
      findPublicRoute('POST', '/api/webhooks/attendance') === null &&
        DELIBERATELY_NOT_ALLOWLISTED.includes('POST /api/webhooks/attendance'),
      'allowlisting it would bless an unauthenticated write',
    );
  }

  // ── Lazy thenables ───────────────────────────────────────────────────────
  // A Mongoose Query executes when .then() is called, not when it is built. If
  // the helpers returned it unstarted, the caller's `await` would run it AFTER
  // the context closed — silently unscoped. Found for real while writing the
  // two-org isolation test, where it threw TenantContextMissing on a call that
  // looked completely correct.
  console.log('\nlazy thenables — the invisible-async footgun');
  {
    setEnv('warn');

    /** Stands in for a Mongoose Query: does nothing until .then() is called. */
    function makeLazyQuery() {
      let contextAtExecution: string | null | undefined;
      return {
        get seen() {
          return contextAtExecution;
        },
        then(resolve: (v: unknown) => void) {
          const { currentOrgId } = require('../../src/core/tenancy/context');
          contextAtExecution = currentOrgId();
          resolve(contextAtExecution);
        },
      };
    }

    const lazy = makeLazyQuery();
    // The NON-async form — the one that reads as obviously correct.
    await runWithTenant({ orgId: 'ORG_LAZY', source: 'test' }, () => lazy as never);
    check(
      'runWithTenant starts a lazy query INSIDE the context',
      lazy.seen === 'ORG_LAZY',
      `context at execution was ${String(lazy.seen)} — an unstarted query escapes the scope`,
    );

    const lazy2 = makeLazyQuery();
    await withoutTenantScope('test:lazy', () => lazy2 as never);
    check(
      'withoutTenantScope also starts it inside the opt-out',
      lazy2.seen === null,
      `context at execution was ${String(lazy2.seen)}`,
    );

    // Non-thenables must pass through untouched.
    const plain = await runWithTenant({ orgId: 'ORG_X', source: 'test' }, () => 42 as never);
    check('non-thenable return values pass through unchanged', (plain as unknown) === 42);
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
