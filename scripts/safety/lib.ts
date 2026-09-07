/**
 * Shared helpers for the P0 production-safety tooling.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 * The MongoDB Database Tools (mongodump/mongorestore) are not installed on this
 * machine and neither is Docker, so the canonical backup path is unavailable.
 * Rather than block P0 on an install, these scripts drive the MongoDB driver
 * that mongoose already bundles. That has one real advantage over mongodump
 * beyond convenience: the verification step can compare the dump against the
 * restored database document-for-document, which mongodump does not do for you.
 *
 * ── The one rule every script here obeys ────────────────────────────────────
 * Production is READ-ONLY to this tooling. `assertNotProduction()` is called
 * before any write, and it fails closed: an unparseable URI is treated as
 * production, not as "probably fine".
 */

import mongoose from 'mongoose';
import dns from 'node:dns';

/**
 * Atlas connection strings are `mongodb+srv://`, which requires a DNS SRV
 * lookup before any connection is attempted. On this network the default
 * resolver refuses that query outright (`querySrv ECONNREFUSED`), so the
 * tooling cannot reach production at all without overriding it.
 *
 * `src/config/db.ts` already solves this for the server with exactly this
 * approach and the same `MONGO_DNS_SERVERS` variable — mirrored here rather
 * than imported, because importing from `src/` would drag mongoose model
 * registration into a script that must stay a plain read-only client.
 */
export function configureDnsForSrv(): void {
  const raw = process.env.MONGO_DNS_SERVERS || '8.8.8.8,1.1.1.1';
  const servers = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!servers.length) return;
  try {
    dns.setServers(servers);
  } catch {
    // Non-fatal: if the platform rejects custom resolvers, the connection
    // attempt below will surface the real problem with a clearer message.
  }
}

// The driver and BSON codec that ship inside mongoose — no extra dependency.
export const mongo = mongoose.mongo;
export const EJSON = (mongoose.mongo as any).BSON.EJSON;

export type MongoClientT = InstanceType<typeof mongoose.mongo.MongoClient>;

/** Collections created by the tooling itself — never part of a baseline. */
export const TOOLING_COLLECTIONS = new Set<string>([]);

/**
 * Strip credentials from a connection string so it can be logged or written
 * into a committed document. Everything before `@` in the authority section is
 * replaced — that is where both the username and password live.
 */
export function redactUri(uri: string): string {
  return uri.replace(/\/\/[^@/]*@/, '//<credentials>@');
}

/** `{ host, db }` for a mongodb:// or mongodb+srv:// URI, or null if unparseable. */
export function describeUri(uri: string): { host: string; db: string } | null {
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)\/([^?]*)/);
  if (!match) return null;
  const host = match[1].toLowerCase();
  const db = decodeURIComponent(match[2] || '').trim();
  if (!db) return null;
  return { host, db };
}

/**
 * Refuse to proceed when `targetUri` could possibly be production.
 *
 * Three independent conditions must ALL hold for a write to be allowed:
 *   1. the target parses at all,
 *   2. its database name is not the production database name on the same host,
 *   3. its database name carries an explicit scratch marker.
 *
 * (3) is the one that matters. Without it a typo that lands on a *different*
 * real database — staging, or a customer's — would pass (1) and (2) happily.
 * Requiring the operator to name the database `..._scratch` or `..._restore_*`
 * makes an accidental destination almost impossible to construct by mistake.
 */
export function assertNotProduction(targetUri: string, productionUri: string): void {
  const target = describeUri(targetUri);
  const prod = describeUri(productionUri);

  if (!target) {
    throw new Error(
      `Refusing to write: target URI could not be parsed, so it cannot be proven safe.\n` +
        `  target: ${redactUri(targetUri)}`,
    );
  }

  if (prod && target.host === prod.host && target.db === prod.db) {
    throw new Error(
      `Refusing to write: target is the production database.\n` +
        `  target: ${target.host}/${target.db}`,
    );
  }

  const isScratch = /(^|[_-])(scratch|restore|rehearsal|verify)([_-]|$)/i.test(target.db);
  if (!isScratch) {
    throw new Error(
      `Refusing to write: target database "${target.db}" is not marked as scratch.\n` +
        `  Name the restore database with one of: _scratch, _restore, _rehearsal, _verify\n` +
        `  e.g. ${prod ? prod.db : 'yourdb'}_restore_${new Date().toISOString().slice(0, 10)}`,
    );
  }
}

/** Connect with a short server-selection timeout so a bad URI fails fast. */
export async function connect(uri: string): Promise<MongoClientT> {
  if (uri.startsWith('mongodb+srv://')) configureDnsForSrv();
  const client = new mongo.MongoClient(uri, {
    serverSelectionTimeoutMS: 15_000,
    // This tooling is not latency-sensitive; a small pool keeps its footprint
    // off a production cluster that is simultaneously serving the live app.
    maxPoolSize: 4,
  });
  await client.connect();
  return client;
}

/** Database name from a URI, for use with `client.db()`. */
export function dbNameOf(uri: string): string {
  const d = describeUri(uri);
  if (!d) throw new Error(`Cannot determine database name from URI: ${redactUri(uri)}`);
  return d.db;
}

export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}
