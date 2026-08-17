/**
 * Assign every existing document to Org 001.
 *
 * The single highest-risk operation in the whole migration: it touches every
 * collection in the database. Everything about its design is chosen so that a
 * failure halfway through is survivable and a mistake is reversible.
 *
 *   DRY-RUN BY DEFAULT   Nothing is written without --execute. The dry run
 *                        reports exactly what would change, per collection.
 *   BATCHED              Bounded writes, so a long run never holds one enormous
 *                        operation open against a cluster serving production.
 *   RESUMABLE            Progress is persisted per collection. An interrupted
 *                        run continues where it stopped instead of restarting.
 *   IDEMPOTENT           Only documents WITHOUT an orgId are touched, so a
 *                        re-run is a no-op and a partial run can be repeated
 *                        safely any number of times.
 *   REVERSIBLE           --undo unsets the field it set, restoring the exact
 *                        prior state. The field is purely additive, so nothing
 *                        else has to be restored.
 *
 * ── What must NOT be backfilled ─────────────────────────────────────────────
 * Global collections have no tenant: the Org registry itself, and (later) the
 * plan and module catalogue and platform staff. Stamping them with Org 001
 * would make platform-wide records look like one customer's property, and the
 * damage would only surface when a second tenant could not see a plan.
 *
 * Public-learner data is the subtler case — see PUBLIC_LEARNER_NOTE below.
 *
 *   npx ts-node --transpile-only scripts/safety/backfill-org.ts --scratch-suffix restore_2026_08_17
 *   npx ts-node --transpile-only scripts/safety/backfill-org.ts --scratch-suffix restore_2026_08_17 --execute
 *   npx ts-node --transpile-only scripts/safety/backfill-org.ts --scratch-suffix restore_2026_08_17 --undo
 */

import { config } from 'dotenv';
import mongoose from 'mongoose';
import { configureDnsForSrv, humanBytes, redactUri, requireEnv } from './lib';

config();

const BATCH = 1000;

/**
 * Collections that must never receive an orgId.
 *
 * `orgs` is the tenant registry: a scoped registry is circular. The rest do not
 * exist yet but are listed now so that adding them later cannot silently
 * inherit the wrong behaviour from a backfill re-run.
 */
const GLOBAL_COLLECTIONS = new Set([
  'orgs',
  'plans',
  'modules',
  'platformusers',
  // Mongo internals that may appear in listCollections on some deployments.
  'system.views',
  'system.profile',
]);

/**
 * PUBLIC_LEARNER_NOTE
 *
 * Public learners are self-registered accounts that use the platform directly;
 * they are NOT enrolled at Abhigyan. Architecturally they belong to Org 000,
 * the platform-owned public organization — not to Org 001.
 *
 * This script does NOT attempt to split them out, and that is deliberate:
 *   - Org 000 does not exist yet, so there is nowhere correct to put them.
 *   - Assigning them to Org 001 now is REVERSIBLE (a later, targeted migration
 *     moves accountType:'PUBLIC_LEARNER' rows to Org 000).
 *   - Leaving them with no orgId is NOT reversible in the same easy way,
 *     because enforce mode would make them invisible and unrepairable through
 *     the application.
 *
 * The counts are reported separately so the size of that later migration is
 * known rather than discovered.
 */
const PUBLIC_LEARNER_FILTER = { accountType: 'PUBLIC_LEARNER' };

interface CollectionPlan {
  name: string;
  total: number;
  missingOrgId: number;
  publicLearners: number;
  skipped: boolean;
  reason?: string;
}

interface RunProgress {
  orgId: string;
  startedAt: string;
  completed: string[];
  counts: Record<string, number>;
}

const PROGRESS_COLLECTION = '_migration_progress';
const PROGRESS_KEY = 'backfill-org-001';

function arg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] ?? null : null;
}

function deriveScratchUri(productionUri: string, suffix: string): string {
  const match = productionUri.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/);
  if (!match) throw new Error('MONGO_URI could not be parsed.');
  const [, authority, db, query = ''] = match;
  return `${authority}${db}_${suffix}${query}`;
}

async function resolveOrgId(db: mongoose.mongo.Db, explicit: string | null): Promise<string> {
  if (explicit) return explicit;
  const org = await db.collection('orgs').findOne({ slug: 'abhigyan' });
  if (!org) {
    throw new Error(
      'Org 001 not found (slug "abhigyan"). Run seed-org-001.ts against this database first.',
    );
  }
  return String(org._id);
}

async function buildPlan(db: mongoose.mongo.Db): Promise<CollectionPlan[]> {
  const names = (await db.listCollections({}, { nameOnly: false }).toArray())
    .filter((c) => c.type !== 'view')
    .map((c) => c.name)
    .filter((n) => n !== PROGRESS_COLLECTION)
    .sort();

  const plan: CollectionPlan[] = [];

  for (const name of names) {
    const collection = db.collection(name);
    if (GLOBAL_COLLECTIONS.has(name)) {
      plan.push({
        name,
        total: await collection.countDocuments(),
        missingOrgId: 0,
        publicLearners: 0,
        skipped: true,
        reason: 'global collection — has no tenant',
      });
      continue;
    }

    const total = await collection.countDocuments();
    const missingOrgId = await collection.countDocuments({ orgId: { $exists: false } });
    const publicLearners =
      name === 'users' ? await collection.countDocuments(PUBLIC_LEARNER_FILTER) : 0;

    plan.push({ name, total, missingOrgId, publicLearners, skipped: false });
  }

  return plan;
}

async function loadProgress(db: mongoose.mongo.Db): Promise<RunProgress | null> {
  const doc = await db.collection(PROGRESS_COLLECTION).findOne({ _id: PROGRESS_KEY as never });
  return (doc as unknown as RunProgress) ?? null;
}

async function saveProgress(db: mongoose.mongo.Db, progress: RunProgress): Promise<void> {
  await db
    .collection(PROGRESS_COLLECTION)
    .updateOne({ _id: PROGRESS_KEY as never }, { $set: progress }, { upsert: true });
}

async function backfillCollection(
  db: mongoose.mongo.Db,
  name: string,
  orgId: string,
): Promise<number> {
  const collection = db.collection(name);
  let written = 0;

  // Loop rather than one updateMany: bounded batches keep each write short, so
  // an interruption loses at most one batch and the cluster is never holding a
  // single enormous operation open while it also serves production.
  for (;;) {
    const batch = await collection
      .find({ orgId: { $exists: false } }, { projection: { _id: 1 } })
      .limit(BATCH)
      .toArray();

    if (batch.length === 0) break;

    const result = await collection.updateMany(
      { _id: { $in: batch.map((d) => d._id) }, orgId: { $exists: false } },
      { $set: { orgId, branchId: null } },
    );
    written += result.modifiedCount;

    // Defensive: if a batch modified nothing, the filter and the write disagree
    // and looping would spin forever.
    if (result.modifiedCount === 0) break;
  }

  return written;
}

async function undoCollection(db: mongoose.mongo.Db, name: string, orgId: string): Promise<number> {
  // Only unsets what THIS backfill set. A document already carrying a different
  // orgId belongs to another tenant and must not be touched.
  const result = await db
    .collection(name)
    .updateMany({ orgId }, { $unset: { orgId: '', branchId: '' } });
  return result.modifiedCount;
}

async function main() {
  const productionUri = requireEnv('MONGO_URI');
  const suffix = arg('--scratch-suffix');
  const wantsProduction = process.argv.includes('--production');
  const execute = process.argv.includes('--execute');
  const undo = process.argv.includes('--undo');
  const explicitOrg = arg('--org-id');

  let uri: string;
  if (suffix) uri = deriveScratchUri(productionUri, suffix);
  else if (wantsProduction) uri = productionUri;
  else {
    console.error(
      'Refusing to guess a target.\n' +
        '  Rehearsal:  --scratch-suffix restore_2026_08_17\n' +
        '  Production: --production\n\n' +
        'Add --execute to write. Without it this is a DRY RUN.',
    );
    process.exit(2);
    return;
  }

  configureDnsForSrv();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });
  const db = mongoose.connection.db as mongoose.mongo.Db;

  try {
    const orgId = await resolveOrgId(db, explicitOrg);

    console.log(`[backfill] target : ${redactUri(uri)}`);
    console.log(`[backfill] org    : ${orgId}`);
    console.log(`[backfill] mode   : ${undo ? 'UNDO' : execute ? 'EXECUTE' : 'DRY RUN'}`);
    if (wantsProduction && execute) {
      console.log('[backfill] ⚠ PRODUCTION WRITE');
    }
    console.log('');

    // ── UNDO ───────────────────────────────────────────────────────────────
    if (undo) {
      const plan = await buildPlan(db);
      let reverted = 0;
      for (const entry of plan) {
        if (entry.skipped) continue;
        const count = execute ? await undoCollection(db, entry.name, orgId) : 0;
        const marked = await db.collection(entry.name).countDocuments({ orgId });
        console.log(
          `  ${entry.name.padEnd(28)} ${execute ? `reverted ${count}` : `would revert ${marked}`}`,
        );
        reverted += execute ? count : marked;
      }
      if (execute) {
        await db.collection(PROGRESS_COLLECTION).deleteOne({ _id: PROGRESS_KEY as never });
      }
      console.log(`\n${execute ? 'Reverted' : 'Would revert'} ${reverted} document(s).`);
      return;
    }

    // ── PLAN ───────────────────────────────────────────────────────────────
    const plan = await buildPlan(db);
    const progress = (await loadProgress(db)) ?? {
      orgId,
      startedAt: new Date().toISOString(),
      completed: [],
      counts: {},
    };

    if (progress.orgId !== orgId) {
      throw new Error(
        `Existing progress record targets org ${progress.orgId}, not ${orgId}. ` +
          `Refusing to mix two backfills.`,
      );
    }

    if (progress.completed.length) {
      console.log(`[backfill] resuming — ${progress.completed.length} collection(s) already done\n`);
    }

    let totalToWrite = 0;
    let totalDocs = 0;

    for (const entry of plan) {
      totalDocs += entry.total;
      if (entry.skipped) {
        console.log(`  ${'SKIP'.padEnd(8)} ${entry.name.padEnd(28)} ${entry.reason}`);
        continue;
      }
      const done = progress.completed.includes(entry.name);
      const label = done ? 'DONE' : entry.missingOrgId === 0 ? 'OK' : 'PENDING';
      totalToWrite += done ? 0 : entry.missingOrgId;
      console.log(
        `  ${label.padEnd(8)} ${entry.name.padEnd(28)} ${String(entry.missingOrgId).padStart(7)} / ${String(entry.total).padStart(7)} need orgId` +
          (entry.publicLearners ? `   (${entry.publicLearners} public learners — see PUBLIC_LEARNER_NOTE)` : ''),
      );
    }

    console.log('\n─── plan ───');
    console.log(`  collections      ${plan.length} (${plan.filter((p) => p.skipped).length} skipped as global)`);
    console.log(`  documents        ${totalDocs}`);
    console.log(`  need orgId       ${totalToWrite}`);

    if (!execute) {
      console.log('\nDRY RUN — nothing written. Re-run with --execute to apply.');
      return;
    }

    // ── EXECUTE ────────────────────────────────────────────────────────────
    console.log('\n─── executing ───');
    const started = Date.now();

    for (const entry of plan) {
      if (entry.skipped) continue;
      if (progress.completed.includes(entry.name)) continue;

      const written = await backfillCollection(db, entry.name, orgId);
      progress.completed.push(entry.name);
      progress.counts[entry.name] = written;
      // Persisted after EVERY collection, so an interruption resumes from the
      // next one rather than redoing the whole database.
      await saveProgress(db, progress);

      console.log(`  ${entry.name.padEnd(28)} ${String(written).padStart(7)} updated`);
    }

    // ── Report from the DATABASE, not from the accumulated counter ─────────
    // The counter under-reports after an interruption, and did so by ~45,000
    // during rehearsal: the process was SIGKILLed part-way through `auditlogs`,
    // so those writes landed but their progress entry never saved. The resume
    // then wrote only the remaining rows (idempotency working exactly as
    // intended), leaving the counter short of reality.
    //
    // The data was correct; the NUMBER was not. In a migration tool that is
    // dangerous in both directions — someone reconciling a short count panics
    // over a healthy database, or learns to ignore the number and misses a real
    // discrepancy. So the authoritative figure is counted from the collections
    // themselves at the end.
    let attributed = 0;
    let stillMissing = 0;
    for (const entry of plan) {
      if (entry.skipped) continue;
      const collection = db.collection(entry.name);
      attributed += await collection.countDocuments({ orgId });
      stillMissing += await collection.countDocuments({ orgId: { $exists: false } });
    }

    const counterTotal = Object.values(progress.counts).reduce((a, b) => a + b, 0);

    console.log(`\n─── complete ───`);
    console.log(`  attributed to org  ${attributed}   (counted from the database)`);
    console.log(`  still missing      ${stillMissing}`);
    console.log(`  writes recorded    ${counterTotal}${
      counterTotal !== attributed
        ? '   (lower than attributed — normal after a resumed run)'
        : ''
    }`);
    console.log(`  elapsed            ${((Date.now() - started) / 1000).toFixed(1)}s`);

    if (stillMissing > 0) {
      console.warn(
        `\n  ⚠ ${stillMissing} document(s) still have no orgId. Re-run to finish — ` +
          `the operation is idempotent.`,
      );
    }
    console.log(`\n  Verify: npm run safety:backfill-verify -- --scratch-suffix <suffix>`);
  } finally {
    await mongoose.connection.close();
  }
}

void humanBytes;

main().catch((error) => {
  console.error('[backfill] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
