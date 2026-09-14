/**
 * Batch picker availability — the scope rule behind "no batches for this class".
 *
 * ── The regression this locks down ──────────────────────────────────────────
 * Before per-org configuration, batches were read with `Batch.find({})` and
 * every picker worked. The P4 resolver replaced that with
 * `getOrgConfiguration().batches`, which returned a hard `[]` whenever there
 * was no tenant context — and today's production has no tenant context at all.
 * Every batch picker fed by that resolver (study materials, homework, class
 * requests, /api/me/context) silently went empty on a deployment that has
 * always had batches.
 *
 * The rule that fixes it has to hold in BOTH directions, which is why each is
 * asserted here:
 *
 *   too eager   scoping before `orgId` is backfilled matches nothing, and the
 *               picker is empty again — the bug wearing a different hat.
 *   too lax     not scoping on a claim-mode deployment hands one institute
 *               another's batch names.
 *
 *   npx ts-node --transpile-only scripts/safety/batch-config.test.ts
 */

import { batchReadScope } from '../../src/core/config/orgConfig';
import { runWithTenant, runWithoutAnyContext } from '../../src/core/tenancy/context';

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

const isUnscoped = (scope: Record<string, unknown>) => Object.keys(scope).length === 0;
const scopedTo = (scope: Record<string, unknown>, orgId: string) =>
  (scope as { orgId?: string }).orgId === orgId;

section('Pre-migration (today\'s production): batches must still be readable');
{
  const scope = runWithoutAnyContext(() => batchReadScope());
  check(
    'REGRESSION: no tenant context reads UNSCOPED, not an empty list',
    isUnscoped(scope),
    JSON.stringify(scope),
  );
}

section('Pinned deployment before the orgId backfill');
{
  const scope = runWithTenant({ orgId: 'org_001', source: 'pinned' }, () => batchReadScope());
  check(
    'pinned + warn does not filter on a field the documents do not carry yet',
    isUnscoped(scope),
    JSON.stringify(scope),
  );
}

section('Multi-tenant: isolation must hold');
{
  const scope = runWithTenant({ orgId: 'org_abc', source: 'claim' }, () => batchReadScope());
  check(
    'TENANT ISOLATION: claim mode scopes to the caller’s organization',
    scopedTo(scope, 'org_abc'),
    JSON.stringify(scope),
  );
}

section('Explicitly requested organization (console, provisioning)');
{
  const noContext = runWithoutAnyContext(() => batchReadScope('org_xyz'));
  check(
    'an explicit orgId is always scoped, even with no ambient context',
    scopedTo(noContext, 'org_xyz'),
    JSON.stringify(noContext),
  );

  // The console asking about org B while running inside org A's context must
  // answer about B, never about A and never about everyone.
  const crossOrg = runWithTenant({ orgId: 'org_a', source: 'claim' }, () =>
    batchReadScope('org_b'),
  );
  check(
    'TENANT ISOLATION: an explicit orgId wins over a different ambient context',
    scopedTo(crossOrg, 'org_b'),
    JSON.stringify(crossOrg),
  );

  const pinnedExplicit = runWithTenant({ orgId: 'org_001', source: 'pinned' }, () =>
    batchReadScope('org_001'),
  );
  check(
    'an explicit orgId scopes even under pinned+warn (the caller asked for one org)',
    scopedTo(pinnedExplicit, 'org_001'),
    JSON.stringify(pinnedExplicit),
  );
}

section('The rule matches tenantScope(), which is separately audited');
{
  const { tenantScope } = require('../../src/core/tenancy/queryScope');
  for (const context of [
    { orgId: 'o1', source: 'claim' as const },
    { orgId: 'o1', source: 'pinned' as const },
    { orgId: 'o1', source: 'job' as const },
  ]) {
    const viaHelper = runWithTenant(context, () => batchReadScope());
    const viaScope = runWithTenant(context, () => tenantScope());
    check(
      `ambient-only scope delegates to tenantScope() for source="${context.source}"`,
      JSON.stringify(viaHelper) === JSON.stringify(viaScope),
    );
  }
}

console.log(`\n${checks} checks, ${failures} failure(s).`);
process.exit(failures ? 1 : 0);
