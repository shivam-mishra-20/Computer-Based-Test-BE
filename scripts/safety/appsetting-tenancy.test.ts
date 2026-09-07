/**
 * `AppSetting` per organization — the defect P6 found and recorded.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 * Two independent faults, and fixing either alone leaves the bug intact:
 *
 *   1. `key` was GLOBALLY unique, so two institutes could not both hold a
 *      `MORNING_TIME_SLOTS` row. The second to save either failed or
 *      overwrote the first.
 *
 *   2. The resolved slots lived in module-level `let` arrays, loaded once at
 *      process start. Even with perfectly scoped queries, whichever
 *      organization last pressed Save owned the timetable for EVERY
 *      organization until the process restarted.
 *
 * The second is the one a query-scoping audit would miss entirely, so it gets
 * its own checks below: the same resolver is called under two different tenant
 * contexts, interleaved, and each must answer with its own data.
 *
 * Runs against a scratch database, so it is NOT part of `safety:all` — that
 * chain is deliberately database-free and must stay runnable on a laptop with
 * no connection string. It belongs with `legacy-regression`, `two-org-isolation`
 * and the other suites that need real data.
 *
 * Writes only rows it creates, and removes them afterwards.
 *
 *   P6_MONGO_URI=<scratch> node -r ./scripts/safety/dns-preload.js \
 *     -r ts-node/register/transpile-only scripts/safety/appsetting-tenancy.test.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { registerTenancy, runWithTenant, withoutTenantScope } from '../../src/core/tenancy';
import {
  DEFAULT_EVENING_TIME_SLOTS,
  DEFAULT_MORNING_TIME_SLOTS,
  SLOT_KEYS,
  invalidateSlotCache,
  timeSlotsForOrg,
} from '../../src/core/config/timeSlots';
import { assertNotProduction } from './lib';

process.env.REDIS_ENABLED = 'false';

const ORG_A = 'P6_APPSETTING_ORG_A';
const ORG_B = 'P6_APPSETTING_ORG_B';

const A_MORNING = [{ start: '08:00', end: '09:00', label: 'A 8-9' }];
const B_MORNING = [{ start: '06:30', end: '07:30', label: 'B 6:30-7:30' }];
const B_EVENING = [{ start: '20:00', end: '21:00', label: 'B 8-9 PM' }];

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

function eq<T>(label: string, actual: T, expected: T) {
  check(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/** Run inside a CLAIM-sourced context — the mode `tenantScope()` narrows in. */
function asOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenant({ orgId, userId: null, source: 'claim' }, fn);
}

async function main() {
  const uri = process.env.P6_MONGO_URI;
  if (!uri) throw new Error('P6_MONGO_URI must name the scratch database.');
  assertNotProduction(uri, process.env.MONGO_URI as string);

  registerTenancy();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AppSetting = require('../../src/models/AppSetting').default;

  const cleanup = () =>
    withoutTenantScope('appsetting-test:cleanup', () =>
      AppSetting.deleteMany({ orgId: { $in: [ORG_A, ORG_B] } }),
    );

  try {
    await cleanup();

    console.log('\nthe index no longer makes a setting name globally unique');
    // Both writes must succeed. Under the legacy `key_1 UNIQUE` the second
    // threw E11000 — which is the whole defect, in one line.
    await asOrg(ORG_A, async () => {
      await AppSetting.create({ orgId: ORG_A, key: SLOT_KEYS.morning, value: A_MORNING });
    });
    let secondWriteError: string | null = null;
    try {
      await asOrg(ORG_B, async () => {
        await AppSetting.create({ orgId: ORG_B, key: SLOT_KEYS.morning, value: B_MORNING });
      });
    } catch (error) {
      secondWriteError = error instanceof Error ? error.message : String(error);
    }
    check(
      'a second organization can hold the same setting key',
      secondWriteError === null,
      secondWriteError ?? '',
    );

    const rows = await withoutTenantScope('appsetting-test:count', () =>
      AppSetting.countDocuments({ key: SLOT_KEYS.morning, orgId: { $in: [ORG_A, ORG_B] } }),
    );
    eq('both rows exist', rows, 2);

    console.log('\nduplicate keys WITHIN one organization are still rejected');
    let dupeError: string | null = null;
    try {
      await asOrg(ORG_A, async () => {
        await AppSetting.create({ orgId: ORG_A, key: SLOT_KEYS.morning, value: A_MORNING });
      });
    } catch (error) {
      dupeError = error instanceof Error ? error.message : String(error);
    }
    check(
      'uniqueness moved, it was not removed',
      dupeError !== null && /E11000|duplicate/i.test(dupeError),
      dupeError ?? 'the duplicate was accepted',
    );

    console.log('\neach organization resolves its own slots');
    invalidateSlotCache();
    const a = await asOrg(ORG_A, async () => {
      invalidateSlotCache();
      return timeSlotsForOrg();
    });
    const b = await asOrg(ORG_B, async () => {
      invalidateSlotCache();
      return timeSlotsForOrg();
    });

    eq('org A gets its own morning slots', a.morning, A_MORNING);
    eq('org B gets its own morning slots', b.morning, B_MORNING);
    check(
      'and they are genuinely different',
      JSON.stringify(a.morning) !== JSON.stringify(b.morning),
    );

    console.log('\nunset sections fall back to the defaults, per section');
    eq(
      'org A saved no evening slots, so it gets the platform defaults',
      a.evening,
      DEFAULT_EVENING_TIME_SLOTS,
    );
    await asOrg(ORG_B, async () => {
      await AppSetting.findOneAndUpdate(
        { orgId: ORG_B, key: SLOT_KEYS.evening },
        { $set: { value: B_EVENING } },
        { upsert: true, new: true },
      );
    });
    const b2 = await asOrg(ORG_B, async () => {
      invalidateSlotCache();
      return timeSlotsForOrg();
    });
    eq('org B now gets its own evening slots', b2.evening, B_EVENING);
    const a2 = await asOrg(ORG_A, async () => {
      invalidateSlotCache();
      return timeSlotsForOrg();
    });
    eq("org A's evening slots are untouched by org B's save", a2.evening, DEFAULT_EVENING_TIME_SLOTS);

    console.log('\nthe module-level cache no longer leaks across tenants');
    // ── The check the old implementation could not have passed ─────────────
    // Interleaved, with no invalidation between them. The previous code kept
    // the resolved slots in a module `let`, so the second call would return
    // whatever the first had loaded. A per-organization cache key is what makes
    // this pass.
    const interleaved: string[] = [];
    for (let i = 0; i < 3; i++) {
      const x = await asOrg(ORG_A, () => timeSlotsForOrg());
      const y = await asOrg(ORG_B, () => timeSlotsForOrg());
      interleaved.push(x.morning[0].label, y.morning[0].label);
    }
    eq(
      'six interleaved reads, each answering for its own organization',
      interleaved,
      ['A 8-9', 'B 6:30-7:30', 'A 8-9', 'B 6:30-7:30', 'A 8-9', 'B 6:30-7:30'],
    );

    console.log('\nno context at all still resolves — the api-legacy case');
    const none = await withoutTenantScope('appsetting-test:no-context', async () => {
      invalidateSlotCache();
      return timeSlotsForOrg();
    });
    eq(
      'falls back to the platform defaults rather than to nothing',
      none.morning,
      DEFAULT_MORNING_TIME_SLOTS,
    );
    check(
      'and the combined table is ordered',
      none.combined.every(
        (slot, i) => i === 0 || slot.start >= none.combined[i - 1].start,
      ),
      none.combined.map((s) => s.start).join(' '),
    );

    console.log('\nreading does not write');
    // The old `loadTimeSlots()` created any row it did not find, which is how an
    // unscoped READ became an unscoped WRITE at process start.
    const before = await withoutTenantScope('appsetting-test:before', () =>
      AppSetting.countDocuments({ orgId: { $in: [ORG_A, ORG_B] } }),
    );
    await asOrg(ORG_A, async () => {
      invalidateSlotCache();
      await timeSlotsForOrg();
    });
    await withoutTenantScope('appsetting-test:no-context-read', async () => {
      invalidateSlotCache();
      await timeSlotsForOrg();
    });
    const after = await withoutTenantScope('appsetting-test:after', () =>
      AppSetting.countDocuments({ orgId: { $in: [ORG_A, ORG_B] } }),
    );
    eq('resolving slots created no rows', after, before);
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log('');
  if (failures) {
    console.error(`APPSETTING TENANCY TESTS FAILED — ${failures} of ${checks}.`);
    process.exit(1);
  }
  console.log(`All ${checks} AppSetting tenancy checks passed.`);
  process.exit(0);
}

main().catch((error) => {
  console.error('appsetting-tenancy.test.ts crashed:', error);
  process.exit(1);
});
