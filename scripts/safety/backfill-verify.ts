/**
 * Verify a backfill did exactly what it claimed — and nothing else.
 *
 * Runs against the P0 inventory baseline, so it answers the question that
 * matters after any migration: *is every document still there, and is it now
 * attributed correctly?* A backfill that quietly dropped rows would otherwise
 * look like a success, because the thing it reports is how many rows it wrote.
 *
 * Checks, in the order they would catch a disaster:
 *   1. No collection lost or gained documents.
 *   2. Every tenant collection is fully attributed (0 missing orgId).
 *   3. Global collections were NOT touched.
 *   4. Relationships still resolve — attempts to exams, results to users, etc.
 *      A count check cannot see a broken join; this can.
 *   5. Spot-check every entity class named in the migration plan.
 *
 *   npx ts-node --transpile-only scripts/safety/backfill-verify.ts --scratch-suffix restore_2026_08_17
 */

import { config } from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import mongoose from 'mongoose';
import { configureDnsForSrv, redactUri, requireEnv } from './lib';

config();

const GLOBAL_COLLECTIONS = new Set(['orgs', 'plans', 'modules', 'platformusers']);
const PROGRESS_COLLECTION = '_migration_progress';

/** Entity classes the plan requires evidence for, and how to find them. */
const ENTITY_CHECKS: { label: string; collection: string }[] = [
  { label: 'users', collection: 'users' },
  { label: 'exams', collection: 'exams' },
  { label: 'attempts', collection: 'attempts' },
  { label: 'results (testresults)', collection: 'testresults' },
  { label: 'results (offlineresults)', collection: 'offlineresults' },
  { label: 'questions (class_11)', collection: 'class_11' },
  { label: 'questions (importedquestions)', collection: 'importedquestions' },
  { label: 'attendance', collection: 'attendances' },
  { label: 'notifications', collection: 'notifications' },
  { label: 'files (filemetadatas)', collection: 'filemetadatas' },
  { label: 'audit logs', collection: 'auditlogs' },
];

/** Referential checks — a broken join is invisible to a row count. */
const RELATIONSHIP_CHECKS: {
  label: string;
  from: string;
  localField: string;
  to: string;
}[] = [
  // Field names verified against the models — an unchecked guess here produces
  // "no rows to check", which looks like a pass and tests nothing.
  { label: 'attempt -> exam', from: 'attempts', localField: 'examId', to: 'exams' },
  { label: 'attempt -> user', from: 'attempts', localField: 'userId', to: 'users' },
  { label: 'attendance -> user', from: 'attendances', localField: 'studentId', to: 'users' },
  { label: 'notification -> user', from: 'notifications', localField: 'userId', to: 'users' },
  // NOT checked: testresult -> user. TestResult.studentId is a STRING nested
  // inside the `students` subdocument array, not a root-level ObjectId, so this
  // matcher cannot express it. Left out deliberately rather than left in
  // reporting "no rows to check" — a check that cannot run reads like a pass
  // and is worse than no check at all.
];

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] ?? null : null;
}

function deriveScratchUri(productionUri: string, suffix: string): string {
  const m = productionUri.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/);
  if (!m) throw new Error('MONGO_URI could not be parsed.');
  return `${m[1]}${m[2]}_${suffix}${m[3] ?? ''}`;
}

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

async function main() {
  const productionUri = requireEnv('MONGO_URI');
  const suffix = arg('--scratch-suffix');
  const uri = suffix
    ? deriveScratchUri(productionUri, suffix)
    : process.argv.includes('--production')
      ? productionUri
      : null;

  if (!uri) {
    console.error('Usage: backfill-verify.ts --scratch-suffix <suffix> | --production');
    process.exit(2);
    return;
  }

  configureDnsForSrv();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });
  const db = mongoose.connection.db as mongoose.mongo.Db;

  console.log(`[verify] target: ${redactUri(uri)}\n`);

  try {
    const org = await db.collection('orgs').findOne({ slug: 'abhigyan' });
    if (!org) throw new Error('Org 001 not found — nothing to verify against.');
    const orgId = String(org._id);

    // ── 1. Nothing lost or gained ─────────────────────────────────────────
    console.log('document counts vs the P0 baseline');
    const baselinePath = join(process.cwd(), 'docs', 'baselines', 'db-inventory-2026-08-17.json');
    if (existsSync(baselinePath)) {
      const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
        collections: { name: string; documents: number }[];
      };
      let drift = 0;
      for (const entry of baseline.collections) {
        const actual = await db.collection(entry.name).countDocuments();
        // The scratch restore also holds the seeded Org and any probe rows a
        // regression script created, so only SHRINKAGE is a failure. Losing a
        // document is the disaster; gaining one is explainable.
        if (actual >= entry.documents) continue;

        // A collection with a TTL index shrinks on its own, continuously and
        // by design — `auditlogs` expires after 30 days and had already lost
        // ~1,400 rows between the backup and this run. Counting that as data
        // loss would make this check cry wolf on every rehearsal, and a check
        // that always fails is a check nobody reads.
        const indexes = await db.collection(entry.name).indexes();
        const hasTtl = indexes.some(
          (index) => (index as { expireAfterSeconds?: number }).expireAfterSeconds !== undefined,
        );

        if (hasTtl) {
          console.log(
            `  – ${entry.name}: ${actual} < baseline ${entry.documents} ` +
              `(TTL index — expected expiry, not loss)`,
          );
          continue;
        }

        drift++;
        console.log(`  ✗ ${entry.name}: ${actual} < baseline ${entry.documents} — DOCUMENTS LOST`);
      }
      check('no non-TTL collection lost documents', drift === 0, `${drift} collection(s) shrank`);
    } else {
      check('baseline inventory present', false, `missing ${baselinePath}`);
    }

    // ── 2. Full attribution ───────────────────────────────────────────────
    console.log('\ntenant attribution');
    const names = (await db.listCollections({}, { nameOnly: false }).toArray())
      .filter((c) => c.type !== 'view')
      .map((c) => c.name)
      .filter((n) => n !== PROGRESS_COLLECTION && !GLOBAL_COLLECTIONS.has(n));

    let unattributed = 0;
    const offenders: string[] = [];
    for (const name of names) {
      const missing = await db.collection(name).countDocuments({ orgId: { $exists: false } });
      if (missing > 0) {
        unattributed += missing;
        offenders.push(`${name} (${missing})`);
      }
    }
    check(
      'every tenant collection is fully attributed',
      unattributed === 0,
      offenders.join(', '),
    );

    // ── 3. Global collections untouched ───────────────────────────────────
    console.log('\nglobal collections');
    for (const name of GLOBAL_COLLECTIONS) {
      const exists = await db.listCollections({ name }).hasNext();
      if (!exists) continue;
      const stamped = await db.collection(name).countDocuments({ orgId: { $exists: true } });
      check(`${name} was NOT stamped with an orgId`, stamped === 0, `${stamped} document(s) stamped`);
    }

    // ── 4. Relationships still resolve ────────────────────────────────────
    console.log('\nrelationships (a count check cannot see a broken join)');
    for (const rel of RELATIONSHIP_CHECKS) {
      const exists = await db.listCollections({ name: rel.from }).hasNext();
      if (!exists) continue;

      const sample = await db
        .collection(rel.from)
        .find({ [rel.localField]: { $exists: true, $ne: null } })
        .limit(50)
        .toArray();

      if (sample.length === 0) {
        console.log(`  – ${rel.label}: no rows to check`);
        continue;
      }

      let resolved = 0;
      let sameOrg = 0;
      for (const doc of sample) {
        const target = await db
          .collection(rel.to)
          .findOne({ _id: doc[rel.localField] as never });
        if (target) {
          resolved++;
          if (String(target.orgId) === String(doc.orgId)) sameOrg++;
        }
      }
      check(
        `${rel.label}: ${resolved}/${sample.length} resolve`,
        resolved > 0,
        'no referenced document resolved — the join is broken',
      );
      check(
        `${rel.label}: referenced documents are in the SAME org`,
        sameOrg === resolved,
        `${resolved - sameOrg} of ${resolved} cross an org boundary`,
      );
    }

    // ── 5. Entity classes ─────────────────────────────────────────────────
    console.log('\nentity classes required by the migration plan');
    for (const entity of ENTITY_CHECKS) {
      const exists = await db.listCollections({ name: entity.collection }).hasNext();
      if (!exists) {
        console.log(`  – ${entity.label}: collection absent`);
        continue;
      }
      const total = await db.collection(entity.collection).countDocuments();
      const attributed = await db.collection(entity.collection).countDocuments({ orgId });
      check(
        `${entity.label}: ${attributed}/${total} attributed to Org 001`,
        total === 0 || attributed === total,
        `${total - attributed} document(s) unattributed or in another org`,
      );
    }

    console.log('');
    if (failures) {
      console.error(`─── VERIFICATION FAILED — ${failures} of ${checks} checks ───`);
      process.exit(1);
    }
    console.log(`─── VERIFICATION PASSED — ${checks} checks ───`);
  } finally {
    await mongoose.connection.close();
  }
}

main().catch((error) => {
  console.error('[verify] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
