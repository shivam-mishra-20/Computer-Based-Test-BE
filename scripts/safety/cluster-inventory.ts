/**
 * Read-only inventory of the WHOLE cluster: every database, every collection,
 * its document count, data size and index count — as Markdown tables.
 *
 * Why it exists: Atlas caps the cluster at 500 collections across ALL
 * databases, and the question "what is using them?" needs every database at
 * once. `db-inventory.ts` covers one database (MONGO_URI's) in more depth.
 *
 * Writes nothing, anywhere. It uses the MongoDB driver directly — no Mongoose
 * models, so nothing can be auto-created or auto-indexed — and issues only read
 * commands: listDatabases, listCollections, count (from collection metadata),
 * collStats and listIndexes.
 *
 * With `--admins` it also lists each database's ADMINISTRATOR accounts (and
 * platform staff where a `platformusers` collection exists) — through an
 * explicit projection of name, email, role, status, organization and creation
 * date. Password hashes, tokens and reset codes are never read. Without it, no
 * document contents are read at all.
 *
 * The cluster is reached with MONGO_URI from the environment; nothing here
 * names a host or a database.
 *
 *   npx ts-node --transpile-only scripts/safety/cluster-inventory.ts
 *   npx ts-node --transpile-only scripts/safety/cluster-inventory.ts --out <file.md>
 */

import { writeFileSync } from 'fs';
import { config } from 'dotenv';
import {
  connect,
  humanBytes,
  mongo,
  redactUri,
  requireEnv,
  type MongoClientT,
} from './lib';

config({ quiet: true } as never);

const SYSTEM_DATABASES = new Set(['admin', 'local', 'config']);
const CONCURRENCY = 8;
const ADMIN_ROWS_PER_DATABASE = 100;
/** The only user fields ever read. Anything else — the password hash above all — is not. */
const SAFE_USER_FIELDS = {
  name: 1,
  email: 1,
  role: 1,
  status: 1,
  orgId: 1,
  createdAt: 1,
} as const;

type Db = ReturnType<MongoClientT['db']>;

// A pipe inside a value would split the Markdown cell.
const cell = (value: unknown) => String(value ?? '—').replace(/\|/g, '\\|');
const day = (value: unknown) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : '—';

/** A database's administrators (and platform staff), as a Markdown table. */
async function adminTable(db: Db, collections: string[]): Promise<string[]> {
  const out: string[] = [];
  if (collections.includes('users')) {
    const users = db.collection('users');
    const filter = { role: 'admin' };
    const total = await users.countDocuments(filter);
    const rows = (await users
      .find(filter, { projection: SAFE_USER_FIELDS })
      .sort({ createdAt: 1 })
      .limit(ADMIN_ROWS_PER_DATABASE)
      .toArray()) as Record<string, unknown>[];
    // Organization names, where this database has organizations.
    const orgNames = new Map<string, string>();
    const orgIds = [
      ...new Set(
        rows
          .map((r) => r.orgId)
          .filter(Boolean)
          .map(String),
      ),
    ];
    if (orgIds.length && collections.includes('orgs')) {
      const { ObjectId } = mongo;
      const ids = orgIds
        .filter((id) => ObjectId.isValid(id))
        .map((id) => new ObjectId(id));
      const orgs = (await db
        .collection('orgs')
        .find({ _id: { $in: ids } }, { projection: { name: 1 } })
        .toArray()) as { _id: unknown; name?: string }[];
      for (const org of orgs) orgNames.set(String(org._id), org.name ?? '');
    }
    out.push(`**Administrators (users with role "admin"): ${total}**${total > rows.length ? ` — first ${rows.length} shown` : ''}
`);
    if (rows.length) {
      out.push('| # | Name | Email | Status | Organization | Created |');
      out.push('|---:|---|---|---|---|---|');
      rows.forEach((r, i) => {
        const org = r.orgId
          ? `${orgNames.get(String(r.orgId)) || 'unknown'} (${String(r.orgId).slice(-6)})`
          : 'none (legacy)';
        out.push(
          `| ${i + 1} | ${cell(r.name)} | ${cell(r.email)} | ${cell(r.status)} | ${cell(org)} | ${day(r.createdAt)} |`,
        );
      });
    }
    out.push('');
  }
  if (collections.includes('platformusers')) {
    const staff = (await db
      .collection('platformusers')
      .find(
        {},
        {
          projection: { name: 1, email: 1, role: 1, isActive: 1, createdAt: 1 },
        },
      )
      .sort({ createdAt: 1 })
      .limit(ADMIN_ROWS_PER_DATABASE)
      .toArray()) as Record<string, unknown>[];
    out.push(`**Platform staff (platformusers): ${staff.length}**
`);
    if (staff.length) {
      out.push('| # | Name | Email | Role | Active | Created |');
      out.push('|---:|---|---|---|---|---|');
      staff.forEach((r, i) => {
        out.push(
          `| ${i + 1} | ${cell(r.name)} | ${cell(r.email)} | ${cell(r.role)} | ${r.isActive === false ? 'no' : 'yes'} | ${day(r.createdAt)} |`,
        );
      });
    }
    out.push('');
  }
  return out;
}

interface Row {
  name: string;
  type: string;
  documents: number | null;
  bytes: number | null;
  indexes: number | null;
}

async function inBatches<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

const fmt = (n: number | null) =>
  n === null ? '—' : n.toLocaleString('en-IN');

async function main() {
  const uri = requireEnv('MONGO_URI');
  const outIndex = process.argv.indexOf('--out');
  const outPath = outIndex > -1 ? process.argv[outIndex + 1] : null;
  const withAdmins = process.argv.includes('--admins');
  console.error(`[cluster-inventory] read-only: ${redactUri(uri)}`);

  const client = await connect(uri);
  const lines: string[] = [];
  try {
    const { databases } = (await client
      .db()
      .admin()
      .listDatabases({ nameOnly: true })) as {
      databases: { name: string }[];
    };
    const names = databases
      .map((d) => d.name)
      .filter((n) => !SYSTEM_DATABASES.has(n))
      .sort();

    const summary: {
      db: string;
      collections: number;
      documents: number;
      bytes: number;
    }[] = [];
    const sections: string[] = [];

    for (const dbName of names) {
      const db = client.db(dbName);
      const infos = (await db
        .listCollections({}, { nameOnly: false })
        .toArray()) as { name: string; type?: string }[];
      const rows = await inBatches(
        infos.sort((a, b) => a.name.localeCompare(b.name)),
        CONCURRENCY,
        async (info): Promise<Row> => {
          const type = info.type ?? 'collection';
          if (type !== 'collection')
            return {
              name: info.name,
              type,
              documents: null,
              bytes: null,
              indexes: null,
            };
          const collection = db.collection(info.name);
          let documents: number | null = null;
          let bytes: number | null = null;
          let indexes: number | null = null;
          try {
            documents = await collection.estimatedDocumentCount();
          } catch {
            documents = null;
          }
          try {
            const stats = (await db.command({ collStats: info.name })) as {
              size?: number;
              nindexes?: number;
            };
            bytes = stats.size ?? null;
            indexes = stats.nindexes ?? null;
          } catch {
            // collStats is refused on some shared tiers; sizes stay unknown.
          }
          if (indexes === null) {
            try {
              indexes = (await collection.indexes()).length;
            } catch {
              indexes = null;
            }
          }
          return { name: info.name, type, documents, bytes, indexes };
        },
      );

      const docs = rows.reduce((n, r) => n + (r.documents ?? 0), 0);
      const bytes = rows.reduce((n, r) => n + (r.bytes ?? 0), 0);
      summary.push({
        db: dbName,
        collections: rows.length,
        documents: docs,
        bytes,
      });

      sections.push(
        `### ${dbName} — ${rows.length} collection${rows.length === 1 ? '' : 's'}\n`,
      );
      sections.push('| # | Collection | Documents | Data size | Indexes |');
      sections.push('|---:|---|---:|---:|---:|');
      rows.forEach((r, i) => {
        const label =
          r.type === 'collection' ? r.name : `${r.name} (${r.type})`;
        sections.push(
          `| ${i + 1} | ${label} | ${fmt(r.documents)} | ${r.bytes === null ? '—' : humanBytes(r.bytes)} | ${fmt(r.indexes)} |`,
        );
      });
      sections.push('');
      if (withAdmins)
        sections.push(
          ...(await adminTable(
            db,
            rows.map((r) => r.name),
          )),
        );
    }

    const totalCollections = summary.reduce((n, s) => n + s.collections, 0);
    lines.push(
      `## Cluster summary — ${totalCollections} collections (Atlas limit: 500)\n`,
    );
    lines.push('| Database | Collections | Documents | Data size |');
    lines.push('|---|---:|---:|---:|');
    for (const s of summary)
      lines.push(
        `| ${s.db} | ${s.collections} | ${fmt(s.documents)} | ${humanBytes(s.bytes)} |`,
      );
    lines.push(
      `| **Total** | **${totalCollections}** | **${fmt(summary.reduce((n, s) => n + s.documents, 0))}** | **${humanBytes(summary.reduce((n, s) => n + s.bytes, 0))}** |`,
    );
    lines.push('');
    lines.push(...sections);
  } finally {
    await client.close();
  }

  const markdown = lines.join('\n');
  if (outPath) {
    writeFileSync(outPath, markdown);
    console.error(`[cluster-inventory] written to ${outPath}`);
  } else {
    console.log(markdown);
  }
}

main().catch((e) => {
  console.error('[cluster-inventory] failed:', (e as Error).message);
  process.exit(1);
});
