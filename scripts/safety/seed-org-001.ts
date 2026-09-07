/**
 * Seed Org 001 — Abhigyan Gurukul.
 *
 * Creates the organization document that every existing row will be backfilled
 * to. Idempotent: running it twice is a no-op, so it is safe to re-run after a
 * partial failure or on a rehearsal database.
 *
 * ── Ordering ────────────────────────────────────────────────────────────────
 * This runs BEFORE the backfill and before ORG_ID is set on any deployment.
 * The id it prints is what goes into the api-legacy environment.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 * Writes exactly one document to one collection that nothing reads yet. It
 * cannot affect any existing query, because no code path reads `Org` until the
 * middleware is configured with an ORG_ID.
 *
 * Rehearse on the scratch restore first:
 *   npx ts-node scripts/safety/seed-org-001.ts --scratch-suffix restore_2026_08_17
 *
 * Then, when approved, against production:
 *   npx ts-node scripts/safety/seed-org-001.ts --production
 */

import { config } from 'dotenv';
import mongoose from 'mongoose';
import { registerTenancy } from '../../src/core/tenancy';
import { configureDnsForSrv, redactUri, requireEnv } from './lib';

config();
registerTenancy();

// Imported after registerTenancy so the plugin is applied — Org opts out of
// scoping, but the import order rule holds for every model without exception.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Org = require('../../src/models/Org').default;

function arg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] ?? null : null;
}

function deriveScratchUri(productionUri: string, suffix: string): string {
  const match = productionUri.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/);
  if (!match) throw new Error('MONGO_URI could not be parsed.');
  const [, authority, db, query = ''] = match;
  return `${authority}${db}_${suffix}${query}`;
}

/**
 * Abhigyan's current production configuration, captured as tenant config.
 *
 * These values are what the code hardcodes today. Seeding them here changes
 * nothing on its own — the code still reads its constants — but it is the
 * destination those constants move to in P4, and having them recorded now
 * means that move is a deletion rather than an archaeology exercise.
 */
const ORG_001 = {
  name: 'Abhigyan Gurukul',
  slug: 'abhigyan',
  status: 'active' as const,
  isPlatformOwned: true,
  branding: {
    appName: 'Abhigyan Gurukul',
    // Sourced from lib/theme/colors.ts and app.json in the mobile app.
    primaryColor: '#059669',
    secondaryColor: '#4F46E5',
    documentHeader: 'Abhigyan Gurukul',
  },
  locale: {
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    language: 'English',
  },
  domains: ['abhigyangurukul.com', 'www.abhigyangurukul.com'],
  notes:
    'Tenant 001. Migrated from the single-institute platform on 2026-08-17. ' +
    'Platform-owned: never billed, never suspended, entitled to all modules.',
};

async function main() {
  const productionUri = requireEnv('MONGO_URI');
  const suffix = arg('--scratch-suffix');
  const wantsProduction = process.argv.includes('--production');

  let uri: string;
  if (suffix) {
    uri = deriveScratchUri(productionUri, suffix);
  } else if (wantsProduction) {
    uri = productionUri;
  } else {
    console.error(
      'Refusing to guess a target.\n' +
        '  Rehearsal:  --scratch-suffix restore_2026_08_17\n' +
        '  Production: --production\n\n' +
        '  Rehearse first. Always.',
    );
    process.exit(2);
    return;
  }

  console.log(`[seed-org-001] target: ${redactUri(uri)}`);
  if (wantsProduction) {
    console.log('[seed-org-001] ⚠ PRODUCTION — writing one document to the "orgs" collection.');
  }

  configureDnsForSrv();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });

  try {
    const existing = await Org.findOne({ slug: ORG_001.slug });

    if (existing) {
      console.log(`[seed-org-001] already present — no change made.`);
      console.log(`\n  ORG_ID=${existing._id}\n`);
      return;
    }

    const created = await Org.create(ORG_001);
    console.log(`[seed-org-001] created "${created.name}"`);
    console.log(`\n  ORG_ID=${created._id}\n`);
    console.log('  Set this as ORG_ID on the api-legacy deployment.');
    console.log('  Do NOT set it anywhere until the backfill has completed.');
  } finally {
    await mongoose.connection.close();
  }
}

main().catch((error) => {
  console.error('[seed-org-001] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
