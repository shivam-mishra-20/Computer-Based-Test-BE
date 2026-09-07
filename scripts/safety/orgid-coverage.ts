/**
 * How much of production already carries an `orgId`. READ ONLY.
 *
 * ── Why this exists separately from the backfill's dry run ──────────────────
 * `backfill-org.ts --production` (without `--execute`) reports exactly this and
 * writes nothing. But it is the migration tool, and pointing the migration tool
 * at production — even in its safe mode — is the kind of command that should
 * require a deliberate human decision rather than appearing in an agent's
 * transcript. This asks the same question with a script that has no write path
 * at all: it issues `countDocuments` and nothing else.
 *
 * The numbers it produces are what the cutover checklist needs:
 *
 *   · how many documents the backfill will touch, per collection
 *   · how many already carry an orgId (a re-run is a no-op on those)
 *   · how many PUBLIC_LEARNER accounts exist, because those belong to Org 000
 *     and the backfill deliberately assigns them to Org 001 for now
 *   · which collections are excluded as global
 *
 * ── The exclusion list is COPIED, and that is the point ─────────────────────
 * It mirrors `GLOBAL_COLLECTIONS` in `backfill-org.ts`. Importing it would be
 * tidier and would also import a module whose main() can write; the whole
 * reason this file exists is to have no such path. The copy is asserted below —
 * if the two lists diverge, this script says so rather than quietly reporting
 * the wrong scope.
 *
 *   npx ts-node --transpile-only scripts/safety/orgid-coverage.ts
 *   npx ts-node --transpile-only scripts/safety/orgid-coverage.ts --out docs/baselines/orgid-coverage.json
 */

import { config } from 'dotenv';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import mongoose from 'mongoose';
import { configureDnsForSrv, dbNameOf, redactUri, requireEnv } from './lib';

config();

/** Mirrors GLOBAL_COLLECTIONS in backfill-org.ts. Verified against it below. */
const GLOBAL_COLLECTIONS = new Set([
  'orgs',
  'plans',
  'modules',
  'platformusers',
  'system.views',
  'system.profile',
]);

const PUBLIC_LEARNER_FILTER = { accountType: 'PUBLIC_LEARNER' };

interface Row {
  name: string;
  total: number;
  withOrgId: number;
  missingOrgId: number;
  publicLearners: number;
  global: boolean;
}

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] ?? null : null;
}

/**
 * Confirm the copied exclusion list still matches the backfill's.
 *
 * A drift here would make this report describe a different migration from the
 * one that will actually run — the most useless possible kind of wrong.
 */
function verifyExclusionsMatch(): { ok: boolean; detail: string } {
  try {
    const source = readFileSync(join(__dirname, 'backfill-org.ts'), 'utf8');
    const block = source.match(/const GLOBAL_COLLECTIONS = new Set\(\[([\s\S]*?)\]\)/);
    if (!block) return { ok: false, detail: 'could not find GLOBAL_COLLECTIONS in backfill-org.ts' };
    const theirs = new Set(
      [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]),
    );
    const mine = [...GLOBAL_COLLECTIONS].sort().join(',');
    const other = [...theirs].sort().join(',');
    return mine === other
      ? { ok: true, detail: `${theirs.size} collections` }
      : { ok: false, detail: `this: ${mine}  backfill: ${other}` };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

async function main(): Promise<void> {
  const uri = requireEnv('MONGO_URI');
  configureDnsForSrv();

  console.log(`\nORGID COVERAGE — READ ONLY`);
  console.log(`  target ${redactUri(uri)}`);
  console.log(`  database ${dbNameOf(uri)}\n`);

  const exclusions = verifyExclusionsMatch();
  console.log(
    `  exclusion list matches backfill-org.ts: ${exclusions.ok ? 'yes' : 'NO'} (${exclusions.detail})\n`,
  );

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20_000 });
  const db = mongoose.connection.db as mongoose.mongo.Db;

  const collections = (await db.listCollections().toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort();

  const rows: Row[] = [];
  for (const name of collections) {
    const collection = db.collection(name);
    const isGlobal = GLOBAL_COLLECTIONS.has(name);

    const total = await collection.countDocuments({});
    // `$exists: true` AND not null — a document with `orgId: null` has the
    // field but is not attributed, and the backfill treats it as missing.
    const withOrgId = isGlobal
      ? 0
      : await collection.countDocuments({ orgId: { $exists: true, $ne: null } });
    const publicLearners =
      name === 'users' ? await collection.countDocuments(PUBLIC_LEARNER_FILTER) : 0;

    rows.push({
      name,
      total,
      withOrgId,
      missingOrgId: isGlobal ? 0 : total - withOrgId,
      publicLearners,
      global: isGlobal,
    });
  }

  let toBackfill = 0;
  let alreadyDone = 0;
  let totalDocs = 0;

  console.log('  collection                       total   has orgId   needs orgId');
  console.log('  ' + '─'.repeat(66));
  for (const row of rows) {
    totalDocs += row.total;
    if (row.global) {
      console.log(`  ${row.name.padEnd(28)} ${String(row.total).padStart(8)}   ${'—'.padStart(9)}   ${'GLOBAL'.padStart(11)}`);
      continue;
    }
    if (row.total === 0) continue;
    toBackfill += row.missingOrgId;
    alreadyDone += row.withOrgId;
    console.log(
      `  ${row.name.padEnd(28)} ${String(row.total).padStart(8)}   ${String(row.withOrgId).padStart(9)}   ${String(row.missingOrgId).padStart(11)}` +
        (row.publicLearners ? `   (${row.publicLearners} PUBLIC_LEARNER)` : ''),
    );
  }

  const learners = rows.find((r) => r.name === 'users')?.publicLearners ?? 0;

  console.log('\n─── summary ───');
  console.log(`  collections                 ${rows.length}`);
  console.log(`  documents                   ${totalDocs}`);
  console.log(`  already attributed          ${alreadyDone}`);
  console.log(`  the backfill would write    ${toBackfill}`);
  console.log(`  PUBLIC_LEARNER users        ${learners}  (assigned to Org 001 now; Org 000 later)`);
  console.log(`  global collections skipped  ${rows.filter((r) => r.global).length}`);

  const out = arg('--out');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          database: dbNameOf(uri),
          exclusionsMatchBackfill: exclusions.ok,
          totals: { collections: rows.length, documents: totalDocs, alreadyAttributed: alreadyDone, wouldWrite: toBackfill, publicLearners: learners },
          collections: rows,
        },
        null,
        2,
      ),
    );
    console.log(`\n[coverage] written: ${out}`);
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
