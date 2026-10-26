/**
 * The batch audit reports exactly what is in the database, and cannot write.
 *
 * Loopback MongoDB only — it builds fixtures in two databases named *selftest*:
 *   BATCH_AUDIT_TEST_URI=mongodb://127.0.0.1:27117/?directConnection=true \
 *     npx ts-node --transpile-only scripts/safety/batch-audit.test.ts
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import mongoose from 'mongoose';
import { ReadOnlyViolation, auditBatches, readOnlyDb } from './batch-audit';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

const LEGACY_DB = 'iso_batch_audit_legacy_selftest';
const MODERN_DB = 'iso_batch_audit_modern_selftest';

async function refuses(label: string, fn: () => unknown) {
  try {
    await fn();
    check(`${label} is refused`, false, 'it ran');
  } catch (error) {
    check(
      `${label} is refused`,
      error instanceof ReadOnlyViolation,
      String(error),
    );
  }
}

async function main() {
  const uri = process.env.BATCH_AUDIT_TEST_URI || '';
  const m = uri.match(/^mongodb:\/\/([^/?]+)/);
  if (
    !m ||
    !m[1].split(',').every((h) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h))
  ) {
    throw new Error(
      'Refusing: BATCH_AUDIT_TEST_URI must be a loopback MongoDB.',
    );
  }
  const client = await mongoose.mongo.MongoClient.connect(uri);
  try {
    const A = new mongoose.Types.ObjectId();
    const B = new mongoose.Types.ObjectId();
    const a = String(A);
    const b = String(B);
    const now = new Date('2026-10-01T00:00:00Z');

    // ── Fixture 1: a legacy-style database (global unique name_1) ───────────
    const legacy = client.db(LEGACY_DB);
    for (const name of [
      'orgs',
      'batches',
      'users',
      'schedules',
      'classrequests',
      'platformaudits',
      'auditlogs',
    ]) {
      await legacy.collection(name).deleteMany({});
    }
    await legacy
      .collection('batches')
      .createIndex({ name: 1 }, { unique: true, name: 'name_1' });
    await legacy.collection('orgs').insertMany([
      {
        _id: A,
        slug: 'org-a',
        name: 'Org A',
        status: 'active',
        createdAt: now,
      },
      {
        _id: B,
        slug: 'org-b',
        name: 'Org B',
        status: 'active',
        createdAt: now,
      },
    ]);
    const morningA = new mongoose.Types.ObjectId();
    const eveningB = new mongoose.Types.ObjectId();
    await legacy.collection('batches').insertMany([
      {
        name: 'Advanced/Basic',
        orgId: a,
        classLevels: ['11', '12'],
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        _id: morningA,
        name: 'Morning',
        orgId: a,
        classLevels: ['12'],
        createdAt: now,
        updatedAt: now,
      },
      {
        _id: eveningB,
        name: 'Evening',
        orgId: b,
        classLevels: ['12'],
        createdAt: now,
        updatedAt: now,
      },
      { name: 'Legacy-X', classLevels: ['9'], createdAt: now, updatedAt: now },
    ]);
    await legacy.collection('users').insertMany([
      {
        name: 'p1',
        email: 'p1@example.test',
        role: 'student',
        batch: 'Advanced/Basic',
        orgId: a,
      },
      {
        name: 'p2',
        email: 'p2@example.test',
        role: 'student',
        batch: 'Advanced/Basic',
        orgId: a,
      },
      {
        name: 'p3',
        email: 'p3@example.test',
        role: 'student',
        batch: 'Advanced',
        orgId: a,
      },
      {
        name: 'p4',
        email: 'p4@example.test',
        role: 'student',
        batch: 'Morning',
        orgId: a,
      },
      {
        name: 'p5',
        email: 'p5@example.test',
        role: 'teacher',
        batch: 'All Batches',
        orgId: a,
      },
      {
        name: 'p6',
        email: 'p6@example.test',
        role: 'student',
        batch: 'Basic',
        orgId: b,
      },
      {
        name: 'p7',
        email: 'p7@example.test',
        role: 'student',
        batch: '',
        orgId: b,
      },
    ]);
    await legacy.collection('schedules').insertMany([
      { title: 's1', batch: 'Advanced/Basic', orgId: a },
      { title: 's2', batch: 'Ghost', orgId: b },
    ]);
    await legacy.collection('classrequests').insertMany([
      { batchId: morningA, orgId: a },
      { batchId: eveningB, orgId: a },
      { batchId: new mongoose.Types.ObjectId(), orgId: a },
    ]);
    await legacy.collection('platformaudits').insertMany([
      {
        action: 'org.config.update',
        orgId: a,
        metadata: { batches: 2 },
        actorEmail: 'staff@example.test',
        createdAt: now,
      },
      { action: 'org.onboard', orgId: b, createdAt: now },
      { action: 'org.suspend', orgId: b, createdAt: now },
    ]);
    await legacy
      .collection('auditlogs')
      .insertOne({ action: 'org.config.update', entityId: a, createdAt: now });

    const countsBefore = async (db: mongoose.mongo.Db) =>
      JSON.stringify(
        await Promise.all(
          [
            'orgs',
            'batches',
            'users',
            'schedules',
            'classrequests',
            'platformaudits',
            'auditlogs',
          ].map((n) => db.collection(n).countDocuments({})),
        ),
      );
    const legacyCounts = await countsBefore(legacy);
    const legacyIndexes = JSON.stringify(
      await legacy.collection('batches').indexes(),
    );

    console.log('\nbatch audit — legacy-style fixture');
    const r1 = await auditBatches(legacy, {
      target: 'selftest',
      host: '127.0.0.1',
    });
    check(
      'legacy global unique name_1 is detected; no organization-scoped index',
      r1.indexes.legacyGlobalNameUnique && !r1.indexes.orgScopedNameUnique,
    );
    check(
      '4 batches; A owns Advanced/Basic and Morning; one has no organization',
      r1.batches.total === 4 &&
        JSON.stringify(r1.batches.byOrg[a]?.names) ===
          JSON.stringify(['Advanced/Basic', 'Morning']) &&
        r1.batches.byOrg.MISSING?.count === 1,
    );
    check(
      'organizations listed with slug and name',
      r1.organizations.length === 2 &&
        r1.organizations.some((o) => o.slug === 'org-a'),
    );
    check(
      'the "Advanced/Basic" batch is reported as a clue, with its classes and dates',
      r1.mergeClues.advancedBasicBatches.length === 1 &&
        r1.mergeClues.advancedBasicBatches[0].org === a &&
        r1.mergeClues.advancedBasicBatches[0].createdAt === now.toISOString(),
    );
    const clueA = r1.mergeClues.perOrg[a];
    check(
      'per-organization counts: A has 1 such batch, 2 students on it, 1 student on "Advanced", 1 schedule on it',
      !!clueA &&
        clueA.batchesNamed.advancedBasic === 1 &&
        clueA.usersWithBatch.advancedBasic === 2 &&
        clueA.usersWithBatch.advanced === 1 &&
        clueA.schedulesWithBatch.advancedBasic === 1,
      JSON.stringify(clueA),
    );
    check(
      'B: one student on "Basic", no such batch',
      r1.mergeClues.perOrg[b]?.usersWithBatch.basic === 1 &&
        r1.mergeClues.perOrg[b]?.batchesNamed.basic === 0,
    );
    check(
      'dangling student names: A "Advanced" (1), B "Basic" (1); placeholders and real batches excluded',
      JSON.stringify(r1.danglingReferences.usersByOrg[a]) ===
        JSON.stringify([{ batch: 'Advanced', users: 1 }]) &&
        JSON.stringify(r1.danglingReferences.usersByOrg[b]) ===
          JSON.stringify([{ batch: 'Basic', users: 1 }]),
      JSON.stringify(r1.danglingReferences.usersByOrg),
    );
    check(
      'dangling schedule names: B "Ghost"',
      JSON.stringify(r1.danglingReferences.schedulesByOrg[b]) ===
        JSON.stringify([{ batch: 'Ghost', schedules: 1 }]),
    );
    check(
      "class requests: 3 with a batch, 1 pointing at a missing batch, 1 at another organization's",
      JSON.stringify(r1.danglingReferences.classRequests) ===
        JSON.stringify({
          withBatchId: 3,
          batchIdMissing: 1,
          batchIdInOtherOrg: 1,
        }),
    );
    check(
      'configuration history: 2 platform events (config + onboard, not suspend), 1 organization-admin event, with batches applied',
      r1.configurationHistory.platformAudit.length === 2 &&
        r1.configurationHistory.platformAudit[0].batchesApplied === 2 &&
        r1.configurationHistory.orgAdminAudit.length === 1,
    );
    check(
      "the report carries no email address or person's name",
      !JSON.stringify(r1).includes('@') && !/"p[1-7]"/.test(JSON.stringify(r1)),
    );
    check(
      'it lists every query it issued',
      r1.meta.queries.length >= 8 &&
        r1.meta.queries.every((x) =>
          /^(listCollections|[a-z]+\.(find|aggregate|indexes))/.test(x),
        ),
      r1.meta.queries.join(' | '),
    );
    check(
      'the database is unchanged: same counts and indexes',
      (await countsBefore(legacy)) === legacyCounts &&
        JSON.stringify(await legacy.collection('batches').indexes()) ===
          legacyIndexes,
    );

    // ── Fixture 2: a modern database without unique indexes ──────────────────
    const modern = client.db(MODERN_DB);
    for (const name of ['orgs', 'batches'])
      await modern.collection(name).deleteMany({});
    await modern.collection('orgs').insertMany([
      { _id: A, slug: 'org-a' },
      { _id: B, slug: 'org-b' },
    ]);
    await modern
      .collection('batches')
      .insertMany([
        { name: 'Morning', orgId: a },
        { name: 'Morning', orgId: a },
        { name: 'Evening', orgId: a },
        { name: 'evening ', orgId: a },
        { name: 'Old' },
        { name: 'Old' },
        { name: 'Morning', orgId: b },
      ]);
    console.log('\nbatch audit — unindexed fixture');
    const r2 = await auditBatches(modern, {
      target: 'selftest',
      host: '127.0.0.1',
    });
    check(
      'no unique index of either kind',
      !r2.indexes.legacyGlobalNameUnique && !r2.indexes.orgScopedNameUnique,
    );
    check(
      'exact duplicate within A: "Morning" ×2',
      JSON.stringify(r2.duplicates.exactWithinOrg) ===
        JSON.stringify([{ org: a, name: 'Morning', count: 2 }]),
      JSON.stringify(r2.duplicates.exactWithinOrg),
    );
    check(
      'case/space variants within A: "Evening" and "evening "',
      r2.duplicates.caseOrSpaceVariantsWithinOrg.some(
        (d) =>
          d.org === a && d.names.length === 2 && d.names.includes('evening '),
      ),
    );
    check(
      'unattributed same-name batches (would block an organization-scoped index): "Old" ×2',
      JSON.stringify(r2.duplicates.unattributedSameName) ===
        JSON.stringify([{ name: 'Old', count: 2 }]),
    );
    check(
      'a name used by two organizations is listed (impossible under name_1)',
      r2.duplicates.namesSharedAcrossOrgs.some(
        (d) => d.name === 'Morning' && d.orgs === 2,
      ),
    );
    check(
      'collections that do not exist are reported absent, not errors',
      r2.collections.users === false &&
        r2.danglingReferences.classRequests.withBatchId === 0,
    );

    // ── The guard ──────────────────────────────────────────────────────────────
    console.log('\nthe read-only guard');
    const guarded = readOnlyDb(legacy, 5000);
    const col = guarded.collection('batches');
    await refuses('insertOne', () => col.insertOne({ name: 'nope' }));
    await refuses('insertMany', () => col.insertMany([{ name: 'nope' }]));
    await refuses('updateOne', () =>
      col.updateOne({}, { $set: { name: 'x' } }),
    );
    await refuses('updateMany', () =>
      col.updateMany({}, { $set: { name: 'x' } }),
    );
    await refuses('replaceOne', () => col.replaceOne({}, { name: 'x' }));
    await refuses('deleteOne', () => col.deleteOne({}));
    await refuses('deleteMany', () => col.deleteMany({}));
    await refuses('findOneAndUpdate', () =>
      col.findOneAndUpdate({}, { $set: { name: 'x' } }),
    );
    await refuses('findOneAndDelete', () => col.findOneAndDelete({}));
    await refuses('bulkWrite', () =>
      col.bulkWrite([{ deleteMany: { filter: {} } }]),
    );
    await refuses('createIndex', () =>
      col.createIndex({ orgId: 1, name: 1 }, { unique: true }),
    );
    await refuses('dropIndex', () => col.dropIndex('name_1'));
    await refuses('drop', () => col.drop());
    await refuses('rename', () => col.rename('batches_x'));
    await refuses('aggregate with $out', () =>
      col.aggregate([{ $match: {} }, { $out: 'leak' }]).toArray(),
    );
    await refuses('aggregate with $merge', () =>
      col.aggregate([{ $merge: { into: 'leak' } }]).toArray(),
    );
    await refuses('db.dropDatabase', () => guarded.dropDatabase());
    await refuses('db.createCollection', () =>
      guarded.createCollection('nope'),
    );
    await refuses('db.command', () => guarded.command({ dropDatabase: 1 }));
    await refuses('db.renameCollection', () =>
      guarded.renameCollection('batches', 'b2'),
    );
    check(
      'after every attempt: same counts, same indexes, no new collection',
      (await countsBefore(legacy)) === legacyCounts &&
        JSON.stringify(await legacy.collection('batches').indexes()) ===
          legacyIndexes &&
        !(await legacy.listCollections({ name: 'leak' }).toArray()).length,
    );
    const source = readFileSync(join(__dirname, 'batch-audit.ts'), 'utf8');
    const body = source.slice(
      source.indexOf('export async function auditBatches'),
      source.indexOf('function arg('),
    );
    check(
      'the audit body calls no write method',
      !/\.(insert\w*|update\w*|replace\w*|delete\w*|findOneAnd\w*|bulkWrite|createIndex\w*|dropIndex\w*|drop|rename\w*|command)\(/.test(
        body,
      ),
    );
  } finally {
    await client.close();
  }
  console.log(`\n  ${checks - failures}/${checks} checks passed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
