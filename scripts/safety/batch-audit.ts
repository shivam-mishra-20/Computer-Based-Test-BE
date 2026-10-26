/**
 * Batch ownership audit — READ-ONLY.
 *
 * Answers, for one database, without changing anything in it:
 *   1. which batches exist and which organization owns each;
 *   2. the unique indexes on `batches` (the legacy global `name_1`, the
 *      organization-scoped `orgId_1_name_1`);
 *   3. duplicate batch names within an organization, and anything that would
 *      stop an organization-scoped unique index from building;
 *   4. CLUES of the historical Advanced+Basic merge — "Advanced/Basic" batches,
 *      students and schedules referencing those names, references to batches
 *      that no longer exist — and configuration replacements in the audit logs.
 *
 * Clues are not proof. A batch named "Advanced/Basic" may simply have been
 * created with that name; a student whose batch names no Batch document may
 * predate the Batch collection. The report says what the data shows, never
 * what happened.
 *
 * ── Why it cannot write ──────────────────────────────────────────────────────
 * It uses the MongoDB driver directly (no application models are loaded, so
 * nothing can auto-create a collection or an index), and every database and
 * collection handle is wrapped: only listCollections, find, aggregate,
 * countDocuments, distinct and indexes are callable, aggregate pipelines may
 * not contain $out or $merge, and anything else throws ReadOnlyViolation before
 * a request is sent. Every query carries maxTimeMS; reads prefer a secondary.
 * It reads counts, batch names, organization ids/slugs/names and audit
 * action names and dates — no person's name, email or phone.
 *
 *   npx ts-node --transpile-only scripts/safety/batch-audit.ts \
 *     --target platform --out backups/audits/batch-audit-platform-<date>.json
 *
 *   --target platform   PLATFORM_MONGODB_URI (default)
 *   --target existing   MONGO_URI
 *   --uri-env NAME      the URI from another variable (fixtures, tests)
 *   --max-time-ms N     per-query time limit (default 20000)
 */

import { config } from 'dotenv';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import mongoose from 'mongoose';

type Doc = Record<string, unknown>;
type MongoDb = mongoose.mongo.Db;
type MongoCollection = mongoose.mongo.Collection;

export class ReadOnlyViolation extends Error {
  constructor(what: string) {
    super(`Refused by the read-only guard: ${what}`);
    this.name = 'ReadOnlyViolation';
  }
}

const COLLECTION_READS = new Set([
  'find',
  'aggregate',
  'countDocuments',
  'distinct',
  'indexes',
]);
const FORBIDDEN_STAGES = new Set(['$out', '$merge']);

function assertReadPipeline(pipeline: unknown): void {
  if (!Array.isArray(pipeline))
    throw new ReadOnlyViolation('aggregate without a pipeline array');
  for (const stage of pipeline) {
    for (const key of Object.keys((stage ?? {}) as object)) {
      if (FORBIDDEN_STAGES.has(key))
        throw new ReadOnlyViolation(`aggregate stage ${key}`);
    }
  }
}

/** A collection handle on which only reads can be called. */
export function readOnlyCollection(
  col: MongoCollection,
  maxTimeMS: number,
): MongoCollection {
  return new Proxy(col, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      if (!COLLECTION_READS.has(prop)) {
        return () => {
          throw new ReadOnlyViolation(`${target.collectionName}.${prop}()`);
        };
      }
      if (prop === 'aggregate') {
        return (pipeline: unknown, options: Doc = {}) => {
          assertReadPipeline(pipeline);
          return target.aggregate(pipeline as Doc[], { ...options, maxTimeMS });
        };
      }
      if (prop === 'find') {
        return (filter: Doc = {}, options: Doc = {}) =>
          target.find(filter, { ...options, maxTimeMS });
      }
      if (prop === 'countDocuments') {
        return (filter: Doc = {}, options: Doc = {}) =>
          target.countDocuments(filter, { ...options, maxTimeMS });
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

/** A database handle that hands out read-only collections and nothing else. */
export function readOnlyDb(db: MongoDb, maxTimeMS: number): MongoDb {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'collection') {
        return (name: string) =>
          readOnlyCollection(target.collection(name), maxTimeMS);
      }
      if (prop === 'listCollections') {
        return (filter: Doc = {}, options: Doc = {}) =>
          target.listCollections(filter, { ...options, nameOnly: true });
      }
      if (prop === 'databaseName') return target.databaseName;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return () => {
          throw new ReadOnlyViolation(`db.${String(prop)}()`);
        };
      }
      return value;
    },
  });
}

const MERGE_SOURCES = ['advanced', 'basic'];
const MERGE_TARGET = 'advanced/basic';
// Compared after normalizeBatch, which strips all whitespace.
const PLACEHOLDER_BATCHES = new Set(['', 'allbatches']);
/** The merge's own normalization: lower-case, all whitespace removed. */
export const normalizeBatch = (value: unknown) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
const orgKeyExpr = {
  $convert: {
    input: '$orgId',
    to: 'string',
    onError: 'UNREADABLE',
    onNull: 'MISSING',
  },
};

export interface BatchAuditReport {
  meta: {
    database: string;
    host: string;
    target: string;
    scannedAt: string;
    readOnly: string;
    maxTimeMS: number;
    queries: string[];
  };
  collections: Record<string, boolean>;
  indexes: {
    all: Array<{
      name: string;
      key: Doc;
      unique: boolean;
      sparse?: boolean;
      partialFilterExpression?: Doc;
    }>;
    legacyGlobalNameUnique: boolean;
    orgScopedNameUnique: boolean;
  };
  organizations: Array<{
    id: string;
    slug?: string;
    name?: string;
    status?: string;
    createdAt?: string;
  }>;
  batches: {
    total: number;
    orgIdTypes: Record<string, number>;
    byOrg: Record<
      string,
      {
        count: number;
        names: string[];
        firstCreatedAt?: string;
        lastUpdatedAt?: string;
      }
    >;
  };
  duplicates: {
    exactWithinOrg: Array<{ org: string; name: string; count: number }>;
    caseOrSpaceVariantsWithinOrg: Array<{ org: string; names: string[] }>;
    unattributedSameName: Array<{ name: string; count: number }>;
    namesSharedAcrossOrgs: Array<{ name: string; orgs: number }>;
  };
  mergeClues: {
    advancedBasicBatches: Array<{
      org: string;
      name: string;
      classLevels: unknown;
      isDefault: unknown;
      createdAt?: string;
      updatedAt?: string;
    }>;
    perOrg: Record<
      string,
      {
        batchesNamed: {
          advanced: number;
          basic: number;
          advancedBasic: number;
        };
        usersWithBatch: {
          advanced: number;
          basic: number;
          advancedBasic: number;
        };
        schedulesWithBatch: {
          advanced: number;
          basic: number;
          advancedBasic: number;
        };
      }
    >;
  };
  danglingReferences: {
    usersByOrg: Record<string, Array<{ batch: string; users: number }>>;
    schedulesByOrg: Record<string, Array<{ batch: string; schedules: number }>>;
    classRequests: {
      withBatchId: number;
      batchIdMissing: number;
      batchIdInOtherOrg: number;
    };
  };
  configurationHistory: {
    platformAudit: Array<{
      action: string;
      org: string;
      at?: string;
      batchesApplied?: unknown;
    }>;
    orgAdminAudit: Array<{
      action: string;
      org: string;
      at?: string;
      batchesApplied?: unknown;
    }>;
  };
  canEstablish: string[];
  cannotEstablish: string[];
}

const iso = (v: unknown) =>
  v instanceof Date ? v.toISOString() : v ? String(v) : undefined;

export async function auditBatches(
  rawDb: MongoDb,
  options: { target: string; host: string; maxTimeMS?: number },
): Promise<BatchAuditReport> {
  const maxTimeMS = options.maxTimeMS ?? 20000;
  const db = readOnlyDb(rawDb, maxTimeMS);
  const queries: string[] = [];
  const q = <T>(label: string, run: () => Promise<T>) => {
    queries.push(label);
    return run();
  };

  const present = new Set(
    (
      await q('listCollections (names only)', () =>
        db.listCollections({}, { nameOnly: true }).toArray(),
      )
    ).map((c) => String(c.name)),
  );
  const has = (name: string) => present.has(name);
  const collections = Object.fromEntries(
    [
      'orgs',
      'batches',
      'users',
      'schedules',
      'classrequests',
      'platformaudits',
      'auditlogs',
    ].map((n) => [n, has(n)]),
  );

  // ── Indexes ────────────────────────────────────────────────────────────────
  const rawIndexes = has('batches')
    ? await q('batches.indexes()', () => db.collection('batches').indexes())
    : [];
  const indexes = rawIndexes.map((i) => ({
    name: String(i.name),
    key: i.key as Doc,
    unique: Boolean(i.unique),
    ...(i.sparse ? { sparse: true } : {}),
    ...(i.partialFilterExpression
      ? { partialFilterExpression: i.partialFilterExpression as Doc }
      : {}),
  }));
  const keyIs = (key: Doc, fields: string[]) => {
    const k = Object.keys(key);
    return k.length === fields.length && fields.every((f, n) => k[n] === f);
  };

  // ── Organizations ─────────────────────────────────────────────────────────
  const orgDocs = has('orgs')
    ? await q('orgs.find({}, projection: _id slug name status createdAt)', () =>
        db
          .collection('orgs')
          .find(
            {},
            { projection: { slug: 1, name: 1, status: 1, createdAt: 1 } },
          )
          .toArray(),
      )
    : [];
  const organizations = orgDocs.map((o) => ({
    id: String(o._id),
    slug: o.slug as string | undefined,
    name: o.name as string | undefined,
    status: o.status as string | undefined,
    createdAt: iso(o.createdAt),
  }));
  const orgIds = new Set(organizations.map((o) => o.id));

  // ── Batches ───────────────────────────────────────────────────────────────
  const batchDocs = has('batches')
    ? await q(
        'batches.find({}, projection: name orgId classLevels isDefault createdAt updatedAt)',
        () =>
          db
            .collection('batches')
            .find(
              {},
              {
                projection: {
                  name: 1,
                  orgId: 1,
                  classLevels: 1,
                  isDefault: 1,
                  createdAt: 1,
                  updatedAt: 1,
                },
              },
            )
            .toArray(),
      )
    : [];
  const orgKey = (v: unknown) =>
    v === undefined || v === null ? 'MISSING' : String(v);
  const orgIdTypes: Record<string, number> = {};
  const byOrg: BatchAuditReport['batches']['byOrg'] = {};
  for (const b of batchDocs) {
    const t =
      b.orgId === undefined || b.orgId === null
        ? 'missing'
        : b.orgId instanceof mongoose.mongo.ObjectId
          ? 'objectId'
          : typeof b.orgId;
    orgIdTypes[t] = (orgIdTypes[t] ?? 0) + 1;
    const key = orgKey(b.orgId);
    const entry = (byOrg[key] ??= { count: 0, names: [] });
    entry.count++;
    entry.names.push(String(b.name));
    const created = iso(b.createdAt);
    const updated = iso(b.updatedAt);
    if (created && (!entry.firstCreatedAt || created < entry.firstCreatedAt))
      entry.firstCreatedAt = created;
    if (updated && (!entry.lastUpdatedAt || updated > entry.lastUpdatedAt))
      entry.lastUpdatedAt = updated;
  }
  for (const e of Object.values(byOrg))
    e.names.sort((a, b) => a.localeCompare(b));

  // ── Duplicates ────────────────────────────────────────────────────────────
  const exact = new Map<string, number>();
  const normalized = new Map<string, Set<string>>();
  const normalizedCount = new Map<string, number>();
  const orgsPerName = new Map<string, Set<string>>();
  for (const b of batchDocs) {
    const org = orgKey(b.orgId);
    const name = String(b.name);
    exact.set(
      `${org}\u0000${name}`,
      (exact.get(`${org}\u0000${name}`) ?? 0) + 1,
    );
    const nk = `${org}\u0000${normalizeBatch(name)}`;
    (normalized.get(nk) ?? normalized.set(nk, new Set()).get(nk)!).add(name);
    normalizedCount.set(nk, (normalizedCount.get(nk) ?? 0) + 1);
    if (org !== 'MISSING')
      (
        orgsPerName.get(name) ?? orgsPerName.set(name, new Set()).get(name)!
      ).add(org);
  }
  const split = (k: string) => k.split('\u0000') as [string, string];
  const duplicates: BatchAuditReport['duplicates'] = {
    exactWithinOrg: [...exact]
      .filter(([k, n]) => n > 1 && split(k)[0] !== 'MISSING')
      .map(([k, n]) => ({ org: split(k)[0], name: split(k)[1], count: n })),
    caseOrSpaceVariantsWithinOrg: [...normalized]
      .filter(([k, names]) => names.size > 1 && split(k)[0] !== 'MISSING')
      .map(([k, names]) => ({ org: split(k)[0], names: [...names].sort() })),
    unattributedSameName: [...exact]
      .filter(([k, n]) => n > 1 && split(k)[0] === 'MISSING')
      .map(([k, n]) => ({ name: split(k)[1], count: n })),
    namesSharedAcrossOrgs: [...orgsPerName]
      .filter(([, orgs]) => orgs.size > 1)
      .map(([name, orgs]) => ({ name, orgs: orgs.size }))
      .sort((a, b) => b.orgs - a.orgs),
  };

  // ── Merge clues ───────────────────────────────────────────────────────────
  const advancedBasicBatches = batchDocs
    .filter((b) => normalizeBatch(b.name) === MERGE_TARGET)
    .map((b) => ({
      org: orgKey(b.orgId),
      name: String(b.name),
      classLevels: b.classLevels,
      isDefault: b.isDefault,
      createdAt: iso(b.createdAt),
      updatedAt: iso(b.updatedAt),
    }));
  const zero = () => ({ advanced: 0, basic: 0, advancedBasic: 0 });
  const perOrg: BatchAuditReport['mergeClues']['perOrg'] = {};
  const slot = (org: string) =>
    (perOrg[org] ??= {
      batchesNamed: zero(),
      usersWithBatch: zero(),
      schedulesWithBatch: zero(),
    });
  const bump = (
    target: { advanced: number; basic: number; advancedBasic: number },
    name: unknown,
    n = 1,
  ) => {
    const k = normalizeBatch(name);
    if (k === MERGE_SOURCES[0]) target.advanced += n;
    else if (k === MERGE_SOURCES[1]) target.basic += n;
    else if (k === MERGE_TARGET) target.advancedBasic += n;
  };
  for (const b of batchDocs) bump(slot(orgKey(b.orgId)).batchesNamed, b.name);

  const referenceCounts = async (collection: string) =>
    has(collection)
      ? q(
          `${collection}.aggregate([$match batch is a non-empty string, $group {org, batch} count])`,
          () =>
            db
              .collection(collection)
              .aggregate([
                { $match: { batch: { $type: 'string', $ne: '' } } },
                {
                  $group: {
                    _id: { org: orgKeyExpr, batch: '$batch' },
                    n: { $sum: 1 },
                  },
                },
              ])
              .toArray(),
        )
      : Promise.resolve([] as Doc[]);
  const userRefs = await referenceCounts('users');
  const scheduleRefs = await referenceCounts('schedules');
  for (const r of userRefs)
    bump(
      slot(String((r._id as Doc).org)).usersWithBatch,
      (r._id as Doc).batch,
      Number(r.n),
    );
  for (const r of scheduleRefs)
    bump(
      slot(String((r._id as Doc).org)).schedulesWithBatch,
      (r._id as Doc).batch,
      Number(r.n),
    );
  for (const [org, s] of Object.entries(perOrg)) {
    const empty = [
      s.batchesNamed,
      s.usersWithBatch,
      s.schedulesWithBatch,
    ].every((x) => !x.advanced && !x.basic && !x.advancedBasic);
    if (empty) delete perOrg[org];
  }

  // ── Dangling references ───────────────────────────────────────────────────
  const namesByOrg = new Map<string, Set<string>>();
  for (const b of batchDocs) {
    const org = orgKey(b.orgId);
    (namesByOrg.get(org) ?? namesByOrg.set(org, new Set()).get(org)!).add(
      normalizeBatch(b.name),
    );
  }
  const dangling = (refs: Doc[], unit: 'users' | 'schedules') => {
    const out: Record<string, Array<Record<string, unknown>>> = {};
    for (const r of refs) {
      const id = r._id as Doc;
      const org = String(id.org);
      const batch = String(id.batch);
      if (PLACEHOLDER_BATCHES.has(normalizeBatch(batch))) continue;
      if (namesByOrg.get(org)?.has(normalizeBatch(batch))) continue;
      (out[org] ??= []).push({ batch, [unit]: Number(r.n) });
    }
    for (const list of Object.values(out))
      list.sort((a, b) => Number(b[unit]) - Number(a[unit]));
    return out;
  };
  const batchOrgById = new Map(
    batchDocs.map((b) => [String(b._id), orgKey(b.orgId)]),
  );
  const crRefs = has('classrequests')
    ? await q(
        'classrequests.find({ batchId exists }, projection: batchId orgId)',
        () =>
          db
            .collection('classrequests')
            .find(
              { batchId: { $exists: true, $ne: null } },
              { projection: { batchId: 1, orgId: 1 } },
            )
            .toArray(),
      )
    : [];
  let batchIdMissing = 0;
  let batchIdInOtherOrg = 0;
  for (const cr of crRefs) {
    const owner = batchOrgById.get(String(cr.batchId));
    if (owner === undefined) batchIdMissing++;
    else if (owner !== orgKey(cr.orgId)) batchIdInOtherOrg++;
  }

  // ── Configuration history (audit logs) ────────────────────────────────────
  const history = async (collection: string, orgField: string) =>
    has(collection)
      ? (
          await q(
            `${collection}.find({ action matches /config|onboard/ }, projection: action ${orgField} createdAt metadata.batches)`,
            () =>
              db
                .collection(collection)
                .find(
                  { action: { $regex: 'config|onboard', $options: 'i' } },
                  {
                    projection: {
                      action: 1,
                      [orgField]: 1,
                      createdAt: 1,
                      'metadata.batches': 1,
                    },
                    sort: { createdAt: 1 },
                  },
                )
                .toArray(),
          )
        ).map((a) => ({
          action: String(a.action),
          org: orgKey(a[orgField]),
          at: iso(a.createdAt),
          ...((a.metadata as Doc | undefined)?.batches !== undefined
            ? { batchesApplied: (a.metadata as Doc).batches }
            : {}),
        }))
      : [];

  return {
    meta: {
      database: rawDb.databaseName,
      host: options.host,
      target: options.target,
      scannedAt: new Date().toISOString(),
      readOnly:
        'driver-level guard: listCollections, find, aggregate (no $out/$merge), countDocuments, distinct, indexes only',
      maxTimeMS,
      queries,
    },
    collections,
    indexes: {
      all: indexes,
      legacyGlobalNameUnique: indexes.some(
        (i) => i.unique && keyIs(i.key, ['name']),
      ),
      orgScopedNameUnique: indexes.some(
        (i) => i.unique && keyIs(i.key, ['orgId', 'name']),
      ),
    },
    organizations,
    batches: { total: batchDocs.length, orgIdTypes, byOrg },
    duplicates,
    mergeClues: { advancedBasicBatches, perOrg },
    danglingReferences: {
      usersByOrg: dangling(
        userRefs,
        'users',
      ) as BatchAuditReport['danglingReferences']['usersByOrg'],
      schedulesByOrg: dangling(
        scheduleRefs,
        'schedules',
      ) as BatchAuditReport['danglingReferences']['schedulesByOrg'],
      classRequests: {
        withBatchId: crRefs.length,
        batchIdMissing,
        batchIdInOtherOrg,
      },
    },
    configurationHistory: {
      platformAudit: await history('platformaudits', 'orgId'),
      orgAdminAudit: await history('auditlogs', 'entityId'),
    },
    canEstablish: [
      'Which batch documents exist now, and the organization each names (or that it names none).',
      'Which unique indexes exist on batches, and whether an organization-scoped unique index could be built today.',
      'Duplicate names within an organization, exact and by case or spacing.',
      'Which organizations currently have batches named Advanced, Basic or Advanced/Basic, and how many students and schedules reference each name.',
      'Student and schedule batch names that match no current batch of their organization, and class requests pointing at a batch that no longer exists.',
      'Configuration replacements and onboardings recorded in the audit logs, with dates.',
    ],
    cannotEstablish: [
      'Whether any batch was renamed or deleted: the merge wrote no audit entry, and a deleted document leaves no trace in current data.',
      'Whether an "Advanced/Basic" batch came from the merge or was created with that name.',
      'Whether a student or schedule batch name that matches no batch was renamed by the merge, typed by hand, or predates the Batch collection.',
      'What existed before any point in time — only a backup or the oplog (not read) could show that.',
    ],
  };
}

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

function hostOf(uri: string): string {
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/);
  return m?.[1] ?? 'unknown';
}

export function printAudit(r: BatchAuditReport): void {
  console.log(
    `\n─── batch audit: ${r.meta.host}/${r.meta.database} (${r.meta.scannedAt}) — READ-ONLY ───`,
  );
  console.log(
    `  organizations ${r.organizations.length} · batches ${r.batches.total} · orgId types ${JSON.stringify(r.batches.orgIdTypes)}`,
  );
  console.log(
    `  indexes on batches: ${r.indexes.all.map((i) => `${i.name}${i.unique ? ' (unique)' : ''}`).join(', ') || 'none'}`,
  );
  console.log(
    `    legacy global unique name_1: ${r.indexes.legacyGlobalNameUnique ? 'PRESENT' : 'absent'} · organization-scoped unique: ${r.indexes.orgScopedNameUnique ? 'present' : 'ABSENT'}`,
  );
  console.log(
    `  duplicates: within-org exact ${r.duplicates.exactWithinOrg.length}, within-org case/space ${r.duplicates.caseOrSpaceVariantsWithinOrg.length}, unattributed same-name ${r.duplicates.unattributedSameName.length}, names shared across orgs ${r.duplicates.namesSharedAcrossOrgs.length}`,
  );
  console.log(
    `  "Advanced/Basic" batches: ${r.mergeClues.advancedBasicBatches.length} · organizations with Advanced/Basic/Advanced-Basic clues: ${Object.keys(r.mergeClues.perOrg).length}`,
  );
  console.log(
    `  dangling: student batch names in ${Object.keys(r.danglingReferences.usersByOrg).length} org(s), schedule batch names in ${Object.keys(r.danglingReferences.schedulesByOrg).length} org(s), class requests to missing batch ${r.danglingReferences.classRequests.batchIdMissing}, to another org's batch ${r.danglingReferences.classRequests.batchIdInOtherOrg}`,
  );
  console.log(
    `  configuration events in audit logs: platform ${r.configurationHistory.platformAudit.length}, organization admin ${r.configurationHistory.orgAdminAudit.length}`,
  );
  console.log(`  ${r.meta.queries.length} read queries issued.`);
}

async function main() {
  config();
  const target = arg('--target') || 'platform';
  const envName =
    arg('--uri-env') ||
    (target === 'existing' ? 'MONGO_URI' : 'PLATFORM_MONGODB_URI');
  const uri = process.env[envName];
  if (!uri) throw new Error(`${envName} is not set.`);
  const out = arg('--out');
  if (!out)
    throw new Error(
      '--out <file> is required (write it under backups/, which git ignores).',
    );
  const maxTimeMS = Number(arg('--max-time-ms') || 20000);

  const client = await mongoose.mongo.MongoClient.connect(uri, {
    readPreference: 'secondaryPreferred',
    retryWrites: false,
    serverSelectionTimeoutMS: 15000,
    appName: 'batch-audit-readonly',
  });
  try {
    const report = await auditBatches(client.db(), {
      target,
      host: hostOf(uri),
      maxTimeMS,
    });
    printAudit(report);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`  report written to ${out}`);
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
