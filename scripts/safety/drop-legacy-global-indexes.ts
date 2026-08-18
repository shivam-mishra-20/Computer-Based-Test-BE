/**
 * Drop the legacy GLOBAL unique indexes that predate multi-tenancy.
 *
 * ── The shape of the problem ────────────────────────────────────────────────
 * Several collections carried a unique index on a business key alone, which
 * makes that key unique across the ENTIRE platform rather than within an
 * organization. Every one of them fails the same way: the second institute to
 * use a perfectly ordinary name either cannot save, or overwrites the first.
 *
 *   batches.name_1       two institutes both running a "NEET" batch — the
 *                        second silently failed to create, producing three
 *                        batches out of four during Org 002 onboarding.
 *   appsettings.key_1    two institutes cannot both hold a MORNING_TIME_SLOTS
 *                        row, so the second one to save its timetable
 *                        overwrites the first one's schedule.
 *
 * Each model now declares a compound `{ orgId, <key> }` unique index. This
 * script removes the old ones.
 *
 * ── Why this is a separate, deliberate step ─────────────────────────────────
 * Dropping an index is data-affecting and belongs in a migration window where
 * someone is watching, not in a deploy.
 *
 * Order matters. The compound index must EXIST before the global one is
 * dropped, or there is a window with no uniqueness at all, and duplicates
 * created inside it cannot be un-created. This script verifies that per
 * collection and refuses that collection otherwise — it does not refuse the
 * whole run, so one lagging collection cannot block the others.
 *
 *   npx ts-node --transpile-only scripts/safety/drop-legacy-global-indexes.ts --target-env P6_MONGO_URI
 *   npx ts-node --transpile-only scripts/safety/drop-legacy-global-indexes.ts --scratch-suffix restore_2026_08_17
 *   npx ts-node --transpile-only scripts/safety/drop-legacy-global-indexes.ts --production
 */

import { config } from 'dotenv';
import mongoose from 'mongoose';
import { configureDnsForSrv, redactUri, requireEnv } from './lib';

config();

interface LegacyIndex {
  collection: string;
  /** The index name to drop. */
  legacyName: string;
  /** The compound index that must exist first. */
  compound: Record<string, 1>;
  /** What becomes possible once it is gone. */
  unlocks: string;
}

const LEGACY_INDEXES: LegacyIndex[] = [
  {
    collection: 'batches',
    legacyName: 'name_1',
    compound: { orgId: 1, name: 1 },
    unlocks: 'Two organizations can hold a batch of the same name.',
  },
  {
    collection: 'appsettings',
    legacyName: 'key_1',
    compound: { orgId: 1, key: 1 },
    unlocks: 'Two organizations can hold different time slots and settings.',
  },
];

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const productionUri = requireEnv('MONGO_URI');
  const suffix = arg('--scratch-suffix');
  const targetEnv = arg('--target-env');
  const wantsProduction = process.argv.includes('--production');

  let uri: string;
  if (targetEnv) {
    // An explicit connection string in a named variable, for scratch databases
    // that are not `<production>_<suffix>`. Still refuses the production
    // database, so this is a convenience and not a way around the guard.
    const value = process.env[targetEnv];
    if (!value) throw new Error(`${targetEnv} is not set.`);
    const targetDb = (value.split('/').pop() || '').split('?')[0];
    const prodDb = (productionUri.split('/').pop() || '').split('?')[0];
    if (!targetDb || targetDb === prodDb) {
      throw new Error(`Refusing: ${targetEnv} names the production database.`);
    }
    uri = value;
  } else if (suffix) {
    const m = productionUri.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/);
    if (!m) throw new Error('MONGO_URI could not be parsed.');
    uri = `${m[1]}${m[2]}_${suffix}${m[3] ?? ''}`;
  } else if (wantsProduction) {
    uri = productionUri;
  } else {
    console.error(
      'Refusing to guess a target. Use --target-env <VAR>, --scratch-suffix <s>, or --production.',
    );
    process.exit(2);
    return;
  }

  configureDnsForSrv();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });
  const db = mongoose.connection.db as mongoose.mongo.Db;

  let refused = 0;
  let dropped = 0;

  try {
    console.log(`[legacy-indexes] target: ${redactUri(uri)}\n`);

    const present = new Set((await db.listCollections().toArray()).map((c) => c.name));

    for (const spec of LEGACY_INDEXES) {
      const label = `${spec.collection}.${spec.legacyName}`;

      if (!present.has(spec.collection)) {
        console.log(`  —  ${label}: collection absent, nothing to do`);
        continue;
      }

      const before = await db.collection(spec.collection).indexes();
      const hasCompound = before.some(
        (i) => JSON.stringify(i.key) === JSON.stringify(spec.compound),
      );
      const legacy = before.find((i) => i.name === spec.legacyName);

      if (!legacy) {
        console.log(`  ✓  ${label}: already absent`);
        continue;
      }

      if (!hasCompound) {
        refused++;
        console.error(
          `  ✗  ${label}: REFUSED — the compound ${JSON.stringify(spec.compound)} index does\n` +
            `     not exist yet. Start the application once so Mongoose builds it, then\n` +
            `     re-run. Dropping the global index first would leave a window with NO\n` +
            `     uniqueness protection.`,
        );
        continue;
      }

      await db.collection(spec.collection).dropIndex(spec.legacyName);
      dropped++;
      console.log(`  ✓  ${label}: dropped — ${spec.unlocks}`);
    }

    console.log(`\n[legacy-indexes] dropped ${dropped}, refused ${refused}`);
    if (refused) process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
}

main().catch((error) => {
  console.error('[legacy-indexes] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
