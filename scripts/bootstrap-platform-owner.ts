/**
 * Create the FIRST platform-staff account.
 *
 * ── The deadlock this breaks ────────────────────────────────────────────────
 * `POST /api/platform/staff` creates platform users, and it requires an
 * authenticated platform user holding `staff.manage`. With an empty
 * `platformusers` collection there is nobody who can create the first one, so
 * the platform console cannot be operated at all. This script is the only way
 * in, and it is deliberately the ONLY way in: a self-service "claim ownership"
 * endpoint would be a permanent privilege-escalation route sitting on a public
 * surface for the sake of a single first-run convenience.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 * It creates one `PlatformUser` and nothing else. No organization, no tenant
 * user, no tenant role, no tenant permission. Platform staff belong to no
 * organization by definition — that separation is the reason they live in
 * their own collection with their own token audience, and a bootstrap that
 * blurred it would undo the whole point.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *   • Refuses a target it cannot prove is intended.
 *   • Production requires BOTH `--production` and a typed acknowledgement.
 *     `seed-org-001` needs only `--production` because it writes one row nothing
 *     reads yet; this creates an account that can administer every customer on
 *     the platform, so it asks twice.
 *   • The password comes from the environment or an interactive prompt. It is
 *     never a flag (flags land in shell history and process listings), never
 *     defaulted, and never printed or logged — not on success, not in an error.
 *   • Idempotent. If an owner exists it reports that and changes nothing; it
 *     will not quietly mint a second account with total authority.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # Scratch / rehearsal
 *   PLATFORM_OWNER_EMAIL=you@example.com \
 *   PLATFORM_OWNER_NAME="Your Name" \
 *   PLATFORM_OWNER_PASSWORD='…' \
 *     npx ts-node --transpile-only scripts/bootstrap-platform-owner.ts \
 *       --scratch-suffix restore_2026_08_17
 *
 *   # Production (asks twice)
 *   PLATFORM_OWNER_EMAIL=… PLATFORM_OWNER_NAME=… \
 *   PLATFORM_BOOTSTRAP_ACK='I am creating a platform owner account' \
 *     npx ts-node --transpile-only scripts/bootstrap-platform-owner.ts --production
 *   # (password prompted interactively when PLATFORM_OWNER_PASSWORD is unset)
 *
 * ── Removing one, on scratch only ───────────────────────────────────────────
 *   npx ts-node --transpile-only scripts/bootstrap-platform-owner.ts \
 *     --scratch-suffix restore_2026_08_17 --remove
 *
 * `--remove` refuses `--production` outright. Deleting the only account that
 * can administer the platform is not something a script should make easy.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { createInterface } from 'readline';
import { configureDnsForSrv, redactUri, requireEnv, describeUri } from './safety/lib';
import { registerTenancy } from '../src/core/tenancy';
import { recordPlatformEvent } from '../src/core/platform/audit';

process.env.REDIS_ENABLED = process.env.REDIS_ENABLED ?? 'false';

const ACK_PHRASE = 'I am creating a platform owner account';
const MIN_PASSWORD_LENGTH = 12;

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] ?? null : null;
}

function deriveScratchUri(productionUri: string, suffix: string): string {
  const m = productionUri.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/);
  if (!m) throw new Error('MONGO_URI could not be parsed.');
  return `${m[1]}${m[2]}_${suffix}${m[3] ?? ''}`;
}

/**
 * Read a password without echoing it.
 *
 * The environment variable is checked first so this can run unattended, but an
 * interactive prompt is offered because putting a credential in an environment
 * variable leaves it in shell history and in `/proc/<pid>/environ`.
 */
async function readPassword(): Promise<string> {
  const fromEnv = process.env.PLATFORM_OWNER_PASSWORD;
  if (fromEnv) return fromEnv;

  if (!process.stdin.isTTY) {
    throw new Error(
      'No password. Set PLATFORM_OWNER_PASSWORD, or run interactively so it can be prompted.',
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const stdout = process.stdout as NodeJS.WriteStream & { _writeToOutput?: (s: string) => void };

  return new Promise<string>((resolve) => {
    // Suppress the echo so the password does not appear on screen or in a
    // terminal scrollback that someone later screenshots.
    const muted = { on: false };
    const original = (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function (s: string) {
      if (!muted.on) original?.call(this, s);
    };
    rl.question('Password (not echoed): ', (answer) => {
      muted.on = false;
      stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    muted.on = true;
  });
}

function fail(message: string): never {
  console.error(`\n[bootstrap-platform-owner] ${message}\n`);
  process.exit(2);
}

async function main() {
  const productionUri = requireEnv('MONGO_URI');
  const suffix = arg('--scratch-suffix');
  const wantsProduction = process.argv.includes('--production');
  const remove = process.argv.includes('--remove');

  // ── Target resolution: never guessed ──────────────────────────────────────
  let uri: string;
  if (suffix) {
    uri = deriveScratchUri(productionUri, suffix);
  } else if (wantsProduction) {
    uri = productionUri;
  } else {
    fail(
      'Refusing to guess a target.\n' +
        '  Rehearsal:  --scratch-suffix <suffix>\n' +
        '  Production: --production\n\n' +
        '  Rehearse first. Always.',
    );
  }

  const described = describeUri(uri);
  if (!described) fail('The target URI could not be parsed, so it cannot be proven safe.');

  if (remove && wantsProduction) {
    fail(
      '--remove refuses --production.\n' +
        '  Deleting the account that administers every customer is not a scripted operation.\n' +
        '  Disable it through the console instead: that bumps tokenVersion, so outstanding\n' +
        '  tokens stop working immediately rather than at expiry.',
    );
  }

  // ── Production needs a second, typed acknowledgement ──────────────────────
  if (wantsProduction) {
    const ack = process.env.PLATFORM_BOOTSTRAP_ACK;
    if (ack !== ACK_PHRASE) {
      fail(
        'Production bootstrap requires an explicit acknowledgement.\n\n' +
          `  PLATFORM_BOOTSTRAP_ACK='${ACK_PHRASE}'\n\n` +
          '  This creates an account that can read and administer every organization\n' +
          '  on the platform. One flag is not enough of a pause for that.',
      );
    }
  }

  const email = (process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
  const name = (process.env.PLATFORM_OWNER_NAME || '').trim();

  if (!remove) {
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      fail('PLATFORM_OWNER_EMAIL must be set to a valid address.');
    }
    if (!name) fail('PLATFORM_OWNER_NAME must be set.');
  } else if (!email) {
    fail('PLATFORM_OWNER_EMAIL must name the account to remove.');
  }

  registerTenancy();
  configureDnsForSrv();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });

  // Required after the connection so the model compiles with the tenancy
  // plugin registered — PlatformUser is `tenantScoped: false`, and the audit
  // asserts that rather than assuming it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const PlatformUser = require('../src/models/PlatformUser').default;

  console.log(`[bootstrap-platform-owner] target: ${redactUri(uri)}`);
  if (wantsProduction) console.log('[bootstrap-platform-owner] ⚠ PRODUCTION');

  try {
    // ── Removal (scratch only) ──────────────────────────────────────────────
    if (remove) {
      const result = await PlatformUser.deleteOne({ email });
      console.log(
        result.deletedCount
          ? `[bootstrap-platform-owner] removed ${email}`
          : `[bootstrap-platform-owner] no account for ${email} — nothing to do`,
      );
      return;
    }

    // ── Idempotence, and the refusal that matters ───────────────────────────
    const existingSame = await PlatformUser.findOne({ email }).select('_id role isActive').lean();
    if (existingSame) {
      console.log(
        `[bootstrap-platform-owner] already exists — NO CHANGE.\n` +
          `    email : ${email}\n` +
          `    role  : ${existingSame.role}\n` +
          `    active: ${existingSame.isActive}\n\n` +
          `  Its password was NOT reset. To recover access to an account whose password\n` +
          `  is lost, create a second owner from an existing one through the console.`,
      );
      return;
    }

    const ownerCount = await PlatformUser.countDocuments({ role: 'owner' });
    if (ownerCount > 0) {
      // The whole justification for this script is an empty collection. Once an
      // owner exists, `POST /api/platform/staff` is available and is the
      // audited, capability-checked path — using this instead would be a way to
      // mint privilege without appearing in the console's own trail.
      fail(
        `An owner already exists (${ownerCount} found), so the bootstrap deadlock is\n` +
          '  already broken. Create further staff through the console, which checks\n' +
          '  `staff.manage` and records who did it.',
      );
    }

    const password = await readPassword();
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      // Length only. Composition rules push people toward `Password1!`, and this
      // account is the most valuable credential on the platform.
      fail(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    // `new` + `save()`, never `create({...})` with a pre-hashed value: the
    // model's pre-save hook is what hashes it, and bypassing that is how a
    // plaintext password reaches the database.
    const owner = new PlatformUser({ name, email, password, role: 'owner', isActive: true });
    await owner.save();

    await recordPlatformEvent({
      action: 'platform.owner.bootstrap',
      actorId: String(owner._id),
      actorEmail: owner.email,
      actorRole: 'owner',
      entity: 'PlatformUser',
      entityId: String(owner._id),
      metadata: { via: 'bootstrap-platform-owner', production: wantsProduction },
    });

    console.log(
      `\n[bootstrap-platform-owner] created platform owner\n` +
        `    name : ${owner.name}\n` +
        `    email: ${owner.email}\n` +
        `    role : owner\n\n` +
        `  Sign in at the console with this address and the password you supplied.\n` +
        `  The password is not printed here and is not recoverable from the database.\n`,
    );
  } finally {
    await mongoose.connection.close();
  }
}

main().catch((error) => {
  // Deliberately does not echo the error object: a validation failure from
  // Mongoose can include the document being saved, and that document holds the
  // password before the pre-save hook has replaced it with a hash.
  console.error('[bootstrap-platform-owner] FAILED:', (error as Error).message);
  process.exit(1);
});
