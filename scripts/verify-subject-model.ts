/**
 * Subject model verification — pure Mongoose validation, no DB connection.
 *
 * Complements the pure-logic pattern used by verify-isolation-filter.ts:
 * constructing and `.validate()`-ing a Mongoose document runs schema hooks
 * entirely in-process, so the case-insensitive dedup key (`nameLower`) and the
 * tenant plugin's field-injection can both be asserted without a live
 * database — useful here specifically because the real database is a shared
 * production Atlas cluster this script must never touch.
 *
 * `registerTenancy()` must run before `Subject` is required — importing a
 * model before the plugin registers silently compiles it without `orgId`/
 * `branchId` (see core/tenancy/bootstrap.ts). Requiring it AFTER the call
 * below, rather than a top-level `import`, is what makes that ordering
 * correct here instead of a race with import hoisting.
 *
 * Run:  npx ts-node scripts/verify-subject-model.ts
 */

import { registerTenancy } from '../src/core/tenancy/bootstrap';
registerTenancy();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Subject = require('../src/models/Subject').default;

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean) {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL  ${label}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

async function main() {
  console.log('nameLower derivation (case, whitespace):');
  const cases: [string, string][] = [
    ['Physics', 'physics'],
    ['  Physics  ', 'physics'],
    ['Social   Studies', 'social studies'],
    ['SOCIAL SCIENCE', 'social science'],
    ['Applied  Mathematics', 'applied mathematics'],
  ];
  for (const [input, expectedLower] of cases) {
    const doc = new Subject({ name: input });
    // eslint-disable-next-line no-await-in-loop
    await doc.validate();
    ok(`nameLower(${JSON.stringify(input)}) === ${JSON.stringify(expectedLower)}`, doc.nameLower === expectedLower);
  }

  console.log('\nRequired-field validation:');
  try {
    const doc = new Subject({ name: '   ' });
    await doc.validate();
    ok('whitespace-only name is rejected (required, after trim)', false);
  } catch {
    ok('whitespace-only name is rejected (required, after trim)', true);
  }
  try {
    const doc = new Subject({});
    await doc.validate();
    ok('missing name is rejected', false);
  } catch {
    ok('missing name is rejected', true);
  }

  console.log('\nTenant plugin wiring:');
  const doc2 = new Subject({ name: 'Physics', orgId: 'org_1' });
  ok('orgId field is settable (tenant plugin field injection applied)', doc2.orgId === 'org_1');
  ok('branchId path exists on schema (tenant plugin field injection applied)', Subject.schema.path('branchId') != null);

  console.log('\nIndex shape:');
  const indexes = Subject.schema.indexes() as [Record<string, number>, Record<string, unknown>][];
  const hasCompoundUniqueIndex = indexes.some(
    ([spec, opts]) => spec.orgId === 1 && spec.nameLower === 1 && opts?.unique === true,
  );
  ok('{ orgId: 1, nameLower: 1 } unique index is declared (the real race guard)', hasCompoundUniqueIndex);
  const hasStaleCaseSensitiveIndex = indexes.some(
    ([spec]) => spec.orgId === 1 && spec.name === 1,
  );
  ok('the old case-sensitive { orgId, name } index was replaced, not left alongside it', !hasStaleCaseSensitiveIndex);

  console.log(`\n${checks} checks, ${failures} failure(s).`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
