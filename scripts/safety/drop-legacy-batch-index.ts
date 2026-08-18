/**
 * Drop the legacy global unique index on `batches.name`.
 *
 * ── Why this is a separate, deliberate step ─────────────────────────────────
 * `batches` carried `name_1 UNIQUE`, which makes a batch name unique across the
 * ENTIRE platform. Two coaching institutes both running a "NEET" batch is
 * completely normal, and the second one simply failed to create — silently,
 * with a console warning, producing three batches out of four during Org 002
 * onboarding.
 *
 * The model now declares a compound `{ orgId, name }` unique index. This script
 * removes the old one, and it is deliberately NOT run automatically at startup:
 * dropping an index is a data-affecting operation and belongs in a migration
 * window where someone is watching, not in a deploy.
 *
 * Order matters. The compound index must EXIST before the global one is
 * dropped, or there is a window with no uniqueness at all and duplicates
 * created in it cannot be un-created. This script verifies that and refuses
 * otherwise.
 *
 *   npx ts-node --transpile-only scripts/safety/drop-legacy-batch-index.ts --scratch-suffix restore_2026_08_17
 *   npx ts-node --transpile-only scripts/safety/drop-legacy-batch-index.ts --production
 */

import { config } from 'dotenv';
import mongoose from 'mongoose';
import { configureDnsForSrv, redactUri, requireEnv } from './lib';

config();

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const productionUri = requireEnv('MONGO_URI');
  const suffix = arg('--scratch-suffix');
  const wantsProduction = process.argv.includes('--production');

  let uri: string;
  if (suffix) {
    const m = productionUri.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/);
    if (!m) throw new Error('MONGO_URI could not be parsed.');
    uri = `${m[1]}${m[2]}_${suffix}${m[3] ?? ''}`;
  } else if (wantsProduction) {
    uri = productionUri;
  } else {
    console.error('Refusing to guess a target. Use --scratch-suffix <s> or --production.');
    process.exit(2);
    return;
  }

  configureDnsForSrv();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });
  const db = mongoose.connection.db as mongoose.mongo.Db;

  try {
    console.log(`[batch-index] target: ${redactUri(uri)}`);
    const before = await db.collection('batches').indexes();
    console.log(`[batch-index] indexes: ${before.map((i) => i.name).join(', ')}`);

    const hasCompound = before.some(
      (i) => JSON.stringify(i.key) === JSON.stringify({ orgId: 1, name: 1 }),
    );
    const legacy = before.find((i) => i.name === 'name_1');

    if (!hasCompound) {
      console.error(
        '\nREFUSING: the compound { orgId, name } index does not exist yet.\n' +
          'Start the application once so Mongoose builds it, then re-run. Dropping the\n' +
          'global index first would leave a window with NO uniqueness protection.',
      );
      process.exit(1);
    }

    if (!legacy) {
      console.log('[batch-index] legacy name_1 index already absent — nothing to do.');
      return;
    }

    await db.collection('batches').dropIndex('name_1');
    console.log('[batch-index] dropped name_1');

    const after = await db.collection('batches').indexes();
    console.log(`[batch-index] now: ${after.map((i) => i.name).join(', ')}`);
    console.log('\nTwo organizations can now hold a batch of the same name.');
  } finally {
    await mongoose.connection.close();
  }
}

main().catch((error) => {
  console.error('[batch-index] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
