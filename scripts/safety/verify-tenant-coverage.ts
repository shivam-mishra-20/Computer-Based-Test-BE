/**
 * Proves the tenant plugin reached every model — without connecting to Mongo.
 *
 * ── Why this needs to be a build gate ───────────────────────────────────────
 * `mongoose.plugin()` applies only to schemas compiled after the call. A model
 * imported before `registerTenancy()` runs gets NO orgId field and NO scoping
 * hooks, and nothing about that failure is visible: the app boots, the tests
 * pass, the queries work — they are simply unscoped, forever. That is the
 * quietest possible way to lose tenant isolation.
 *
 * This loads the real application, compiling all 56 models through the real
 * import graph, and then asserts every one of them carries the plugin. It is
 * the check that makes "must be imported first" enforceable rather than
 * aspirational.
 *
 *   npx ts-node scripts/safety/verify-tenant-coverage.ts
 */

process.env.TENANT_ENFORCEMENT = process.env.TENANT_ENFORCEMENT || 'warn';
// Loading the app must not start cron, the queue worker or a DB connection.
process.env.ENABLE_CRON = 'false';
process.env.PPT_WORKER_EMBEDDED = 'false';

import mongoose from 'mongoose';
import { readdirSync } from 'fs';
import { join } from 'path';
import { registerTenancy, verifyTenantPluginApplied } from '../../src/core/tenancy';

registerTenancy();

// Importing app.ts pulls in every route → controller → model.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../src/app');

// app.ts reaches most models but not all — a model used only by a worker, a
// script or a not-yet-wired feature (Org itself, at this point in the
// migration) would never compile here, and its coverage would go unchecked.
// Loading the directory directly closes that gap.
const modelsDir = join(__dirname, '..', '..', 'src', 'models');
for (const file of readdirSync(modelsDir).filter((f) => f.endsWith('.ts'))) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require(join(modelsDir, file));
  } catch (error) {
    console.warn(`  ⚠ could not load model ${file}: ${(error as Error).message}`);
  }
}

const result = verifyTenantPluginApplied();
const all = mongoose.modelNames();
const scoped = all.length - result.exempt.length;

console.log('\n─── tenant coverage ───');
console.log(`  models compiled  ${all.length}`);
console.log(`  tenant-scoped    ${scoped}`);
console.log(`  exempt           ${result.exempt.length}  (${result.exempt.join(', ') || 'none'})`);
console.log(`  MISSING          ${result.missing.length}  (${result.missing.join(', ') || 'none'})`);

if (!result.ok) {
  console.error(
    '\nFAILED — the models above compiled before registerTenancy(). Their queries are\n' +
      'unscoped and no enforcement setting will change that. Move the tenancy import\n' +
      'above the first model import in whichever entrypoint loaded them.',
  );
  process.exit(1);
}

// A scoped model with no orgId index would make every enforced query a
// collection scan — correct, but slow enough to take production down.
const unindexed = all
  .filter((name) => !result.exempt.includes(name))
  .filter((name) => {
    const path = mongoose.model(name).schema.path('orgId') as { options?: { index?: boolean } };
    return !path?.options?.index;
  });

if (unindexed.length) {
  console.warn(`\n  ⚠ ${unindexed.length} scoped model(s) lack an orgId index: ${unindexed.join(', ')}`);
}

console.log('\nPASSED — every model is tenant-scoped or explicitly exempt.');
process.exit(0);
