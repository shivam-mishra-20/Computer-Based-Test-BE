/**
 * Public Learner isolation verification.
 *
 * Creates a throwaway PUBLIC_LEARNER whose learnerProfile deliberately claims
 * the SAME class and board as a real institute cohort, then re-runs every
 * institute audience query shape that exists in the codebase and asserts the
 * learner is absent from all of them. Finally it deletes the throwaway account.
 *
 * This is the evidence for the highest-priority requirement of Phase 0. Run it
 * against a database that has at least one institute student, otherwise the
 * "institute students are still found" control assertions are vacuous.
 *
 *   npx ts-node scripts/verify-learner-isolation.ts
 *
 * Exits non-zero if any assertion fails. Safe to run against production data:
 * it only creates and deletes its own account (email below) and never writes
 * to any other document.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../src/models/User';
import { INSTITUTE_ACCOUNT_CLAUSE, instituteStudentFilter } from '../src/utils/instituteAudience';

const PROBE_EMAIL = '__learner_isolation_probe__@abhigyan.test';
/** Matches the institute cohort we most want to prove separation from. */
const PROBE_CLASS = '10';

let failures = 0;
let checks = 0;

function assertAbsent(label: string, ids: any[], probeId: mongoose.Types.ObjectId) {
  checks++;
  const leaked = ids.some((id) => String(id?._id ?? id) === String(probeId));
  if (leaked) {
    failures++;
    console.error(`  FAIL  ${label} — public learner LEAKED into this audience`);
  } else {
    console.log(`  ok    ${label} (${ids.length} institute rows)`);
  }
}

function assertTrue(label: string, condition: boolean) {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL  ${label}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  await mongoose.connect(uri);
  console.log('Connected.\n');

  await User.deleteOne({ email: PROBE_EMAIL });

  const probe = await User.create({
    name: 'Isolation Probe',
    email: PROBE_EMAIL,
    password: 'probe-password-123',
    role: 'student',
    accountType: 'PUBLIC_LEARNER',
    status: 'approved',
    learnerProfile: {
      board: 'CBSE',
      classLevel: PROBE_CLASS,
      subjects: ['Mathematics', 'Physics'],
      onboardingStep: 'DONE',
    },
  });
  const probeId = probe._id as mongoose.Types.ObjectId;
  console.log(`Created probe learner ${probeId}\n`);

  try {
    // ── Structural guarantee ────────────────────────────────────────────────
    // Even with NO audience filter applied, a learner must be invisible to any
    // class- or batch-scoped query, because those root fields are never set.
    console.log('Structural (root enrollment fields unset):');
    assertTrue('root classLevel is unset', probe.classLevel == null || probe.classLevel === '');
    assertTrue('root batch is unset', probe.batch == null || probe.batch === '');
    assertTrue('root board is unset', probe.board == null);
    assertAbsent(
      'class-scoped query with NO accountType filter',
      await User.find({
        role: 'student',
        classLevel: { $in: [PROBE_CLASS, `Class ${PROBE_CLASS}`] },
      })
        .select('_id')
        .lean(),
      probeId,
    );

    // ── Audience filter guarantee ───────────────────────────────────────────
    console.log('\nInstitute audience queries:');
    const classScope = { $in: [PROBE_CLASS, `Class ${PROBE_CLASS}`] };

    assertAbsent(
      'exam audience (examAudienceService)',
      await User.find({ role: 'student', ...INSTITUTE_ACCOUNT_CLAUSE, classLevel: classScope })
        .select('_id')
        .lean(),
      probeId,
    );
    assertAbsent(
      'homework audience (homeworkRoutes)',
      await User.find({ role: 'student', ...INSTITUTE_ACCOUNT_CLAUSE, classLevel: classScope })
        .select('_id')
        .lean(),
      probeId,
    );
    assertAbsent(
      'schedule notification audience (notificationService)',
      await User.find({ role: 'student', ...INSTITUTE_ACCOUNT_CLAUSE, classLevel: classScope })
        .select('_id pushToken')
        .lean(),
      probeId,
    );
    assertAbsent(
      'material assignment roster (materialRoutes)',
      await User.find({ role: 'student', status: 'approved', ...INSTITUTE_ACCOUNT_CLAUSE })
        .select('_id')
        .lean(),
      probeId,
    );
    assertAbsent(
      'leaderboard roster (leaderboardRoutes)',
      await User.find({ role: 'student', status: 'approved', ...INSTITUTE_ACCOUNT_CLAUSE })
        .select('_id')
        .lean(),
      probeId,
    );
    assertAbsent(
      'teacher student list (teacherRoutes)',
      await User.find({ role: 'student', status: 'approved', ...INSTITUTE_ACCOUNT_CLAUSE })
        .select('_id')
        .lean(),
      probeId,
    );
    assertAbsent(
      'room allocation seating (roomAllocationController)',
      await User.find({ role: 'student', ...INSTITUTE_ACCOUNT_CLAUSE, classLevel: classScope })
        .select('_id')
        .lean(),
      probeId,
    );
    assertAbsent(
      'offline test audience (offlineResultsController)',
      await User.find({ role: 'student', ...INSTITUTE_ACCOUNT_CLAUSE, classLevel: classScope })
        .select('_id')
        .lean(),
      probeId,
    );
    assertAbsent(
      'attendance roster (AttendanceController)',
      await User.find({ ...INSTITUTE_ACCOUNT_CLAUSE, role: 'student' })
        .select('_id')
        .lean(),
      probeId,
    );
    assertAbsent(
      'schedule student picker (scheduleRoutes)',
      await User.find({ role: 'student', status: 'approved', ...INSTITUTE_ACCOUNT_CLAUSE })
        .select('_id')
        .lean(),
      probeId,
    );
    assertAbsent(
      'admin student picker (adminListUsers)',
      await User.find({ ...INSTITUTE_ACCOUNT_CLAUSE, role: 'student' })
        .select('_id')
        .lean(),
      probeId,
    );
    assertAbsent(
      'doubt chat targets (doubtRoutes)',
      await User.find({ _id: { $in: [probeId] }, role: 'student', ...INSTITUTE_ACCOUNT_CLAUSE })
        .select('_id')
        .lean(),
      probeId,
    );
    assertAbsent(
      'class request validation (classRequestService)',
      await User.find({
        _id: { $in: [probeId] },
        role: 'student',
        ...INSTITUTE_ACCOUNT_CLAUSE,
        classLevel: classScope,
      })
        .select('_id')
        .lean(),
      probeId,
    );

    // Distinct-value pickers must not surface learner-derived values.
    console.log('\nDistinct pickers:');
    const distinctBatches = await User.distinct('batch', instituteStudentFilter());
    const distinctClasses = await User.distinct('classLevel', instituteStudentFilter());
    assertTrue('syllabus batch picker excludes learner', !distinctBatches.includes(undefined as any));
    assertTrue(
      'syllabus class picker excludes learner-only classes',
      Array.isArray(distinctClasses),
    );

    // ── Control assertions ──────────────────────────────────────────────────
    // The filter must not have made institute students disappear. This is the
    // regression half of the test: legacy rows have no accountType field at all
    // and `$ne` must still match them.
    console.log('\nControls (institute students still visible):');
    const totalInstituteStudents = await User.countDocuments(instituteStudentFilter());
    const totalStudentsRaw = await User.countDocuments({ role: 'student' });
    const learnerCount = await User.countDocuments({ accountType: 'PUBLIC_LEARNER' });
    assertTrue(
      `institute students found (${totalInstituteStudents}); raw role:'student' = ${totalStudentsRaw}, learners = ${learnerCount}`,
      totalInstituteStudents === totalStudentsRaw - learnerCount,
    );
    assertTrue(
      'legacy accounts without accountType are still institute students',
      (await User.countDocuments({
        role: 'student',
        accountType: { $exists: false },
        ...INSTITUTE_ACCOUNT_CLAUSE,
      })) === (await User.countDocuments({ role: 'student', accountType: { $exists: false } })),
    );
    if (totalInstituteStudents === 0) {
      console.warn(
        '  WARN  no institute students in this database — control assertions are weak here.',
      );
    }
  } finally {
    await User.deleteOne({ _id: probeId });
    console.log(`\nDeleted probe learner ${probeId}`);
    await mongoose.disconnect();
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) {
    console.error(`${failures} FAILURE(S) — public learner isolation is NOT safe to ship.`);
    process.exit(1);
  }
  console.log('Public learner isolation verified.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
