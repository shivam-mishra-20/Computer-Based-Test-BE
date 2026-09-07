/**
 * P0 — read-only production baseline.
 *
 * Records what production contains RIGHT NOW: every collection, its document
 * count, its storage size and its indexes. Two jobs:
 *
 *   1. It sizes the restore target. Restoring into a scratch database on the
 *      same Atlas cluster is only safe if the cluster has headroom; this is how
 *      you find out before rather than after.
 *   2. It is the reference the post-migration verification compares against.
 *      "Row counts identical pre/post backfill" needs a pre.
 *
 * Writes nothing. Connects with the production URI and only issues read
 * commands, so it is safe to run against a live cluster at any time.
 *
 *   npx ts-node scripts/safety/db-inventory.ts
 *   npx ts-node scripts/safety/db-inventory.ts --out docs/baselines/db-2026-08-17.json
 */

import { config } from 'dotenv';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { connect, dbNameOf, humanBytes, redactUri, requireEnv } from './lib';

config();

interface CollectionBaseline {
  name: string;
  documents: number;
  storageBytes: number;
  avgObjSize: number;
  indexes: { name: string; keys: Record<string, unknown>; unique: boolean }[];
}

async function main() {
  const uri = requireEnv('MONGO_URI');
  const outIndex = process.argv.indexOf('--out');
  const outPath = outIndex > -1 ? process.argv[outIndex + 1] : null;

  console.log(`[inventory] connecting: ${redactUri(uri)}`);
  const client = await connect(uri);

  try {
    const db = client.db(dbNameOf(uri));
    const stats = (await db.command({ dbStats: 1 })) as Record<string, number>;
    const collections = (await db.listCollections({}, { nameOnly: false }).toArray())
      .filter((c) => c.type !== 'view')
      .map((c) => c.name)
      .sort();

    console.log(`[inventory] ${collections.length} collections\n`);

    const baseline: CollectionBaseline[] = [];

    for (const name of collections) {
      const collection = db.collection(name);
      // countDocuments() is exact. estimatedDocumentCount() reads collection
      // metadata and can be stale after an unclean shutdown — for a baseline
      // that later has to prove "nothing was lost", exact is the only option.
      const documents = await collection.countDocuments();

      let storageBytes = 0;
      let avgObjSize = 0;
      try {
        const collStats = (await db.command({ collStats: name })) as Record<string, number>;
        storageBytes = collStats.size || 0;
        avgObjSize = collStats.avgObjSize || 0;
      } catch {
        // collStats is unavailable on some shared Atlas tiers. The count is the
        // part that matters for verification; size is advisory.
      }

      const indexes = (await collection.indexes()).map((index) => ({
        name: String(index.name),
        keys: index.key as Record<string, unknown>,
        unique: Boolean((index as { unique?: boolean }).unique),
      }));

      baseline.push({ name, documents, storageBytes, avgObjSize, indexes });
      console.log(
        `  ${name.padEnd(28)} ${String(documents).padStart(8)} docs  ${humanBytes(storageBytes).padStart(10)}`,
      );
    }

    const totalDocs = baseline.reduce((sum, c) => sum + c.documents, 0);

    console.log('\n─── totals ───');
    console.log(`  collections   ${collections.length}`);
    console.log(`  documents     ${totalDocs}`);
    console.log(`  dataSize      ${humanBytes(stats.dataSize)}`);
    console.log(`  storageSize   ${humanBytes(stats.storageSize)}`);
    console.log(`  indexSize     ${humanBytes(stats.indexSize)}`);

    const report = {
      capturedAt: new Date().toISOString(),
      uri: redactUri(uri),
      database: dbNameOf(uri),
      totals: {
        collections: collections.length,
        documents: totalDocs,
        dataSizeBytes: stats.dataSize || 0,
        storageSizeBytes: stats.storageSize || 0,
        indexSizeBytes: stats.indexSize || 0,
      },
      collections: baseline,
    };

    if (outPath) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
      console.log(`\n[inventory] written: ${outPath}`);
    }

    // A restore into a scratch database on the SAME cluster roughly doubles
    // storage. Say so plainly rather than letting the operator discover it by
    // filling the cluster that is serving production.
    const projected = (stats.storageSize || 0) + (stats.indexSize || 0);
    console.log(
      `\n[inventory] a same-cluster scratch restore needs ~${humanBytes(projected)} of additional headroom.`,
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error('[inventory] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
