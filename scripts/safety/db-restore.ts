/**
 * P0 — restore a backup into a scratch database.
 *
 * This is the script that turns "we have backups" into "we have a backup we
 * have restored", which is the only claim worth anything. It is also the
 * rehearsal harness for every migration in P1: the backfill runs here first,
 * twice, before it runs anywhere near production.
 *
 * ── Safety ─────────────────────────────────────────────────────────────────
 * The target must pass `assertNotProduction()`, which requires the database
 * name to carry an explicit scratch marker (`_scratch`, `_restore`,
 * `_rehearsal`, `_verify`). A URI that merely differs from production is NOT
 * sufficient — that check alone would happily accept a typo that lands on
 * staging or on a customer's database. The operator has to name the
 * destination like a scratch database on purpose.
 *
 * Existing collections in the target are dropped before load, so a rehearsal
 * is repeatable. That is destructive BY DESIGN, and it is exactly why the
 * guard above is strict about where it is allowed to point.
 *
 *   npx ts-node scripts/safety/db-restore.ts \
 *     --from backups/2026-08-17 \
 *     --to "mongodb+srv://...@host/abhigyangurukul_restore_2026_08_17"
 */

import { config } from 'dotenv';
import { createReadStream, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { EJSON, assertNotProduction, connect, dbNameOf, redactUri, requireEnv } from './lib';

config();

const BATCH = 500;

function arg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] ?? null : null;
}

/**
 * Derive a scratch URI from MONGO_URI by swapping only the database name.
 *
 * Passing a full connection string on the command line puts the production
 * password into shell history, into the process table, and into any terminal
 * log or screen share. Deriving it in-process keeps the credential inside the
 * program — the operator only ever types a suffix.
 */
function deriveScratchUri(productionUri: string, suffix: string): string {
  const match = productionUri.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/);
  if (!match) throw new Error('MONGO_URI could not be parsed to derive a scratch target.');
  const [, authority, db, query = ''] = match;
  return `${authority}${db}_${suffix}${query}`;
}

async function main() {
  const from = arg('--from');
  const suffix = arg('--scratch-suffix');
  const productionUri = requireEnv('MONGO_URI');

  const to =
    arg('--to') ||
    process.env.RESTORE_TARGET_URI ||
    (suffix ? deriveScratchUri(productionUri, suffix) : null);

  if (!from || !to) {
    console.error(
      'Usage: db-restore.ts --from <backup-dir> --to <scratch-uri>\n' +
        '       db-restore.ts --from <backup-dir> --scratch-suffix restore_2026_08_17\n' +
        '       (or set RESTORE_TARGET_URI)\n\n' +
        '  --scratch-suffix derives the target from MONGO_URI, keeping the\n' +
        '  credential out of shell history and the process table.',
    );
    process.exit(2);
  }

  // Fails closed. Nothing below this line runs unless the target is provably
  // not production and is explicitly named as scratch.
  assertNotProduction(to, productionUri);

  const manifest = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8')) as {
    collections: { name: string; documents: number; file: string; indexes: unknown[] }[];
    totals: { documents: number };
  };

  console.log(`[restore] from:   ${from}`);
  console.log(`[restore] target: ${redactUri(to)}`);
  console.log(`[restore] guard:  passed — target is a scratch database\n`);

  const client = await connect(to);
  const started = Date.now();

  try {
    const db = client.db(dbNameOf(to));

    for (const entry of manifest.collections) {
      const collection = db.collection(entry.name);

      // Repeatability: a rehearsal you can only run once is not a rehearsal.
      await collection.drop().catch(() => undefined);

      const stream = createReadStream(join(from, entry.file), { encoding: 'utf8' });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });

      let buffer: unknown[] = [];
      let inserted = 0;

      const flush = async () => {
        if (!buffer.length) return;
        // ordered:false keeps a single bad document from aborting the rest —
        // and a rehearsal wants to surface ALL the failures in one run, not
        // the first one.
        await collection.insertMany(buffer as never[], { ordered: false });
        inserted += buffer.length;
        buffer = [];
      };

      for await (const line of lines) {
        if (!line.trim()) continue;
        buffer.push(EJSON.parse(line, { relaxed: false }));
        if (buffer.length >= BATCH) await flush();
      }
      await flush();

      // Indexes are part of the database's behaviour, not decoration: a restore
      // without the unique index on `email` would accept data production would
      // have rejected, and the rehearsal would prove nothing about uniqueness.
      for (const index of entry.indexes as { name: string; key: Record<string, number> }[]) {
        if (index.name === '_id_') continue;
        try {
          const { name, key, ...options } = index as Record<string, unknown> & {
            name: string;
            key: Record<string, number>;
          };
          delete (options as Record<string, unknown>).v;
          delete (options as Record<string, unknown>).ns;
          await collection.createIndex(key, { name, ...options });
        } catch (error) {
          console.warn(
            `    ! index ${index.name} on ${entry.name}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }

      const status = inserted === entry.documents ? 'ok' : `MISMATCH expected ${entry.documents}`;
      console.log(`  ${entry.name.padEnd(28)} ${String(inserted).padStart(8)} docs  ${status}`);
    }

    console.log('\n─── restore complete ───');
    console.log(`  elapsed  ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`\n  Restore is not verified until counts AND fingerprints match.`);
    console.log(`  Next: npx ts-node scripts/safety/verify-restore.ts --from ${from} --to <scratch-uri>`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error('[restore] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
