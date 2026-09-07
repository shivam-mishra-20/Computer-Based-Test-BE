/**
 * Content for the P7 mobile fixture: questions, an exam, notifications and an
 * offline result, for BOTH organizations.
 *
 * ── Why a second seeder rather than extending the P6 one ────────────────────
 * `seed-p6-fixture.ts` builds CONFIGURATION — organizations, plans, class
 * levels, subjects, rooms, batches, roles, users. It is what makes two tenants
 * exist. This builds the DATA those tenants hold, which is what makes the
 * mobile screens have anything to render.
 *
 * Keeping them apart means the configuration fixture stays re-runnable without
 * churning content, and a content bug cannot force a re-onboarding.
 *
 * ── The content is deliberately distinguishable ─────────────────────────────
 * Each organization's questions, exam title and notifications name that
 * organization. A screen showing the wrong tenant's data therefore fails
 * visibly, rather than looking plausible — which is the entire reason a
 * two-tenant fixture is worth building.
 *
 *   P6_MONGO_URI=<scratch> node -r ./scripts/safety/dns-preload.js \
 *     -r ts-node/register/transpile-only scripts/safety/seed-p7-content.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { registerTenancy, runWithTenant, withoutTenantScope } from '../../src/core/tenancy';
import { assertNotProduction } from './lib';
import { ORG_001, ORG_002 } from './seed-p6-fixture';

process.env.REDIS_ENABLED = 'false';

interface OrgContent {
  slug: string;
  subject: string;
  classLevel: string;
  batch: string;
  /** Appears in every seeded record, so a leak is obvious on screen. */
  marker: string;
  examTitle: string;
}

const CONTENT: OrgContent[] = [
  {
    slug: ORG_001.slug,
    subject: 'Physics',
    classLevel: '11',
    batch: 'Aarambh',
    marker: 'AG',
    examTitle: 'AG Physics Unit Test',
  },
  {
    slug: ORG_002.slug,
    subject: 'Chemistry',
    classLevel: '11',
    batch: 'JEE Main',
    marker: 'ABC',
    examTitle: 'ABC Chemistry Mock',
  },
];

function questionsFor(content: OrgContent) {
  return [
    {
      text: `${content.marker} Q1 — Which quantity is a vector?`,
      options: [
        { text: 'Speed', isCorrect: false },
        { text: 'Velocity', isCorrect: true },
        { text: 'Mass', isCorrect: false },
        { text: 'Temperature', isCorrect: false },
      ],
    },
    {
      text: `${content.marker} Q2 — The SI unit of force is?`,
      options: [
        { text: 'Joule', isCorrect: false },
        { text: 'Watt', isCorrect: false },
        { text: 'Newton', isCorrect: true },
        { text: 'Pascal', isCorrect: false },
      ],
    },
    {
      text: `${content.marker} Q3 — Which is a noble gas?`,
      options: [
        { text: 'Oxygen', isCorrect: false },
        { text: 'Nitrogen', isCorrect: false },
        { text: 'Argon', isCorrect: true },
        { text: 'Hydrogen', isCorrect: false },
      ],
    },
  ];
}

async function main() {
  const uri = process.env.P6_MONGO_URI;
  if (!uri) throw new Error('P6_MONGO_URI must name the scratch database.');
  assertNotProduction(uri, process.env.MONGO_URI as string);

  registerTenancy();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });
  console.log(`connected to ${mongoose.connection.name}\n`);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Org = require('../../src/models/Org').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const User = require('../../src/models/User').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Question = require('../../src/models/Question').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Exam = require('../../src/models/Exam').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Notification = require('../../src/models/Notification').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Attempt = require('../../src/models/Attempt').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getClassQuestionModel } = require('../../src/models/ClassQuestion');

  for (const content of CONTENT) {
    const org = await withoutTenantScope('p7:find-org', () =>
      Org.findOne({ slug: content.slug }).select('_id name').lean(),
    );
    if (!org) throw new Error(`Organization "${content.slug}" not found — run p6:seed first.`);
    const orgId = String(org._id);

    // Everything below runs inside the organization's own context, so the
    // tenancy plugin stamps orgId on every write without any of it being
    // passed explicitly. Getting that wrong is the bug this fixture exists to
    // catch, so the fixture must not work around it.
    await runWithTenant({ orgId, userId: null, source: 'claim' }, async () => {
      const teacher = await User.findOne({ orgId, role: 'teacher' }).select('_id').lean();
      const student = await User.findOne({ orgId, role: 'student' }).select('_id').lean();
      if (!teacher || !student) throw new Error(`Missing seeded users for ${content.slug}.`);

      // ── Questions, in BOTH banks ─────────────────────────────────────────
      // This platform has two question stores and they are not interchangeable:
      //
      //   Question            the general bank. `GET /api/exams/questions`
      //                       reads it, and `subject` lives under `tags`.
      //   class_<n>           per-class collections. An exam that carries a
      //                       `classLevel` resolves its questions from HERE
      //                       (attemptService), and `subject` is at the root.
      //
      // Seeding only the general bank produced an attempt whose `questions`
      // dictionary came back empty — the player opened, the palette showed
      // three questions, and every one of them rendered "(no text)". The exam's
      // question ids must therefore be the CLASS collection's ids.
      const ClassQuestion = getClassQuestionModel(content.classLevel);

      const questionIds: mongoose.Types.ObjectId[] = [];
      for (const spec of questionsFor(content)) {
        const existingClass = await ClassQuestion.findOne({ orgId, text: spec.text }).select('_id');
        if (existingClass) {
          questionIds.push(existingClass._id);
        } else {
          const created = await ClassQuestion.create({
            orgId,
            text: spec.text,
            type: 'mcq',
            options: spec.options,
            subject: content.subject,
            classLevel: content.classLevel,
            difficulty: 'medium',
            createdBy: teacher._id,
            isActive: true,
          });
          questionIds.push(created._id);
        }

        // The same content in the general bank, so the question-bank screen has
        // something to show when no class is selected.
        const existingGeneral = await Question.findOne({ orgId, text: spec.text }).select('_id');
        if (!existingGeneral) {
          await Question.create({
            orgId,
            text: spec.text,
            type: 'mcq',
            options: spec.options,
            // `subject` lives under `tags` here, not at the root. An analytics
            // aggregation in this codebase once grouped on `q.subject` and
            // returned nothing for exactly this reason.
            tags: { subject: content.subject, difficulty: 'medium' },
            meta: { class: content.classLevel },
            createdBy: teacher._id,
            isActive: true,
          });
        }
      }

      // ── An exam that is live right now ───────────────────────────────────
      const now = Date.now();
      // No `orgId` in the payload: the tenancy plugin adds it via
      // `$setOnInsert`, and passing it in `$set` as well makes MongoDB reject
      // the whole update with ConflictingUpdateOperators. Letting the plugin do
      // its job is also the point — a fixture that stamps orgId by hand would
      // pass even if the plugin were broken.
      const examPayload = {
        title: content.examTitle,
        description: `Seeded for the P7 mobile fixture (${content.marker}).`,
        createdBy: teacher._id,
        sections: [{ title: content.subject, questionIds, shuffleQuestions: false }],
        totalDurationMins: 30,
        mode: 'live',
        // Started an hour ago and running for a day, so the attempt player is
        // reachable whenever this suite runs. A window relative to `now` beats
        // a fixed date that silently expires.
        schedule: {
          startAt: new Date(now - 60 * 60 * 1000),
          endAt: new Date(now + 24 * 60 * 60 * 1000),
          timezone: 'Asia/Kolkata',
        },
        classLevel: content.classLevel,
        batch: content.batch,
        isPublished: true,
        antiCheat: true,
        // Assigned to the student directly. Group-based assignment depends on
        // the digit-vs-"Class N" spelling that has bitten this platform before;
        // an explicit user id is unambiguous and this fixture is about the
        // client, not about assignment resolution.
        assignedTo: { users: [student._id], groups: [] },
      };

      const exam = await Exam.findOneAndUpdate(
        { orgId, title: content.examTitle },
        { $set: examPayload },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      // A stale attempt from a previous run would make the exam show as
      // "submitted" and the player unreachable.
      await Attempt.deleteMany({ orgId, examId: exam._id, userId: student._id });

      // ── Notifications ────────────────────────────────────────────────────
      const alerts = [
        {
          type: 'exam',
          title: `${content.marker}: ${content.examTitle} is live`,
          message: `Your ${content.subject} test is open now.`,
        },
        {
          type: 'announcement',
          title: `${content.marker}: Welcome`,
          message: `Notifications from ${org.name} appear here.`,
        },
      ];
      for (const alert of alerts) {
        await Notification.findOneAndUpdate(
          { orgId, userId: student._id, title: alert.title },
          { $set: { ...alert, userId: student._id, isRead: false } },
          { upsert: true, setDefaultsOnInsert: true },
        );
      }

      console.log(
        `${content.slug}: ${questionIds.length} questions · exam "${exam.title}" · ${alerts.length} notifications`,
      );
    });
  }

  await mongoose.disconnect();
  console.log('\ncontent ready.');
}

main().catch((error) => {
  console.error('seed-p7-content failed:', error);
  process.exit(1);
});
