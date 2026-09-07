/**
 * Seed an organization's configuration from the legacy constants.
 *
 * ── Why this is a no-op for behaviour ───────────────────────────────────────
 * The resolvers already fall back to exactly these values when no rows exist,
 * so seeding Org 001 changes nothing about how it behaves. What it changes is
 * EDITABILITY: once the rows exist, an admin can rename Class 11, add a room,
 * or drop a subject through the product instead of through a deploy.
 *
 * Being a behavioural no-op is also what makes it safe to run against
 * production ahead of any cutover — and it means the seed can be verified by
 * comparing resolver output before and after, which `--verify` does.
 *
 * Idempotent: existing rows are left alone.
 *
 *   npx ts-node --transpile-only scripts/safety/seed-org-config.ts --scratch-suffix restore_2026_08_17
 *   npx ts-node --transpile-only scripts/safety/seed-org-config.ts --production
 */

import { config } from 'dotenv';
import { registerTenancy } from '../../src/core/tenancy';
import { configureDnsForSrv, redactUri, requireEnv } from './lib';

config();
registerTenancy();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mongoose = require('mongoose');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { withoutTenantScope, runWithTenant } = require('../../src/core/tenancy/context');

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] ?? null : null;
}

function deriveScratchUri(productionUri: string, suffix: string): string {
  const m = productionUri.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/);
  if (!m) throw new Error('MONGO_URI could not be parsed.');
  return `${m[1]}${m[2]}_${suffix}${m[3] ?? ''}`;
}

async function main() {
  const productionUri = requireEnv('MONGO_URI');
  const suffix = arg('--scratch-suffix');
  const wantsProduction = process.argv.includes('--production');
  const slug = arg('--slug') ?? 'abhigyan';

  let uri: string;
  if (suffix) uri = deriveScratchUri(productionUri, suffix);
  else if (wantsProduction) uri = productionUri;
  else {
    console.error(
      'Refusing to guess a target.\n' +
        '  Rehearsal:  --scratch-suffix restore_2026_08_17\n' +
        '  Production: --production',
    );
    process.exit(2);
    return;
  }

  configureDnsForSrv();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Org = require('../../src/models/Org').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ClassLevel = require('../../src/models/ClassLevel').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Subject = require('../../src/models/Subject').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const OrgRoom = require('../../src/models/OrgRoom').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const OrgPolicy = require('../../src/models/OrgPolicy').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { legacyClassLevels, legacySubjects, legacyRooms, getOrgConfiguration } =
    require('../../src/core/config/orgConfig');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PLATFORM_DEFAULTS, getOrgPolicy } = require('../../src/core/config/policy');

  try {
    const org = await withoutTenantScope('seed:find-org', () => Org.findOne({ slug }));
    if (!org) throw new Error(`Organization "${slug}" not found. Run seed-org-001 first.`);
    const orgId = String(org._id);

    console.log(`[seed-config] target : ${redactUri(uri)}`);
    console.log(`[seed-config] org    : ${org.name} (${orgId})\n`);

    // Resolver output BEFORE — the behavioural baseline.
    const before = await getOrgConfiguration(orgId);
    const policyBefore = await getOrgPolicy(orgId);

    await runWithTenant({ orgId, source: 'script' }, async () => {
      // ── Class levels ────────────────────────────────────────────────────
      let created = 0;
      for (const level of legacyClassLevels()) {
        const exists = await ClassLevel.findOne({ orgId, key: level.key });
        if (exists) continue;
        await ClassLevel.create({
          key: level.key,
          label: level.label,
          aliases: level.aliases,
          order: level.order,
          isActive: true,
        });
        created++;
      }
      console.log(`  class levels   ${created} created, ${legacyClassLevels().length - created} already present`);

      // ── Subjects ────────────────────────────────────────────────────────
      created = 0;
      const subjects = legacySubjects();
      for (let i = 0; i < subjects.length; i++) {
        const exists = await Subject.findOne({ orgId, name: subjects[i] });
        if (exists) continue;
        await Subject.create({ name: subjects[i], order: i, isActive: true });
        created++;
      }
      console.log(`  subjects       ${created} created, ${subjects.length - created} already present`);

      // ── Rooms ───────────────────────────────────────────────────────────
      created = 0;
      const rooms = legacyRooms();
      for (let i = 0; i < rooms.length; i++) {
        const exists = await OrgRoom.findOne({ orgId, name: rooms[i].name });
        if (exists) continue;
        await OrgRoom.create({
          name: rooms[i].name,
          capacity: rooms[i].capacity,
          order: i,
          isActive: true,
        });
        created++;
      }
      console.log(`  rooms          ${created} created, ${rooms.length - created} already present`);

      // ── Policy ──────────────────────────────────────────────────────────
      const existingPolicy = await OrgPolicy.findOne({ orgId });
      if (existingPolicy) {
        console.log('  policy         already present');
      } else {
        await OrgPolicy.create({ ...PLATFORM_DEFAULTS, orgId });
        console.log('  policy         created from platform defaults');
      }
    });

    // ── Prove it changed nothing ──────────────────────────────────────────
    const after = await getOrgConfiguration(orgId);
    const policyAfter = await getOrgPolicy(orgId);

    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

    console.log('\n─── behavioural equivalence ───');
    const classSame = same(
      before.classLevels.map((c: { key: string }) => c.key),
      after.classLevels.map((c: { key: string }) => c.key),
    );
    const subjectSame = same(before.subjects, after.subjects);
    const roomSame = same(before.rooms, after.rooms);
    const examSame = same(policyBefore.exam, policyAfter.exam);
    const attSame = same(policyBefore.attendance, policyAfter.attendance);

    console.log(`  class levels   ${classSame ? 'IDENTICAL' : 'CHANGED'}`);
    console.log(`  subjects       ${subjectSame ? 'IDENTICAL' : 'CHANGED'}`);
    console.log(`  rooms          ${roomSame ? 'IDENTICAL' : 'CHANGED'}`);
    console.log(`  exam policy    ${examSame ? 'IDENTICAL' : 'CHANGED'}`);
    console.log(`  attendance     ${attSame ? 'IDENTICAL' : 'CHANGED'}`);

    const allSame = classSame && subjectSame && roomSame && examSame && attSame;
    if (!allSame) {
      console.error(
        '\nFAILED — seeding CHANGED resolved behaviour. The seeded rows do not match\n' +
          'the legacy constants they were derived from. Investigate before proceeding.',
      );
      process.exit(1);
    }

    console.log('\nPASSED — configuration is now editable and behaviour is unchanged.');
  } finally {
    await mongoose.connection.close();
  }
}

main().catch((error) => {
  console.error('[seed-config] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
