/**
 * Mint the platform-staff tokens `console-ui.e2e.test.ts` needs.
 *
 * The console suite has always required an `OWNER_TOKEN` and a `SUPPORT_TOKEN`
 * in a file it reads, and has always failed with a clear message when they were
 * absent — but nothing in the repository produced them, so re-running that
 * suite meant reconstructing the minting by hand each time. A regression suite
 * you cannot re-run on demand is one you stop re-running.
 *
 * Two accounts, on purpose. `owner` holds every platform capability and
 * `support` holds a strict subset, so the console suite can tell a screen that
 * is hidden by capability from one that is broken.
 *
 *   P6_MONGO_URI=<scratch db> \
 *     node -r ./scripts/safety/dns-preload.js -r ts-node/register/transpile-only \
 *          scripts/safety/mint-platform-tokens.ts
 *
 * Writes to $TOKENS_FILE, defaulting to `<os.tmpdir()>/pc-tokens.env` — the same
 * path the console suite reads, resolved the same way. Git Bash's `/tmp` and
 * Node's `os.tmpdir()` are different directories on Windows, which is exactly
 * the kind of mismatch that makes "the file is right there" untrue.
 */

import 'dotenv/config';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import mongoose from 'mongoose';
import { registerTenancy, withoutTenantScope } from '../../src/core/tenancy';
import { assertNotProduction } from './lib';

const MARKER = 'p6-console-e2e';

async function main() {
  const uri = process.env.P6_MONGO_URI;
  if (!uri) throw new Error('P6_MONGO_URI must name the scratch database.');
  const production = process.env.MONGO_URI;
  if (!production) throw new Error('MONGO_URI must be set so the guard knows what production is.');
  assertNotProduction(uri, production);

  registerTenancy();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });

  const tokens = await withoutTenantScope('p6:mint-platform-tokens', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const PlatformUser = require('../../src/models/PlatformUser').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { signPlatformToken } = require('../../src/core/auth/tokens');

    const made: Record<string, string> = {};
    for (const role of ['owner', 'support'] as const) {
      const email = `${MARKER}-${role}@platform.test`;
      let account = await PlatformUser.findOne({ email });
      if (!account) {
        account = await PlatformUser.create({
          name: `P6 ${role}`,
          email,
          password: 'not-used-tokens-are-minted-directly',
          role,
          isActive: true,
        });
      } else if (account.role !== role || !account.isActive) {
        account.role = role;
        account.isActive = true;
        await account.save();
      }
      // `tokenVersion` must match the stored one, or the token is rejected as
      // revoked the moment it is used — which is the point of tokenVersion.
      made[role] = signPlatformToken({
        id: String(account._id),
        role,
        tokenVersion: account.tokenVersion ?? 0,
      });
    }
    return made;
  });

  const path = process.env.TOKENS_FILE || join(tmpdir(), 'pc-tokens.env');
  writeFileSync(path, `OWNER_TOKEN=${tokens.owner}\nSUPPORT_TOKEN=${tokens.support}\n`, 'utf8');
  console.log(`wrote OWNER_TOKEN and SUPPORT_TOKEN to ${path}`);
  console.log('(platform tokens expire in 15 minutes — mint immediately before the run)');

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('mint-platform-tokens failed:', error);
  process.exit(1);
});
