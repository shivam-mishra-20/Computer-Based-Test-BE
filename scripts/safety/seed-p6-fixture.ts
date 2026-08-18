/**
 * The two-organization fixture the P6 client is validated against.
 *
 * ── Where this runs, and where it must not ──────────────────────────────────
 * A SCRATCH database, never production. The live `abhigyangurukul` database has
 * zero Org, Plan and Subscription documents — P1 through P5 deliberately never
 * migrated it — and seeding organizations into it would be exactly the
 * production data migration this whole programme is forbidden from performing.
 *
 * So the target database name is required to differ from the production one,
 * and the script refuses rather than warns. A warning is something you read
 * after the write.
 *
 * ── What it builds ──────────────────────────────────────────────────────────
 *
 *   ORG 001  Abhigyan Gurukull — a faithful copy of its SHAPE, not its data.
 *            Classes 7–12, its fifteen subjects, its eleven rooms at their real
 *            capacities, Advanced/Basic batches, +1/0/0 marking. No
 *            subscription, so it resolves to every module — which is what an
 *            unsubscribed organization does, and is what makes it the control.
 *
 *   ORG 002  ABC Coaching Institute — deliberately different in every dimension
 *            the client is supposed to read. Different colours, different
 *            classes INCLUDING a non-numeric "dropper", four subjects instead
 *            of fifteen, halls and labs instead of numbered rooms, competitive
 *            marking, a restricted plan that withholds AI and question import.
 *
 * The differences are chosen so that a client which ignored the context would
 * FAIL VISIBLY rather than pass by coincidence: an eleven-room picker cannot be
 * mistaken for a four-hall one, and "dropper" is the value that the old
 * digit-extracting class normalizer silently dropped.
 *
 * Idempotent: every write is an upsert keyed on a stable identifier, so it can
 * be re-run against a fixture that is already there.
 *
 *   P6_MONGO_URI=mongodb+srv://.../p6_client_platform_web_scratch \
 *     node -r ./scripts/safety/dns-preload.js -r ts-node/register/transpile-only \
 *          scripts/safety/seed-p6-fixture.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { registerTenancy, withoutTenantScope } from '../../src/core/tenancy';
import { CURRICULUM_SUBJECTS } from '../../src/config/subjects';
import { ROOMS, ROOM_CAPACITY } from '../../src/models/RoomAllocation';
import { assignRoles, createCustomRole, provisionSystemRoles } from '../../src/core/rbac/provisionRoles';
import { assertNotProduction } from './lib';

export const ORG_001 = {
  slug: 'abhigyan',
  name: 'Abhigyan Gurukull',
  password: 'P6-fixture-abhigyan!',
  emails: {
    admin: 'p6.admin@abhigyan.fixture',
    teacher: 'p6.teacher@abhigyan.fixture',
    student: 'p6.student@abhigyan.fixture',
  },
};

export const ORG_002 = {
  slug: 'abc-coaching',
  name: 'ABC Coaching Institute',
  password: 'P6-fixture-abc!',
  emails: {
    admin: 'p6.admin@abc.fixture',
    teacher: 'p6.teacher@abc.fixture',
    student: 'p6.student@abc.fixture',
  },
};

/** ABC's plan withholds these. The client must hide what they drive. */
export const ABC_WITHHELD_MODULES = ['ai', 'aiAnalysis', 'questionImport', 'integrations'];

/**
 * A deliberately narrow role, present in BOTH organizations.
 *
 * It exists so the browser suite can prove that the client hides what a role
 * cannot do, independently of what the organization's plan includes — the two
 * are different reasons for a screen to be absent, and a suite that only ever
 * varied the plan would never notice if the permission side had been wired to
 * nothing.
 */
export const FRONT_DESK = {
  key: 'p6_front_desk',
  name: 'Front Desk',
  permissions: [
    'students.read',
    'students.create',
    'students.update',
    'attendance.read',
    'attendance.mark',
    'schedule.read',
    'announcements.read',
  ],
  email: (slug: string) => `p6.frontdesk@${slug}.fixture`,
};

function targetUri(): string {
  const uri = process.env.P6_MONGO_URI;
  if (!uri) throw new Error('P6_MONGO_URI must name the scratch database to seed.');
  const production = process.env.MONGO_URI;
  if (!production) throw new Error('MONGO_URI must be set so the guard knows what production is.');

  // The SHARED guard the other safety scripts use, not a bespoke one. It
  // refuses the production host+database AND requires the target name to carry
  // a scratch marker, so a typo lands on a refusal rather than on the live
  // database. A second, weaker guard sitting next to a stronger one is how the
  // stronger one eventually gets bypassed.
  assertNotProduction(uri, production);
  return uri;
}

async function upsertOrg(spec: {
  slug: string;
  name: string;
  branding: Record<string, unknown>;
  locale: Record<string, unknown>;
  domains: string[];
}): Promise<string> {
  const Org = require('../../src/models/Org').default;
  const doc = await Org.findOneAndUpdate(
    { slug: spec.slug },
    {
      $set: {
        name: spec.name,
        slug: spec.slug,
        status: 'active',
        branding: spec.branding,
        locale: spec.locale,
        domains: spec.domains,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return String(doc._id);
}

async function upsertUser(spec: {
  orgId: string;
  name: string;
  email: string;
  password: string;
  role: string;
  classLevel?: string;
  batch?: string;
}): Promise<string> {
  const User = require('../../src/models/User').default;
  const existing = await User.findOne({ orgId: spec.orgId, email: spec.email });
  if (existing) {
    // Assigned rather than $set: the password needs the schema's pre-save hash,
    // and an update pipeline would store it in clear.
    existing.name = spec.name;
    existing.password = spec.password;
    existing.role = spec.role;
    existing.status = 'approved';
    if (spec.classLevel) existing.classLevel = spec.classLevel;
    if (spec.batch) existing.batch = spec.batch;
    await existing.save();
    return String(existing._id);
  }
  const created = new User({
    orgId: spec.orgId,
    name: spec.name,
    email: spec.email,
    password: spec.password,
    role: spec.role,
    status: 'approved',
    classLevel: spec.classLevel,
    batch: spec.batch,
  });
  await created.save();
  return String(created._id);
}

async function replaceConfig(
  orgId: string,
  config: {
    classLevels: { key: string; label: string; aliases: string[]; order: number }[];
    subjects: string[];
    rooms: { name: string; capacity: number }[];
    batches: { name: string; classLevels: string[] }[];
  },
) {
  const ClassLevel = require('../../src/models/ClassLevel').default;
  const Subject = require('../../src/models/Subject').default;
  const OrgRoom = require('../../src/models/OrgRoom').default;
  const Batch = require('../../src/models/Batch').default;

  for (const level of config.classLevels) {
    await ClassLevel.findOneAndUpdate(
      { orgId, key: level.key },
      { $set: { ...level, orgId, isActive: true } },
      { upsert: true, setDefaultsOnInsert: true },
    );
  }
  await ClassLevel.deleteMany({ orgId, key: { $nin: config.classLevels.map((c) => c.key) } });

  for (const [order, name] of config.subjects.entries()) {
    await Subject.findOneAndUpdate(
      { orgId, name },
      { $set: { orgId, name, order, isActive: true } },
      { upsert: true, setDefaultsOnInsert: true },
    );
  }
  await Subject.deleteMany({ orgId, name: { $nin: config.subjects } });

  for (const [order, room] of config.rooms.entries()) {
    await OrgRoom.findOneAndUpdate(
      { orgId, name: room.name },
      { $set: { orgId, name: room.name, capacity: room.capacity, order, isActive: true } },
      { upsert: true, setDefaultsOnInsert: true },
    );
  }
  await OrgRoom.deleteMany({ orgId, name: { $nin: config.rooms.map((r) => r.name) } });

  for (const batch of config.batches) {
    await Batch.findOneAndUpdate(
      { orgId, name: batch.name },
      { $set: { orgId, name: batch.name, classLevels: batch.classLevels } },
      { upsert: true, setDefaultsOnInsert: true },
    );
  }
  await Batch.deleteMany({ orgId, name: { $nin: config.batches.map((b) => b.name) } });
}

async function main() {
  const uri = targetUri();
  registerTenancy();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });
  console.log(`connected to scratch database: ${mongoose.connection.name}\n`);

  await withoutTenantScope('p6:seed-fixture', async () => {
    const Plan = require('../../src/models/Plan').default;
    const Subscription = require('../../src/models/Subscription').default;
    const OrgPolicy = require('../../src/models/OrgPolicy').default;
    const Entitlement = require('../../src/models/Entitlement').default;
    const { allModuleKeys } = require('../../src/core/entitlements/moduleRegistry');

    // ── ORG 001 ────────────────────────────────────────────────────────────
    const org001 = await upsertOrg({
      slug: ORG_001.slug,
      name: ORG_001.name,
      // No branding configured. That is the point: Abhigyan must render in the
      // palette that shipped, proving branding applies only when set.
      branding: {},
      locale: { timezone: 'Asia/Kolkata', currency: 'INR', language: 'English' },
      domains: ['abhigyan.localtest.me'],
    });
    console.log(`ORG 001  ${ORG_001.name}  ${org001}`);

    await replaceConfig(org001, {
      classLevels: ['7', '8', '9', '10', '11', '12'].map((key, order) => ({
        key,
        label: `Class ${key}`,
        aliases: [key, `Class ${key}`, `class ${key}`],
        order,
      })),
      subjects: [...CURRICULUM_SUBJECTS],
      rooms: ROOMS.map((name) => ({ name, capacity: ROOM_CAPACITY[name] ?? 20 })),
      batches: [
        { name: 'Advanced/Basic', classLevels: ['9', '10'] },
        { name: 'Aarambh', classLevels: ['11', '12'] },
        { name: 'Sankalp', classLevels: ['11', '12'] },
      ],
    });
    // No OrgPolicy: Abhigyan runs on PLATFORM_DEFAULTS, which are a
    // transcription of its own current behaviour. Writing one would prove less.
    // No Subscription either: an unsubscribed organization resolves to every
    // module, which is the pre-commerce behaviour this control depends on.
    await Subscription.deleteMany({ orgId: org001 });
    await Entitlement.deleteMany({ orgId: org001 });

    // ── ORG 002 ────────────────────────────────────────────────────────────
    const org002 = await upsertOrg({
      slug: ORG_002.slug,
      name: ORG_002.name,
      branding: {
        primaryColor: '#E8590C',
        accentColor: '#1B3A5C',
        secondaryColor: '#FFB020',
        appName: 'ABC Coaching',
        tagline: 'Focused preparation',
      },
      locale: { timezone: 'Asia/Kolkata', currency: 'INR', language: 'English' },
      domains: ['abc.localtest.me'],
    });
    console.log(`ORG 002  ${ORG_002.name}  ${org002}`);

    await replaceConfig(org002, {
      classLevels: [
        { key: '9', label: 'Class 9', aliases: ['9', 'Class 9'], order: 0 },
        { key: '10', label: 'Class 10', aliases: ['10', 'Class 10'], order: 1 },
        { key: '11', label: 'Class 11', aliases: ['11', 'Class 11'], order: 2 },
        { key: '12', label: 'Class 12', aliases: ['12', 'Class 12'], order: 3 },
        // The value the old digit-extracting normalizer resolved to null.
        { key: 'dropper', label: 'Dropper', aliases: ['dropper', 'Dropper', 'Drop'], order: 4 },
      ],
      subjects: ['Physics', 'Chemistry', 'Mathematics', 'Biology'],
      rooms: [
        { name: 'Hall A', capacity: 60 },
        { name: 'Hall B', capacity: 45 },
        { name: 'Lab 1', capacity: 24 },
        { name: 'Lab 2', capacity: 24 },
      ],
      batches: [
        { name: 'Foundation', classLevels: ['9', '10'] },
        { name: 'JEE Main', classLevels: ['11', '12'] },
        { name: 'JEE Advanced', classLevels: ['11', '12'] },
        { name: 'NEET', classLevels: ['11', '12', 'dropper'] },
      ],
    });

    // A restricted plan. `allModuleKeys()` minus the withheld ones, so the plan
    // tracks the registry rather than freezing a list that drifts from it.
    const planModules = (allModuleKeys() as string[]).filter(
      (key) => !ABC_WITHHELD_MODULES.includes(key),
    );
    const plan = await Plan.findOneAndUpdate(
      { key: 'p6-standard' },
      {
        $set: {
          key: 'p6-standard',
          name: 'Standard (P6 fixture)',
          description: 'Everything except AI and question import.',
          modules: planModules,
          limits: { students: 500, teachers: 30, storageGb: 50 },
          price: { monthly: 9000, annual: 90000, currency: 'INR' },
          isPublic: true,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    // `planId`, not a plan key: resolution loads the plan by id
    // (`Plan.findById(subscription.planId)`), so a key here resolves to no plan
    // at all and the organization silently drops to the eight core modules.
    await Subscription.findOneAndUpdate(
      { orgId: org002 },
      {
        $set: {
          orgId: org002,
          planId: plan._id,
          status: 'active',
          addOns: [],
          removals: [],
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    // Force a re-resolution rather than trusting a cached snapshot.
    await Entitlement.deleteMany({ orgId: org002 });

    await OrgPolicy.findOneAndUpdate(
      { orgId: org002 },
      {
        $set: {
          orgId: org002,
          exam: {
            markingScheme: { correct: 4, incorrect: -1, unattempted: 0 },
            submitLockPercent: 75,
            defaultDurationMins: 180,
            violationThreshold: 3,
          },
          // Cleared deliberately: the Advanced/Basic merge is Abhigyan's rule,
          // and an institute with no such batches should not inherit it.
          batch: { mergeRules: [] },
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );

    // ── Roles and users ────────────────────────────────────────────────────
    for (const [orgId, spec] of [
      [org001, ORG_001],
      [org002, ORG_002],
    ] as const) {
      await provisionSystemRoles(orgId);
      const Role = require('../../src/models/Role').default;
      const adminRole = await Role.findOne({ orgId, key: 'admin' }).select('_id').lean();
      const adminRoleId = adminRole ? String(adminRole._id) : null;

      const adminId = await upsertUser({
        orgId,
        name: `${spec.name} Admin`,
        email: spec.emails.admin,
        password: spec.password,
        role: 'admin',
      });
      // Assigned a REAL role, so `/api/me/context` reports
      // `permissionSource: 'roles'` rather than falling through to the
      // legacy-role bridge. The bridge is correct for existing accounts and
      // wrong as a fixture: it would grant every permission regardless of what
      // the role actually says, and a narrow role would then be untestable.
      if (adminRoleId) await assignRoles(adminId, [adminRoleId]);
      await upsertUser({
        orgId,
        name: `${spec.name} Teacher`,
        email: spec.emails.teacher,
        password: spec.password,
        role: 'teacher',
      });
      await upsertUser({
        orgId,
        name: `${spec.name} Student`,
        email: spec.emails.student,
        password: spec.password,
        role: 'student',
        classLevel: orgId === org002 ? '11' : '11',
        batch: orgId === org002 ? 'JEE Main' : 'Aarambh',
      });
      const deskRole = await createCustomRole(orgId, {
        key: FRONT_DESK.key,
        name: FRONT_DESK.name,
        description: 'Reception — enrolment and attendance, no academic authority.',
        permissions: FRONT_DESK.permissions,
      });
      const deskId = await upsertUser({
        orgId,
        name: `${spec.name} Front Desk`,
        email: FRONT_DESK.email(spec.slug),
        password: spec.password,
        // The legacy ROLE is admin so the route guard lets them in; the
        // assigned RBAC role is what narrows what they see. That separation is
        // the whole point — without it the test could not tell a permission
        // gate from a role redirect.
        role: 'admin',
      });
      await assignRoles(deskId, [deskRole.id]);

      console.log(
        `  seeded 4 users + system roles for ${spec.slug} ` +
          `(front desk: ${deskRole.granted.length} granted, ${deskRole.rejected.length} rejected)`,
      );
    }

    console.log(`\nORG_001_ID=${org001}`);
    console.log(`ORG_002_ID=${org002}`);
    console.log(`ABC plan withholds: ${ABC_WITHHELD_MODULES.join(', ')}`);
    console.log(`ABC modules: ${planModules.length} of ${(allModuleKeys() as string[]).length}`);
  });

  await mongoose.disconnect();
  console.log('\nfixture ready.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('seed-p6-fixture failed:', error);
    process.exit(1);
  });
}
