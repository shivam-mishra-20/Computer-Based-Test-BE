/**
 * P0 — full logical backup of the production database to local disk.
 *
 * Writes one newline-delimited EJSON file per collection plus a manifest
 * carrying, for every collection, the document count and a SHA-256 content
 * fingerprint. The fingerprint is what makes `verify-restore.ts` meaningful:
 * without it, a restore can only be checked by counting rows, and a restore
 * that silently mangles Dates or ObjectIds into strings has the right count.
 *
 * ── Why EJSON and not JSON ──────────────────────────────────────────────────
 * Plain JSON destroys the type information this database depends on. Every
 * `_id`, every `createdAt`, every Decimal128 mark and every Binary blob would
 * come back as a string, and a restored exam would compare unequal to the
 * original in ways that only surface during grading. Canonical EJSON is
 * lossless and round-trips exactly.
 *
 * Read-only with respect to production. Writes only to the local output dir.
 *
 *   npx ts-node scripts/safety/db-backup.ts
 *   npx ts-node scripts/safety/db-backup.ts --out backups/2026-08-17
 */

import { config } from 'dotenv';
import { createHash } from 'crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { EJSON, connect, dbNameOf, humanBytes, redactUri, requireEnv } from './lib';

config();

const BATCH = 500;

interface ManifestEntry {
  name: string;
  documents: number;
  sha256: string;
  bytes: number;
  file: string;
  indexes: unknown[];
}

async function main() {
  const uri = requireEnv('MONGO_URI');
  const outIndex = process.argv.indexOf('--out');
  const outDir =
    outIndex > -1
      ? process.argv[outIndex + 1]
      : join('backups', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));

  mkdirSync(outDir, { recursive: true });
  console.log(`[backup] source: ${redactUri(uri)}`);
  console.log(`[backup] output: ${outDir}\n`);

  const client = await connect(uri);
  const started = Date.now();

  try {
    const db = client.db(dbNameOf(uri));
    const collections = (await db.listCollections({}, { nameOnly: false }).toArray())
      .filter((c) => c.type !== 'view')
      .map((c) => c.name)
      .sort();

    const manifest: ManifestEntry[] = [];

    for (const name of collections) {
      const collection = db.collection(name);
      const file = `${name}.ejson`;
      const path = join(outDir, file);
      const stream = createWriteStream(path, { encoding: 'utf8' });
      const hash = createHash('sha256');

      let documents = 0;
      let bytes = 0;

      // Sorting by _id makes the fingerprint deterministic. Without it, two
      // dumps of an unchanged collection can hash differently purely because
      // the storage engine returned documents in a different order — which
      // would make the verification step cry wolf on every run.
      const cursor = collection.find({}, { sort: { _id: 1 }, batchSize: BATCH });

      for await (const doc of cursor) {
        const line = EJSON.stringify(doc, { relaxed: false }) + '\n';
        hash.update(line);
        bytes += Buffer.byteLength(line);
        documents++;
        if (!stream.write(line)) {
          // Respect backpressure: without this a large collection buffers the
          // entire dump in memory before any of it reaches disk.
          await new Promise<void>((resolve) => stream.once('drain', () => resolve()));
        }
      }

      await new Promise<void>((resolve, reject) => {
        stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });

      const indexes = await collection.indexes();
      const sha256 = hash.digest('hex');
      manifest.push({ name, documents, sha256, bytes, file, indexes });

      console.log(
        `  ${name.padEnd(28)} ${String(documents).padStart(8)} docs  ${humanBytes(bytes).padStart(10)}  ${sha256.slice(0, 12)}`,
      );
    }

    const totalDocs = manifest.reduce((sum, entry) => sum + entry.documents, 0);
    const totalBytes = manifest.reduce((sum, entry) => sum + entry.bytes, 0);

    writeFileSync(
      join(outDir, 'manifest.json'),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          source: redactUri(uri),
          database: dbNameOf(uri),
          tool: 'scripts/safety/db-backup.ts',
          format: 'ndjson-canonical-ejson',
          totals: { collections: manifest.length, documents: totalDocs, bytes: totalBytes },
          collections: manifest,
        },
        null,
        2,
      ),
      'utf8',
    );

    console.log('\n─── backup complete ───');
    console.log(`  collections   ${manifest.length}`);
    console.log(`  documents     ${totalDocs}`);
    console.log(`  size          ${humanBytes(totalBytes)}`);
    console.log(`  elapsed       ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`  manifest      ${join(outDir, 'manifest.json')}`);
    console.log(`\n  A backup is not verified until it has been restored.`);
    console.log(`  Next: npx ts-node scripts/safety/db-restore.ts --from ${outDir} --to <scratch-uri>`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error('[backup] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
