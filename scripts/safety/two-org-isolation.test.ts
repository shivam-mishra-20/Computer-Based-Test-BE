/**
 * Two-organization isolation, against real data on the scratch database.
 *
 * Everything up to now has tested the tenancy layer in isolation, with fake
 * models and no database. This is the first test that answers the question the
 * whole migration exists for:
 *
 *   With Org 001 (Abhigyan, real data) and Org 002 (ABC Coaching) in ONE
 *   database, can either one see the other's rows?
 *
 * It creates a small Org 002 fixture, exercises reads under enforce from each
 * organization's context, and asserts the counts do not overlap. Then it
 * removes the fixture.
 *
 * Runs ONLY against a scratch database — the same guard as every other write
 * tool here refuses to point at production.
 *
 *   npx ts-node --transpile-only scripts/safety/two-org-isolation.test.ts \
 *     --scratch-suffix restore_2026_08_17
 */

import { config } from 'dotenv';
import { registerTenancy } from '../../src/core/tenancy';
import { assertNotProduction, configureDnsForSrv, redactUri, requireEnv } from './lib';

config();
registerTenancy();

// Imported after registerTenancy so the plugin applies.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mongoose = require('mongoose');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runWithTenant, withoutTenantScope } = require('../../src/core/tenancy/context');

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

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] ?? null : null;
}

function deriveScratchUri(productionUri: string, suffix: string): string {
  const m = productionUri.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/);
  if (!m) throw new Error('MONGO_URI could not be parsed.');
  return `${m[1]}${m[2]}_${suffix}${m[3] ?? ''}`;
}

const ORG_002_MARKER = 'zz-isolation-fixture';

async function main() {
  const productionUri = requireEnv('MONGO_URI');
  const suffix = arg('--scratch-suffix');
  if (!suffix) {
    console.error('Usage: two-org-isolation.test.ts --scratch-suffix <suffix>');
    process.exit(2);
  }
  const uri = deriveScratchUri(productionUri, suffix);

  // Creates and deletes documents — never allowed near production.
  assertNotProduction(uri, productionUri);

  configureDnsForSrv();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const User = require('../../src/models/User').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Org = require('../../src/models/Org').default;

  console.log(`[two-org] target: ${redactUri(uri)}\n`);

  let org002Id: string | null = null;

  try {
    // ── Fixture ────────────────────────────────────────────────────────────
    const org001 = await withoutTenantScope('test:find-org-001', () =>
      Org.findOne({ slug: 'abhigyan' }),
    );
    if (!org001) throw new Error('Org 001 not found — run seed-org-001 and the backfill first.');
    const org001Id = String(org001._id);

    const org002 = await withoutTenantScope('test:create-org-002', async () => {
      const existing = await Org.findOne({ slug: 'abc-coaching' });
      if (existing) return existing;
      return Org.create({
        name: 'ABC Coaching Institute',
        slug: 'abc-coaching',
        status: 'trialing',
        branding: { primaryColor: '#E8590C', secondaryColor: '#1B3A5C', appName: 'ABC Coaching' },
        locale: { timezone: 'Asia/Kolkata', currency: 'INR' },
        notes: 'Isolation test fixture.',
      });
    });
    org002Id = String(org002._id);

    console.log(`  Org 001 ${org001Id}  (Abhigyan, real data)`);
    console.log(`  Org 002 ${org002Id}  (ABC Coaching, fixture)\n`);

    // Three students for Org 002, created inside its context so the plugin
    // stamps them — which is itself part of what is under test.
    process.env.TENANT_ENFORCEMENT = 'enforce';

    await runWithTenant({ orgId: org002Id, source: 'test' }, async () => {
      for (let i = 1; i <= 3; i++) {
        await User.create({
          name: `ABC Student ${i}`,
          email: `${ORG_002_MARKER}-${i}@abc-coaching.test`,
          password: 'not-a-real-password',
          role: 'student',
          classLevel: 'Dropper', // non-numeric on purpose — Org 002 differs
        });
      }
    });

    // ── Writes are attributed correctly ───────────────────────────────────
    console.log('write attribution');
    const stamped = await withoutTenantScope('test:count-fixture', () =>
      User.countDocuments({ email: new RegExp(ORG_002_MARKER), orgId: org002Id }),
    );
    check('documents created in Org 002 context carry Org 002', stamped === 3, `got ${stamped}`);

    // ── Reads are isolated ────────────────────────────────────────────────
    console.log('\nread isolation under enforce');

    const seenByOrg002 = await runWithTenant({ orgId: org002Id, source: 'test' }, () =>
      User.countDocuments({ role: 'student' }),
    );
    const seenByOrg001 = await runWithTenant({ orgId: org001Id, source: 'test' }, () =>
      User.countDocuments({ role: 'student' }),
    );
    const trueTotal = await withoutTenantScope('test:true-total', () =>
      User.countDocuments({ role: 'student' }),
    );

    check(
      `Org 002 sees ONLY its own 3 students (not ${trueTotal})`,
      seenByOrg002 === 3,
      `saw ${seenByOrg002}`,
    );
    check(
      `Org 001 sees its own students and NOT Org 002's`,
      seenByOrg001 === trueTotal - 3,
      `saw ${seenByOrg001}, expected ${trueTotal - 3}`,
    );
    check(
      'the two views do not overlap and sum to the whole',
      seenByOrg001 + seenByOrg002 === trueTotal,
      `${seenByOrg001} + ${seenByOrg002} != ${trueTotal}`,
    );

    // ── Direct id access across the boundary ──────────────────────────────
    console.log('\ncross-tenant document access');
    const victim = await withoutTenantScope('test:pick-victim', () =>
      User.findOne({ orgId: org001Id, role: 'student' }).select('_id'),
    );
    if (victim) {
      const stolen = await runWithTenant({ orgId: org002Id, source: 'test' }, () =>
        User.findById(victim._id),
      );
      check(
        "Org 002 cannot read an Org 001 document by its id",
        stolen === null,
        'the document was returned — THIS IS A LEAK',
      );
    }

    const abcStudent = await withoutTenantScope('test:pick-abc', () =>
      User.findOne({ email: new RegExp(ORG_002_MARKER) }).select('_id'),
    );
    if (abcStudent) {
      const reverse = await runWithTenant({ orgId: org001Id, source: 'test' }, () =>
        User.findById(abcStudent._id),
      );
      check(
        'Org 001 cannot read an Org 002 document by its id',
        reverse === null,
        'the document was returned — THIS IS A LEAK',
      );
    }

    // ── Cross-tenant writes ───────────────────────────────────────────────
    console.log('\ncross-tenant writes');
    if (victim) {
      const result = await runWithTenant({ orgId: org002Id, source: 'test' }, () =>
        User.updateOne({ _id: victim._id }, { $set: { name: 'TAMPERED' } }),
      );
      check(
        'Org 002 cannot UPDATE an Org 001 document',
        result.matchedCount === 0,
        `matched ${result.matchedCount} — a cross-tenant write succeeded`,
      );

      const del = await runWithTenant({ orgId: org002Id, source: 'test' }, () =>
        User.deleteOne({ _id: victim._id }),
      );
      check(
        'Org 002 cannot DELETE an Org 001 document',
        del.deletedCount === 0,
        `deleted ${del.deletedCount} — a cross-tenant delete succeeded`,
      );
    }

    // ── Aggregations ──────────────────────────────────────────────────────
    console.log('\naggregation isolation');
    const agg = await runWithTenant({ orgId: org002Id, source: 'test' }, () =>
      User.aggregate([{ $match: { role: 'student' } }, { $count: 'n' }]),
    );
    check(
      'aggregate() is scoped to the active org',
      (agg[0]?.n ?? 0) === 3,
      `aggregate saw ${agg[0]?.n ?? 0}`,
    );
  } finally {
    // ── Cleanup ────────────────────────────────────────────────────────────
    process.env.TENANT_ENFORCEMENT = 'warn';
    try {
      await withoutTenantScope('test:cleanup', async () => {
        const removed = await User.deleteMany({ email: new RegExp(ORG_002_MARKER) });
        if (org002Id) await Org.deleteOne({ _id: org002Id });
        console.log(`\n  cleaned up ${removed.deletedCount} fixture user(s) and Org 002`);
      });
    } catch (error) {
      console.error('  cleanup failed:', (error as Error).message);
    }
    await mongoose.connection.close();
  }

  console.log('');
  if (failures) {
    console.error(`TWO-ORG ISOLATION FAILED — ${failures} of ${checks} checks.`);
    process.exit(1);
  }
  console.log(`All ${checks} two-org isolation checks passed.`);
  process.exit(0);
}

main().catch((error) => {
  console.error('[two-org] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
