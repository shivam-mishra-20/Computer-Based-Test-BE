import mongoose from 'mongoose';
import dotenv from 'dotenv';
import dns from 'node:dns';
import User from '../models/User';
import { withoutTenantScope } from '../core/tenancy/context';
import { isLegacyDatabase } from '../core/tenancy/dataSource';

dotenv.config();

function isSrvDnsRefused(error: unknown): boolean {
  const err = error as { code?: string; syscall?: string; message?: string };
  const message = String(err?.message || '');
  return (
    err?.code === 'ECONNREFUSED' &&
    (err?.syscall === 'querySrv' || message.includes('querySrv'))
  );
}

function configureMongoDnsServers(): void {
  const raw = process.env.MONGO_DNS_SERVERS || '8.8.8.8,1.1.1.1';
  const servers = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (servers.length === 0) return;

  try {
    dns.setServers(servers);
    console.log(`🧭 Mongo DNS servers set: ${servers.join(', ')}`);
  } catch (dnsError) {
    console.warn('⚠️ Failed to set custom DNS servers for MongoDB SRV lookup:', dnsError);
  }
}

export const connectDB = async (): Promise<void> => {
  try {
    if (mongoose.connection.readyState === 1) {
      return;
    }

    const uri = process.env.MONGO_URI;
    if (!uri) {
      throw new Error('MONGO_URI is not defined in environment variables');
    }

    if (uri.startsWith('mongodb+srv://')) {
      configureMongoDnsServers();
    }

    // The legacy database is never created in or indexed from here — see
    // core/tenancy/dataSource.ts. (Also set globally at boot; stated again at
    // the connection so no call path can miss it.)
    const legacy = isLegacyDatabase(uri);
    const options = legacy ? { autoCreate: false, autoIndex: false } : {};

    try {
      await mongoose.connect(uri, options);
    } catch (primaryError) {
      if (isSrvDnsRefused(primaryError) && uri.startsWith('mongodb+srv://')) {
        const directUri = process.env.MONGO_URI_DIRECT;
        if (!directUri) {
          throw new Error(
            'MongoDB SRV DNS lookup failed (querySrv ECONNREFUSED). ' +
            'Set MONGO_URI_DIRECT in .env to a non-SRV mongodb:// URI, or set MONGO_DNS_SERVERS.'
          );
        }

        console.warn('⚠️ MongoDB SRV lookup failed. Retrying with MONGO_URI_DIRECT...');
        await mongoose.connect(directUri, options);
      } else {
        throw primaryError;
      }
    }

    console.log('✅ MongoDB Connected');

    /*
     * Seed the bootstrap administrator.
     *
     * ── Why this is explicitly unscoped ───────────────────────────────────
     * `User` is a tenant-scoped model, and this runs at boot — before any
     * request, so there is no organization to scope to and never could be.
     * That is what produced `[tenancy:warn] unscoped User.findOne` on every
     * start: not a stray query someone forgot to scope, but a genuine
     * system-level one with no context available to it.
     *
     * It is declared through `withoutTenantScope` rather than silenced,
     * because that is the only sanctioned bypass in this codebase and it is
     * what makes the complete list reviewable — `scripts/safety/isolation-audit.ts`
     * counts every one of them and fails the build on any that names no reason.
     *
     * Nothing is weakened by doing so. The query and the write are byte for
     * byte the ones that ran before; what changes is that the exemption is
     * now stated, attributed and greppable instead of being inferred from a
     * warning line with a stack trace that lands inside mongoose.
     *
     * The row itself carries no orgId, which is correct for a bootstrap
     * account on a deployment whose tenants do not exist yet. It is not a
     * template for request-path code: anything serving a request has a
     * context and must be scoped to it.
     */
    // Never on the legacy database: starting a process must not write to it,
    // and a seeded administrator there would be an account nobody created.
    if (legacy) {
      console.log('ℹ️ Legacy database: bootstrap administrator not seeded');
      return;
    }
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@cbt.local';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123';
    const adminName = process.env.ADMIN_NAME || 'System Admin';
    await withoutTenantScope('bootstrap:seed-default-admin', async () => {
      const existingAdmin = await User.findOne({ email: adminEmail, role: 'admin' });
      if (!existingAdmin) {
        await User.create({ name: adminName, email: adminEmail, password: adminPassword, role: 'admin' });
        console.log(`👤 Default admin seeded: ${adminEmail}`);
      }
    });
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    // Do not terminate the process here; let the caller handle the failure
    throw error;
  }
};
