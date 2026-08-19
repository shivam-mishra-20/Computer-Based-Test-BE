/**
 * Token audiences, both directions, against the real running API.
 *
 * ── Why this needs its own suite ────────────────────────────────────────────
 * P2 built three audiences and enforced ONE direction: `platformAuth` rejects a
 * tenant token at the platform door. The other direction — a platform-staff
 * token used on a tenant route — was never checked. It failed anyway, but only
 * by ACCIDENT: `PlatformUser` lives in its own collection, so `User.findById`
 * found nothing and the request 401'd on "User not found".
 *
 * A coincidence of storage layout is not a security boundary. One shared
 * collection, or one upsert-on-login, and the coincidence evaporates silently.
 * `authMiddleware` now rejects a non-tenant audience explicitly, and this proves
 * both halves hold.
 *
 * ── The legacy case is the one that must NOT be rejected ────────────────────
 * Every token in the field predates the audience work and carries no `aud` at
 * all. Rejecting those would log out every installed app on deploy, so a
 * missing audience is accepted and asserted here — the check exists as much to
 * protect that as to enforce the boundary.
 *
 * Needs the fixture API running (scripts/safety/p6-fixture-server.js).
 *
 *   P6_MONGO_URI=<scratch> node -r ./scripts/safety/dns-preload.js \
 *     -r ts-node/register/transpile-only scripts/safety/token-audience.test.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { registerTenancy, withoutTenantScope } from '../../src/core/tenancy';
import { signPlatformToken, signSessionToken } from '../../src/core/auth/tokens';
import { assertNotProduction } from './lib';

process.env.REDIS_ENABLED = 'false';

const API = process.env.P8_API_BASE || 'http://127.0.0.1:5055/api';

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

async function probe(path: string, token: string) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  let code: string | undefined;
  try {
    code = ((await res.json()) as { code?: string }).code;
  } catch {
    /* not json */
  }
  return { status: res.status, code };
}

async function main() {
  const uri = process.env.P6_MONGO_URI;
  if (!uri) throw new Error('P6_MONGO_URI must name the scratch database.');
  assertNotProduction(uri, process.env.MONGO_URI as string);

  registerTenancy();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const PlatformUser = require('../../src/models/PlatformUser').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const User = require('../../src/models/User').default;

  const MARKER = 'p8.audience@platform.fixture';
  let staff = await withoutTenantScope('audience:find-staff', () =>
    PlatformUser.findOne({ email: MARKER }).lean(),
  );
  if (!staff) {
    const created = await PlatformUser.create({
      name: 'P8 Audience Check',
      email: MARKER,
      password: 'P8-audience-check!',
      role: 'owner',
      isActive: true,
    });
    staff = created.toObject();
  }

  const tenantUser = await withoutTenantScope('audience:find-user', () =>
    User.findOne({ email: 'p6.admin@abhigyan.fixture' }).lean(),
  );
  if (!tenantUser) throw new Error('Run seed-p6-fixture.ts first.');

  const platformToken = signPlatformToken({
    id: String(staff._id),
    role: staff.role,
    tokenVersion: staff.tokenVersion ?? 0,
  });
  const tenantToken = signSessionToken({
    id: String(tenantUser._id),
    role: tenantUser.role,
    orgId: tenantUser.orgId,
  });
  // The shape every installed client still carries: no `aud` at all.
  const legacyToken = jwt.sign(
    { id: String(tenantUser._id), role: tenantUser.role, orgId: tenantUser.orgId },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' },
  );

  try {
    console.log('\na tenant token belongs on tenant routes');
    {
      const ok = await probe('/me/context', tenantToken);
      check('and is accepted there', ok.status === 200, `got ${ok.status}`);
      const refused = await probe('/platform/orgs', tenantToken);
      check('and refused at the platform door', refused.status === 403, `got ${refused.status}`);
      check(
        'with the audience code, not a generic 403',
        refused.code === 'TOKEN_AUDIENCE_MISMATCH',
        String(refused.code),
      );
    }

    console.log('\na platform token belongs on platform routes');
    {
      const ok = await probe('/platform/orgs', platformToken);
      check('and is accepted there', ok.status === 200, `got ${ok.status}`);

      // ── The direction that was never enforced ──────────────────────────
      const refused = await probe('/me/context', platformToken);
      check(
        'and is refused on a tenant route',
        refused.status === 403,
        `got ${refused.status} — a 401 here means it is failing on "user not found", ` +
          `which is a storage coincidence rather than a boundary`,
      );
      check(
        'for the right reason',
        refused.code === 'TOKEN_AUDIENCE_MISMATCH',
        String(refused.code),
      );
    }

    console.log('\na legacy token — no audience claim at all — still works');
    {
      const ok = await probe('/me/context', legacyToken);
      check(
        'accepted, because rejecting it would log out every installed app',
        ok.status === 200,
        `got ${ok.status}`,
      );
    }

    console.log('\nnonsense is still refused');
    {
      const forged = jwt.sign(
        { id: String(tenantUser._id), aud: 'admin-please' },
        process.env.JWT_SECRET as string,
        { expiresIn: '1h' },
      );
      const refused = await probe('/me/context', forged);
      check('an invented audience is not accepted', refused.status === 403, `got ${refused.status}`);

      const unsigned = await probe('/me/context', 'not-a-real-token-but-long-enough-to-pass');
      check('an unverifiable token is refused', unsigned.status === 401, `got ${unsigned.status}`);
    }
  } finally {
    await mongoose.disconnect();
  }

  console.log('');
  if (failures) {
    console.error(`TOKEN AUDIENCE TESTS FAILED — ${failures} of ${checks}.`);
    process.exit(1);
  }
  console.log(`All ${checks} token audience checks passed.`);
  process.exit(0);
}

main().catch((error) => {
  console.error('token-audience.test.ts crashed:', error);
  process.exit(1);
});
