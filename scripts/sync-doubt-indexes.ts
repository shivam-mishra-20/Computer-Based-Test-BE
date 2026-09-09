/**
 * Index preparation for the Doubt and Subject collections.
 *
 * ── What needs to exist ─────────────────────────────────────────────────────
 *   Doubt    { student: 1, lastMessageAt: -1 }
 *            { teacher: 1, lastMessageAt: -1 }
 *            Back the activity-ordered conversation lists. Ordering is CORRECT
 *            without them — they make it fast, not right.
 *
 *   Subject  { orgId: 1, nameLower: 1 } UNIQUE
 *            This one is a correctness guard: it is the race protection behind
 *            concurrent duplicate subject creation, which an application-level
 *            check alone cannot provide.
 *
 * ── Why this creates named indexes instead of calling syncIndexes() ─────────
 * `syncIndexes()` would do two unwanted things on this schema.
 *
 * 1. It CREATES every index the schema declares — including four the global
 *    tenant plugin adds to the embedded message/attachment subdocuments
 *    (`messages.orgId`, `messages.branchId`, `messages.attachments.orgId`,
 *    `messages.attachments.branchId`). Those are an artefact of the plugin
 *    applying to explicitly-constructed subschemas, they existed before this
 *    work, and building four indexes on a large collection to no purpose is
 *    not something a deployment step should do as a side effect.
 * 2. It DROPS anything not declared, which on a live collection is a
 *    destructive operation nobody asked for.
 *
 * So this creates exactly the three indexes above, in the background, and only
 * REPORTS the stale index rather than removing it.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 * DRY RUN BY DEFAULT — prints the plan and connects to nothing. Applying needs
 * an explicit `--apply` plus a deliberately-set MONGO_URI, so it cannot touch
 * production by being run in the wrong shell.
 *
 *   npm run indexes:sync:dry        # plan only, no connection
 *   npm run indexes:sync:apply      # create the three indexes
 *
 * `createIndex` is idempotent, so a re-run against an already-migrated
 * database is a no-op.
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const APPLY = process.argv.includes('--apply');

interface PlannedIndex {
  collection: 'doubts' | 'subjects';
  name: string;
  spec: Record<string, 1 | -1>;
  options?: { unique?: boolean };
  why: string;
}

const PLAN: PlannedIndex[] = [
  {
    collection: 'doubts',
    name: 'student_1_lastMessageAt_-1',
    spec: { student: 1, lastMessageAt: -1 },
    why: "student's conversation list, ordered by latest activity",
  },
  {
    collection: 'doubts',
    name: 'teacher_1_lastMessageAt_-1',
    spec: { teacher: 1, lastMessageAt: -1 },
    why: "teacher's conversation list, ordered by latest activity",
  },
  {
    collection: 'subjects',
    name: 'orgId_1_nameLower_1',
    spec: { orgId: 1, nameLower: 1 },
    options: { unique: true },
    why: 'case-insensitive duplicate-subject race guard (correctness)',
  },
];

/** Declared in code but superseded — reported, never dropped automatically. */
const SUPERSEDED = [
  {
    collection: 'subjects',
    name: 'orgId_1_name_1',
    why: 'case-SENSITIVE unique index, replaced by orgId_1_nameLower_1. Harmless if left (it is redundant, not wrong), so removing it is a separate, deliberate decision.',
  },
];

async function main() {
  console.log(APPLY ? 'Mode: APPLY' : 'Mode: DRY RUN (no connection, no changes)');

  console.log('\nIndexes to create:');
  for (const index of PLAN) {
    const unique = index.options?.unique ? ' UNIQUE' : '';
    console.log(`  ${index.collection}.${index.name}${unique}`);
    console.log(`      ${JSON.stringify(index.spec)}  — ${index.why}`);
  }

  console.log('\nSuperseded (reported only, NOT dropped):');
  for (const index of SUPERSEDED) {
    console.log(`  ${index.collection}.${index.name}`);
    console.log(`      ${index.why}`);
  }

  if (!APPLY) {
    console.log(
      '\nDry run complete — nothing was connected to and nothing was changed.\n' +
        'Run against a non-production database first:  npm run indexes:sync:apply',
    );
    return;
  }

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('\nMONGO_URI is not set. Refusing to guess a database.');
    process.exit(1);
  }

  const dbName = uri.split('/').pop()?.split('?')[0] ?? '(unknown)';
  console.log(`\nTarget database: ${dbName}`);

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database handle after connect');

  for (const index of PLAN) {
    // `background` keeps a large collection writable while the index builds.
    const created = await db
      .collection(index.collection)
      .createIndex(index.spec as never, {
        name: index.name,
        background: true,
        ...(index.options ?? {}),
      });
    console.log(`  created/confirmed ${index.collection}.${created}`);
  }

  console.log('\nCurrent indexes:');
  for (const collection of ['doubts', 'subjects'] as const) {
    const existing = await db.collection(collection).indexes();
    console.log(
      `  ${collection}: ${existing.map((i: { name?: string }) => i.name).join(', ')}`,
    );
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
