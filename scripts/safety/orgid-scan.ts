/**
 * Which documents would DISAPPEAR under TENANT_ENFORCEMENT=enforce?
 *
 * Read-only. Counts only — no document contents are read or printed beyond
 * orgId values. It issues listCollections, countDocuments, aggregate ($group /
 * $match only) and find on `orgs` (_id, slug, status) — nothing that writes.
 *
 * Enforce mode reads tenant-scoped collections strictly by `orgId`. A document
 * without one (missing or null), or with an orgId that names no organization,
 * is then invisible to every tenant — that is the risk this measures, per
 * collection, before the switch is flipped.
 *
 * Which collections are tenant-scoped comes from the app itself: every model is
 * compiled after registerTenancy(), and the tenancy registry says which are
 * exempt. A collection no model maps to is listed separately (it may be a
 * dynamic question-bank collection, a leftover, or a migration artefact).
 *
 *   npx ts-node --transpile-only scripts/safety/orgid-scan.ts --target platform [--out report.json]
 *   npx ts-node --transpile-only scripts/safety/orgid-scan.ts --target existing
 *
 *   --target platform   PLATFORM_MONGODB_URI (default)
 *   --target existing   MONGO_URI
 *   --uri-env NAME      any other variable holding the URI
 */

process.env.TENANT_ENFORCEMENT = process.env.TENANT_ENFORCEMENT || 'warn';
process.env.ENABLE_CRON = 'false';
process.env.PPT_WORKER_EMBEDDED = 'false';

import mongoose from 'mongoose';
import { readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from 'dotenv';
import {
  registerTenancy,
  verifyTenantPluginApplied,
} from '../../src/core/tenancy';
import { configureDnsForSrv, redactUri } from './lib';

config();
registerTenancy();

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

export interface CollectionScan {
  collection: string;
  models: string[];
  total: number;
  missingOrgId: number;
  nullOrgId: number;
  orgIdTypes: Record<string, number>;
  /** orgIds present that name no document in `orgs` (by _id or string form). */
  orphanOrgIds: { orgId: string; count: number }[];
  /** Documents per organization, by orgId string. */
  perOrg: Record<string, number>;
}

export interface ScanReport {
  database: string;
  host: string;
  scannedAt: string;
  orgs: { id: string; slug?: string; status?: string }[];
  scoped: CollectionScan[];
  exemptCollections: string[];
  unmappedCollections: {
    collection: string;
    total: number;
    withOrgId: number;
  }[];
  summary: {
    scopedCollections: number;
    documents: number;
    unattributed: number;
    orphaned: number;
  };
}

/** Every model, compiled after tenancy registration, with its collection and scope. */
export function modelInventory(): {
  scoped: Map<string, string[]>;
  exempt: Set<string>;
} {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../../src/app');
  const modelsDir = join(__dirname, '..', '..', 'src', 'models');
  for (const file of readdirSync(modelsDir).filter((f) => f.endsWith('.ts'))) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require(join(modelsDir, file));
    } catch {
      /* a model that cannot load alone is reported by verify-tenant-coverage */
    }
  }
  const { exempt } = verifyTenantPluginApplied();
  const exemptModels = new Set(exempt);
  const scoped = new Map<string, string[]>();
  const exemptCollections = new Set<string>();
  for (const name of mongoose.modelNames()) {
    const collection = mongoose.model(name).collection.collectionName;
    if (exemptModels.has(name)) exemptCollections.add(collection);
    else scoped.set(collection, [...(scoped.get(collection) ?? []), name]);
  }
  // A collection shared by a scoped and an exempt model is scanned as scoped.
  for (const c of scoped.keys()) exemptCollections.delete(c);
  return { scoped, exempt: exemptCollections };
}

export async function scanDatabase(
  db: mongoose.mongo.Db,
  inventory = modelInventory(),
): Promise<ScanReport> {
  const present = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map(
      (c) => c.name,
    ),
  );

  const orgDocs = present.has('orgs')
    ? await db
        .collection('orgs')
        .find({}, { projection: { slug: 1, status: 1 } })
        .toArray()
    : [];
  const orgIds = new Set(orgDocs.map((o) => String(o._id)));

  const scoped: CollectionScan[] = [];
  for (const [collection, models] of [...inventory.scoped.entries()].sort()) {
    if (!present.has(collection)) continue;
    const c = db.collection(collection);
    const total = await c.countDocuments({});
    const missingOrgId = await c.countDocuments({ orgId: { $exists: false } });
    const nullOrgId = await c.countDocuments({
      orgId: null,
      $and: [{ orgId: { $exists: true } }],
    });
    const types = await c
      .aggregate([{ $group: { _id: { $type: '$orgId' }, n: { $sum: 1 } } }])
      .toArray();
    const groups = await c
      .aggregate([
        { $match: { orgId: { $exists: true, $ne: null } } },
        { $group: { _id: { $toString: '$orgId' }, n: { $sum: 1 } } },
      ])
      .toArray();
    const perOrg: Record<string, number> = {};
    const orphanOrgIds: { orgId: string; count: number }[] = [];
    for (const g of groups) {
      perOrg[String(g._id)] = g.n;
      if (!orgIds.has(String(g._id)))
        orphanOrgIds.push({ orgId: String(g._id), count: g.n });
    }
    scoped.push({
      collection,
      models,
      total,
      missingOrgId,
      nullOrgId,
      orgIdTypes: Object.fromEntries(types.map((t) => [String(t._id), t.n])),
      orphanOrgIds,
      perOrg,
    });
  }

  const mapped = new Set([...inventory.scoped.keys(), ...inventory.exempt]);
  const unmappedCollections: ScanReport['unmappedCollections'] = [];
  for (const name of [...present].sort()) {
    if (mapped.has(name) || name.startsWith('system.')) continue;
    const c = db.collection(name);
    unmappedCollections.push({
      collection: name,
      total: await c.countDocuments({}),
      withOrgId: await c.countDocuments({
        orgId: { $exists: true, $ne: null },
      }),
    });
  }

  const sum = (f: (s: CollectionScan) => number) =>
    scoped.reduce((a, s) => a + f(s), 0);
  return {
    database: db.databaseName,
    host: '',
    scannedAt: new Date().toISOString(),
    orgs: orgDocs.map((o) => ({
      id: String(o._id),
      slug: o.slug as string | undefined,
      status: o.status as string | undefined,
    })),
    scoped,
    exemptCollections: [...inventory.exempt]
      .filter((c) => present.has(c))
      .sort(),
    unmappedCollections,
    summary: {
      scopedCollections: scoped.length,
      documents: sum((s) => s.total),
      unattributed: sum((s) => s.missingOrgId + s.nullOrgId),
      orphaned: sum((s) => s.orphanOrgIds.reduce((a, o) => a + o.count, 0)),
    },
  };
}

export function printReport(report: ScanReport): void {
  console.log(
    `\n─── orgId scan: ${report.host}/${report.database} (${report.scannedAt}) ───`,
  );
  console.log(
    `  organizations       ${report.orgs.length}${report.orgs.length ? `  (${report.orgs.map((o) => o.slug || o.id).join(', ')})` : ''}`,
  );
  console.log(
    `  scoped collections  ${report.summary.scopedCollections}, ${report.summary.documents} documents`,
  );
  console.log(
    `  UNATTRIBUTED        ${report.summary.unattributed}  (missing or null orgId — invisible under enforce)`,
  );
  console.log(
    `  ORPHANED            ${report.summary.orphaned}  (orgId names no organization)`,
  );
  const risky = report.scoped.filter(
    (s) => s.missingOrgId || s.nullOrgId || s.orphanOrgIds.length,
  );
  if (risky.length) {
    console.log(
      '\n  collection                         total   missing   null  orphaned  orgId types',
    );
    for (const s of risky) {
      const orphaned = s.orphanOrgIds.reduce((a, o) => a + o.count, 0);
      console.log(
        `  ${s.collection.padEnd(32)} ${String(s.total).padStart(7)} ${String(s.missingOrgId).padStart(9)} ${String(s.nullOrgId).padStart(6)} ${String(orphaned).padStart(9)}  ${JSON.stringify(s.orgIdTypes)}`,
      );
    }
  }
  const mixed = report.scoped.filter(
    (s) =>
      Object.keys(s.orgIdTypes).filter((t) => t !== 'missing' && t !== 'null')
        .length > 1,
  );
  if (mixed.length)
    console.log(
      `\n  ⚠ mixed orgId types (string and ObjectId) in: ${mixed.map((s) => s.collection).join(', ')}`,
    );
  const unmappedWithData = report.unmappedCollections.filter(
    (u) => u.total > 0,
  );
  if (unmappedWithData.length) {
    console.log(
      `\n  unmapped collections with data (no model — not scoped by the app):`,
    );
    for (const u of unmappedWithData)
      console.log(
        `    ${u.collection.padEnd(32)} ${u.total} documents, ${u.withOrgId} with an orgId`,
      );
  }
}

async function main() {
  const target = arg('--target') || 'platform';
  const envName =
    arg('--uri-env') ||
    (target === 'existing' ? 'MONGO_URI' : 'PLATFORM_MONGODB_URI');
  const uri = process.env[envName];
  if (!uri) throw new Error(`${envName} is not set.`);
  configureDnsForSrv();

  const inventory = modelInventory();
  // A separate connection, opened only for reading; the app's default
  // connection is never opened.
  const conn = await mongoose
    .createConnection(uri, {
      serverSelectionTimeoutMS: 15000,
      readPreference: 'secondaryPreferred',
    })
    .asPromise();
  try {
    const report = await scanDatabase(
      conn.db as unknown as mongoose.mongo.Db,
      inventory,
    );
    report.host = redactUri(uri)
      .replace(/^mongodb(\+srv)?:\/\//, '')
      .split('/')[0];
    printReport(report);
    const out = arg('--out');
    if (out) {
      writeFileSync(out, JSON.stringify(report, null, 2));
      console.log(`\n  report written to ${out}`);
    }
  } finally {
    await conn.close();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
