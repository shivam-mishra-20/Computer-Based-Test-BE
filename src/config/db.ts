import mongoose from 'mongoose';
import dotenv from 'dotenv';
import dns from 'node:dns';
import User from '../models/User';

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

    try {
      await mongoose.connect(uri);
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
        await mongoose.connect(directUri);
      } else {
        throw primaryError;
      }
    }

    console.log('✅ MongoDB Connected');

    // Seed default admin if not exists
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@cbt.local';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123';
    const adminName = process.env.ADMIN_NAME || 'System Admin';
    const existingAdmin = await User.findOne({ email: adminEmail, role: 'admin' });
    if (!existingAdmin) {
      await User.create({ name: adminName, email: adminEmail, password: adminPassword, role: 'admin' });
      console.log(`👤 Default admin seeded: ${adminEmail}`);
    }
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    // Do not terminate the process here; let the caller handle the failure
    throw error;
  }
};
