/**
 * The shared frame for real-database end-to-end suites: a scratch database
 * derived from MONGO_URI (refused if it is production), the real Express app on
 * an ephemeral port, and a plain HTTP client. Nothing here is a mock — it only
 * removes the boilerplate each suite would otherwise copy.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { config } from 'dotenv';
import { assertNotProduction, configureDnsForSrv, requireEnv } from './lib';

config();

export interface Res {
  status: number;
  json: any;
  raw: string;
}

export class Checks {
  total = 0;
  failures = 0;

  check(label: string, ok: boolean, detail = ''): boolean {
    this.total++;
    if (ok) console.log(`  ✓ ${label}`);
    else {
      this.failures++;
      console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
    }
    return ok;
  }

  section(title: string): void {
    console.log(`\n${title}`);
  }

  report(): never {
    console.log(`\n  ${this.total - this.failures}/${this.total} checks passed.\n`);
    process.exit(this.failures ? 1 : 0);
  }
}

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

export function deriveScratchUri(productionUri: string, suffix: string): string {
  const m = productionUri.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/);
  if (!m) throw new Error('MONGO_URI could not be parsed.');
  return `${m[1]}${m[2]}_${suffix}${m[3] ?? ''}`;
}

export function request(
  port: number,
  method: string,
  reqPath: string,
  opts: { body?: unknown; headers?: Record<string, string>; token?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        timeout: 60000,
        headers: {
          ...(opts.headers ?? {}),
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed: any = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode ?? 0, json: parsed, raw });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * The scratch database for this run, from the environment.
 *
 *   SCRATCH_DB_NAME        an explicit scratch database name (same cluster and
 *                          credentials as MONGO_URI). Preferred: it does not
 *                          change when MONGO_URI is switched between databases.
 *   --scratch-suffix <s>   otherwise `<MONGO_URI's database>_<s>`, as before.
 *
 * Either way `assertNotProduction` then refuses anything unmarked or protected.
 */
export function scratchUriFor(productionUri: string): string {
  const explicit = (process.env.SCRATCH_DB_NAME || '').trim();
  if (explicit) {
    const m = productionUri.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/);
    if (!m) throw new Error('MONGO_URI could not be parsed.');
    return `${m[1]}${explicit}${m[3] ?? ''}`;
  }
  return deriveScratchUri(productionUri, arg('--scratch-suffix') || 'scratch_app');
}

export interface ScratchApp {
  port: number;
  dbName: string;
  mongoose: typeof import('mongoose');
  close: () => Promise<void>;
}

/**
 * Point the process at the scratch database, register tenancy, connect, and
 * start the real app. Environment is set BEFORE the app is required, exactly as
 * server.ts would see it.
 */
export async function bootScratchApp(extraEnv: Record<string, string> = {}): Promise<ScratchApp> {
  const productionUri = requireEnv('MONGO_URI');
  const uri = scratchUriFor(productionUri);
  assertNotProduction(uri, productionUri);

  configureDnsForSrv();
  Object.assign(process.env, {
    MONGO_URI: uri,
    TENANT_MODE: 'claim',
    TENANT_ENFORCEMENT: 'warn',
    ENABLE_CRON: 'false',
    PPT_WORKER_EMBEDDED: 'false',
    REDIS_ENABLED: 'false',
    AUTH_RATE_LIMIT_MAX: '5000',
    PUBLIC_FORM_RATE_LIMIT_MAX: '5000',
    GUARDIAN_VERIFY_MAX: '5000',
    APP_BUILD_QUEUE_NAME: `app-builds-test-${process.pid}`,
    ...extraEnv,
  });
  process.on('unhandledRejection', () => {
    /* mirrors server.ts tolerance */
  });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registerTenancy } = require('../../src/core/tenancy');
  registerTenancy();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mongoose = require('mongoose');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  // Never create a database by accident. Requiring the app below compiles
  // every model, and Mongoose then creates each model's collection — dozens,
  // on a cluster already at its collection cap. A scratch database that does
  // not exist yet is refused unless that is asked for explicitly.
  const existing = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
  if (existing.length === 0 && process.env.SCRATCH_ALLOW_NEW_DB !== 'true') {
    const name = mongoose.connection.db.databaseName;
    await mongoose.disconnect();
    throw new Error(
      `Scratch database "${name}" does not exist yet, and creating it would add dozens of collections. ` +
        'Point SCRATCH_DB_NAME at an existing scratch database, or set SCRATCH_ALLOW_NEW_DB=true.',
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const app = require('../../src/app').default || require('../../src/app');
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    dbName: mongoose.connection.db.databaseName,
    mongoose,
    close: async () => {
      server.close();
      await mongoose.disconnect();
    },
  };
}
