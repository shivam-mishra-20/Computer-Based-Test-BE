/**
 * The orgId scan reports exactly what is there — checked against a database
 * seeded with known counts. Loopback MongoDB only (it writes the fixture):
 *
 *   ORGID_SCAN_TEST_URI=mongodb://127.0.0.1:27117/iso_scan_selftest?directConnection=true \
 *     npx ts-node --transpile-only scripts/safety/orgid-scan.test.ts
 */

import mongoose from 'mongoose';
import { modelInventory, scanDatabase } from './orgid-scan';

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

async function main() {
  const uri = process.env.ORGID_SCAN_TEST_URI || '';
  const m = uri.match(/^mongodb:\/\/([^/?]+)\/([^?]+)/);
  if (
    !m ||
    !m[1]
      .split(',')
      .every((h) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h)) ||
    !/selftest/.test(m[2])
  ) {
    throw new Error(
      'Refusing: ORGID_SCAN_TEST_URI must be a loopback MongoDB and a database named *selftest*.',
    );
  }

  const inventory = modelInventory();
  const scopedNames = [...inventory.scoped.keys()];
  const [a, b] = ['exams', 'attempts'].filter((c) => scopedNames.includes(c));
  if (!a || !b)
    throw new Error(
      `expected exams and attempts to be tenant-scoped (got ${scopedNames.slice(0, 10).join(', ')}…)`,
    );

  const conn = await mongoose
    .createConnection(uri, { serverSelectionTimeoutMS: 10000 })
    .asPromise();
  const db = conn.db as unknown as mongoose.mongo.Db;
  try {
    // A fresh fixture each run, inside the selftest database only.
    for (const name of [a, b, 'orgs', 'stray_leftovers'])
      await db.collection(name).deleteMany({});
    const org1 = new mongoose.Types.ObjectId();
    const org2 = new mongoose.Types.ObjectId();
    const ghost = new mongoose.Types.ObjectId();
    await db.collection('orgs').insertMany([
      { _id: org1, slug: 'org-one', status: 'active' },
      { _id: org2, slug: 'org-two', status: 'active' },
    ]);
    await db.collection(a).insertMany([
      { title: 'a1', orgId: org1 },
      { title: 'a2', orgId: org1 },
      { title: 'a3', orgId: String(org2) }, // string form of a real org
      { title: 'a4' }, // missing
      { title: 'a5', orgId: null }, // null
      { title: 'a6', orgId: ghost }, // orphan
    ]);
    await db.collection(b).insertMany([
      { n: 1, orgId: org2 },
      { n: 2, orgId: org2 },
    ]);
    await db
      .collection('stray_leftovers')
      .insertMany([{ x: 1 }, { x: 2, orgId: org1 }]);

    const report = await scanDatabase(db, inventory);
    const sa = report.scoped.find((s) => s.collection === a)!;
    const sb = report.scoped.find((s) => s.collection === b)!;

    console.log('\norgId scan — known fixture');
    check(
      'both organizations are listed',
      report.orgs.length === 2 && report.orgs.some((o) => o.slug === 'org-one'),
    );
    check(
      `${a}: 6 documents, 1 missing, 1 null`,
      sa.total === 6 && sa.missingOrgId === 1 && sa.nullOrgId === 1,
      JSON.stringify(sa),
    );
    check(
      `${a}: the ghost orgId is reported as orphaned, the string form of a real org is not`,
      sa.orphanOrgIds.length === 1 &&
        sa.orphanOrgIds[0].orgId === String(ghost) &&
        sa.orphanOrgIds[0].count === 1,
      JSON.stringify(sa.orphanOrgIds),
    );
    check(
      `${a}: mixed orgId types are visible (objectId + string + null + missing)`,
      sa.orgIdTypes.objectId === 3 &&
        sa.orgIdTypes.string === 1 &&
        sa.orgIdTypes.null === 1 &&
        sa.orgIdTypes.missing === 1,
      JSON.stringify(sa.orgIdTypes),
    );
    check(
      `${a}: per-org counts merge ObjectId and string forms`,
      sa.perOrg[String(org1)] === 2 && sa.perOrg[String(org2)] === 1,
    );
    check(
      `${b}: fully attributed`,
      sb.total === 2 &&
        sb.missingOrgId === 0 &&
        sb.nullOrgId === 0 &&
        sb.orphanOrgIds.length === 0,
    );
    check(
      'summary: 2 unattributed, 1 orphaned, 8 scoped documents',
      report.summary.unattributed === 2 &&
        report.summary.orphaned === 1 &&
        report.summary.documents === 8,
      JSON.stringify(report.summary),
    );
    check(
      'orgs is exempt, not scanned as tenant data',
      report.exemptCollections.includes('orgs') &&
        !report.scoped.some((s) => s.collection === 'orgs'),
    );
    check(
      'a collection no model maps to is listed separately with its counts',
      report.unmappedCollections.some(
        (u) =>
          u.collection === 'stray_leftovers' &&
          u.total === 2 &&
          u.withOrgId === 1,
      ),
    );
  } finally {
    await conn.close();
  }
  console.log(`\n  ${checks - failures}/${checks} checks passed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
