/**
 * Two platform-staff accounts with KNOWN passwords, for the console login suite.
 *
 * ── Why a seeder and not the bootstrap script ───────────────────────────────
 * `bootstrap-platform-owner.ts` refuses once an owner exists, which is exactly
 * the behaviour `platform-auth.test.ts` verifies. The console suite is not
 * testing the deadlock breaker — it is testing what happens after the door
 * exists — and it needs a support account too, which bootstrap deliberately
 * cannot create. So these are seeded directly, the same way the P6 tenant
 * fixture users are.
 *
 * These credentials are FIXTURE credentials in a scratch database. They are in
 * source for the same reason `P6-fixture-abhigyan!` is: a test that reads its
 * own password from somewhere unrecorded is a test nobody else can run. Nothing
 * here may ever be seeded into production, and `assertNotProduction` enforces
 * that rather than trusting it.
 *
 * Passwords are hashed by the model's pre-save hook — `new` + `save()`, never
 * `updateOne` with a plaintext value, which is how a raw password reaches a
 * database.
 *
 *   CONSOLE_FIXTURE_MONGO_URI=mongodb+srv://.../p6_client_platform_web_scratch \
 *     node -r ./scripts/safety/dns-preload.js -r ts-node/register/transpile-only \
 *          scripts/safety/seed-console-login-fixture.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { registerTenancy, withoutTenantScope } from '../../src/core/tenancy';
import { assertNotProduction } from './lib';

process.env.REDIS_ENABLED = process.env.REDIS_ENABLED ?? 'false';

export const CONSOLE_OWNER = {
  name: 'P10A Console Owner',
  email: 'p10a-owner@platform.test',
  password: 'bootstrap-owner-password',
  role: 'owner' as const,
};

export const CONSOLE_SUPPORT = {
  name: 'P10A Console Support',
  email: 'p10a-support@platform.test',
  password: 'support-account-password',
  role: 'support' as const,
};

async function main() {
  const uri = process.env.CONSOLE_FIXTURE_MONGO_URI;
  if (!uri) {
    throw new Error(
      'CONSOLE_FIXTURE_MONGO_URI must name a scratch database. It is not defaulted, ' +
        'because the default would eventually be wrong exactly once.',
    );
  }
  assertNotProduction(uri, process.env.MONGO_URI as string);

  registerTenancy();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30_000 });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const PlatformUser = require('../../src/models/PlatformUser').default;

  try {
    for (const account of [CONSOLE_OWNER, CONSOLE_SUPPORT]) {
      await withoutTenantScope('console-fixture', async () => {
        // Deleted and recreated rather than updated: the password must go
        // through the pre-save hook, and a re-run must produce an account whose
        // password is the one documented here even if a previous suite bumped
        // tokenVersion or disabled it.
        await PlatformUser.deleteOne({ email: account.email });
        const created = new PlatformUser({
          name: account.name,
          email: account.email,
          password: account.password,
          role: account.role,
          isActive: true,
        });
        await created.save();
        console.log(`  seeded ${account.email} [${account.role}]`);
      });
    }

    const owners = await withoutTenantScope('console-fixture', () =>
      PlatformUser.countDocuments({ role: 'owner' }),
    );
    console.log(`\nplatform owners in this database: ${owners}`);
  } finally {
    await mongoose.connection.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('seed-console-login-fixture FAILED:', (error as Error).message);
    process.exit(1);
  });
