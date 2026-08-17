/**
 * P0 — prove a restore actually reproduced the backup.
 *
 * Recomputes, from the restored database, the same per-collection SHA-256
 * fingerprint that `db-backup.ts` computed from production, and compares.
 *
 * ── Why a count check is not enough ─────────────────────────────────────────
 * Counting rows proves nothing about content. A restore that turned every
 * ObjectId into a string, or every Date into an ISO string, has exactly the
 * right count and is completely unusable — and that is the *likely* failure
 * mode for a JSON-based tool, not an exotic one. The fingerprint catches it,
 * because it is computed over canonical EJSON in _id order on both sides.
 *
 * Exit code 0 = verified. Non-zero = do not proceed with the migration.
 *
 *   npx ts-node scripts/safety/verify-restore.ts --from backups/2026-08-17 --to <scratch-uri>
 */

import { config } from 'dotenv';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { EJSON, connect, dbNameOf, redactUri, requireEnv } from './lib';

config();

function arg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] ?? null : null;
}

/** Mirror of db-restore's derivation so verification targets the same place. */
function deriveScratchUri(productionUri: string, suffix: string): string {
  const match = productionUri.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/);
  if (!match) throw new Error('MONGO_URI could not be parsed to derive a scratch target.');
  const [, authority, db, query = ''] = match;
  return `${authority}${db}_${suffix}${query}`;
}

async function main() {
  const from = arg('--from');
  const suffix = arg('--scratch-suffix');
  const to =
    arg('--to') ||
    process.env.RESTORE_TARGET_URI ||
    (suffix ? deriveScratchUri(requireEnv('MONGO_URI'), suffix) : null);

  if (!from || !to) {
    console.error('Usage: verify-restore.ts --from <backup-dir> --to <scratch-uri>');
    process.exit(2);
  }

  const manifest = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8')) as {
    createdAt: string;
    collections: { name: string; documents: number; sha256: string }[];
  };

  console.log(`[verify] backup:  ${from}  (taken ${manifest.createdAt})`);
  console.log(`[verify] restored: ${redactUri(to)}\n`);

  const client = await connect(to);
  const failures: string[] = [];

  try {
    const db = client.db(dbNameOf(to));

    for (const entry of manifest.collections) {
      const collection = db.collection(entry.name);
      const documents = await collection.countDocuments();

      const hash = createHash('sha256');
      const cursor = collection.find({}, { sort: { _id: 1 }, batchSize: 500 });
      for await (const doc of cursor) {
        hash.update(EJSON.stringify(doc, { relaxed: false }) + '\n');
      }
      const sha256 = hash.digest('hex');

      const countOk = documents === entry.documents;
      const hashOk = sha256 === entry.sha256;

      if (countOk && hashOk) {
        console.log(`  ✓ ${entry.name.padEnd(28)} ${String(documents).padStart(8)} docs`);
      } else {
        const reason = !countOk
          ? `count ${documents} != ${entry.documents}`
          : `fingerprint differs (content changed, types lost, or order unstable)`;
        console.log(`  ✗ ${entry.name.padEnd(28)} ${reason}`);
        failures.push(`${entry.name}: ${reason}`);
      }
    }
  } finally {
    await client.close();
  }

  console.log('');
  if (failures.length) {
    console.error(`─── VERIFICATION FAILED — ${failures.length} collection(s) ───`);
    failures.forEach((f) => console.error(`  ${f}`));
    console.error('\nDo NOT proceed with the tenant migration. The backup is not trustworthy.');
    process.exit(1);
  }

  console.log('─── VERIFICATION PASSED ───');
  console.log('  Every collection matches the production backup by count and by content.');
  console.log('  P0 restore gate satisfied. Record the result in docs/production-safety.md.');
}

main().catch((error) => {
  console.error('[verify] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
