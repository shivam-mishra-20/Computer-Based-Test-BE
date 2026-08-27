/**
 * Public content for the guest experience, in the SCRATCH fixture.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `client-platform-app`'s explore mode reads `/api/public/*`, which serves only
 * documents an institute has deliberately opened up: `status: 'published'` AND
 * `isPublic: true`. The P6 fixture seeds none, so every guest screen rendered
 * its empty state and the populated experience was never actually seen. An
 * empty state is a real state worth testing; it is not the only one.
 *
 * ── Where this runs, and where it must not ──────────────────────────────────
 * The same rule as `seed-p6-fixture.ts`, enforced the same way: the target
 * database name must differ from the production one, and the script refuses
 * rather than warns. It writes nothing to production, touches no institute
 * collection other than the two public-facing ones, and every write is an
 * upsert keyed on a stable title so re-running it changes nothing.
 *
 * ── What it seeds, and why so little ────────────────────────────────────────
 * Four study resources and three practice tests. Enough for the explore screen
 * to show a subject row, a featured list and a browsable test list; few enough
 * that nobody mistakes the fixture for a content library. The tests carry no
 * QUESTIONS at all — `sections: []` — because the guest surface never returns
 * questions and seeding them would suggest it might.
 *
 *   P6_MONGO_URI=mongodb+srv://.../p6_client_platform_web_scratch \
 *     node -r ./scripts/safety/dns-preload.js -r ts-node/register/transpile-only \
 *          scripts/safety/seed-public-content.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.P6_MONGO_URI || process.env.SCRATCH_MONGO_URI;

function dbNameOf(connectionString: string): string {
  const match = connectionString.match(/\/([^/?]+)(\?|$)/);
  return match ? match[1] : '';
}

async function main(): Promise<void> {
  if (!uri) {
    console.error('P6_MONGO_URI is required. Derive it with scripts/safety/scratch-uri.js.');
    process.exit(2);
  }

  const target = dbNameOf(uri);
  const production = dbNameOf(process.env.MONGO_URI || '');

  if (!target) {
    console.error('The URI names no database.');
    process.exit(2);
  }
  // Refuse, do not warn. A warning is something you read after the write.
  if (production && target === production) {
    console.error(
      `Refusing to seed "${target}": that is the production database. ` +
        'This script writes only to a scratch fixture.',
    );
    process.exit(2);
  }
  if (!/scratch|fixture|test/i.test(target)) {
    console.error(
      `Refusing to seed "${target}": the name does not identify it as a scratch database. ` +
        'Rename the target or use scripts/safety/scratch-uri.js.',
    );
    process.exit(2);
  }

  await mongoose.connect(uri);
  console.log(`[seed] connected to ${target}`);

  const { default: StudyResource } = await import('../../src/models/StudyResource');
  const { default: PublicTest } = await import('../../src/models/PublicTest');
  const { default: User } = await import('../../src/models/User');

  // `createdBy` is required on PublicTest. Any existing fixture user satisfies
  // the reference; the field is never returned to a guest.
  const author = await User.findOne({}).select('_id').lean();
  if (!author) {
    console.error('No user exists in this fixture. Run seed-p6-fixture.ts first.');
    process.exit(2);
  }

  const resources = [
    {
      title: 'Kinematics — motion in a straight line',
      subject: 'Physics',
      classLevel: '11',
      chapter: 'Kinematics',
      type: 'video',
      contentCategory: 'lecture',
      isFeatured: true,
    },
    {
      title: 'Mole concept, worked from first principles',
      subject: 'Chemistry',
      classLevel: '11',
      chapter: 'Some Basic Concepts',
      type: 'video',
      contentCategory: 'lecture',
      isFeatured: true,
    },
    {
      title: 'Trigonometric identities — formula sheet',
      subject: 'Mathematics',
      classLevel: '11',
      chapter: 'Trigonometry',
      type: 'pdf',
      contentCategory: 'notes',
      pageCount: 6,
    },
    {
      title: 'Cell structure — annotated diagrams',
      subject: 'Biology',
      classLevel: '11',
      chapter: 'Cell: The Unit of Life',
      type: 'pdf',
      contentCategory: 'notes',
      pageCount: 12,
    },
  ];

  for (const resource of resources) {
    await StudyResource.updateOne(
      { title: resource.title },
      {
        $set: {
          ...resource,
          // The two flags that put it on the public surface. Stated explicitly
          // rather than left to schema defaults, because these ARE the point.
          status: 'published',
          isPublic: true,
        },
      },
      { upsert: true },
    );
  }
  console.log(`[seed] ${resources.length} public study resources`);

  const tests = [
    {
      title: 'Physics — Kinematics practice set',
      description: 'Twenty questions on motion in one and two dimensions, timed.',
      subject: 'Physics',
      classLevel: '11',
      difficulty: 'medium' as const,
      durationMins: 45,
      examType: 'Practice',
    },
    {
      title: 'Chemistry — Mole concept drill',
      description: 'Stoichiometry and concentration, at exam pace.',
      subject: 'Chemistry',
      classLevel: '11',
      difficulty: 'easy' as const,
      durationMins: 30,
      examType: 'Practice',
    },
    {
      title: 'Mathematics — Trigonometry mixed paper',
      description: 'Identities, equations and heights and distances.',
      subject: 'Mathematics',
      classLevel: '11',
      difficulty: 'hard' as const,
      durationMins: 60,
      examType: 'Mock',
    },
  ];

  for (const test of tests) {
    await PublicTest.updateOne(
      { title: test.title },
      {
        $set: {
          ...test,
          kind: 'TEST',
          status: 'published',
          // No questions. The public surface never returns them, and seeding
          // them here would imply a guest could reach them.
          sections: [],
          questionCount: 0,
          totalMarks: 0,
          markingScheme: { correct: 4, incorrect: -1, unattempted: 0 },
          createdBy: author._id,
        },
      },
      { upsert: true },
    );
  }
  console.log(`[seed] ${tests.length} public practice tests`);

  await mongoose.disconnect();
  console.log('[seed] done');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
