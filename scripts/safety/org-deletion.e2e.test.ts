/**
 * Deleting an organization — proved against a real database and real storage.
 *
 * Every assertion is made by COUNTING: documents in MongoDB, objects in the
 * storage bucket. Nothing about the deletion is mocked. The one scripted piece
 * is the EAS CLI (through `__setEasRunner`, the seam the build pipeline's tests
 * use): a real `eas project:delete` would delete a real Expo project, and the
 * point of these cases is what the platform does with Expo's ANSWER — which
 * includes Expo refusing. The dummy EXPO_TOKEN set below guarantees that even a
 * broken seam could not reach a real Expo account.
 *
 * What must hold:
 *   · only the owner role (`org.delete`) can preview or delete; others, and
 *     tenant tokens, are refused;
 *   · a live, platform-owned, pinned or building organization cannot be deleted;
 *   · the plan's counts are the database's counts — including a collection no
 *     model describes, ObjectId-typed `orgId`s, and the app's own `reg_`
 *     collection — and never include the registry or the platform audit log;
 *   · a malformed confirmation deletes nothing; a request cannot name what to
 *     delete or which organization;
 *   · a failure mid-run is visible, audited and resumable; rows written during
 *     the run are found by the verification rescan and deleted;
 *   · Expo refusing leaves the deletion INCOMPLETE — data gone, organization
 *     kept as a stripped record — and a retry that finds the project gone, or an
 *     explicit operator decision, finishes it; neither claims what did not happen;
 *   · a project another organization uses is never deleted;
 *   · Organization Y — same collections, same bucket — is untouched, row for
 *     row and file for file, and unattributed rows are untouched;
 *   · a deletion that stalled when a process died resumes on boot;
 *   · storage prefixes outside `organizations/<id>/` and `applications/<id>/`
 *     are refused before the bucket is touched.
 *
 *   npx ts-node --transpile-only scripts/safety/org-deletion.e2e.test.ts --scratch-suffix scratch_app
 */

import { bootScratchApp, Checks, request } from './e2eHarness';

const RUN = `zz-del-${process.pid}`;
const PASSWORD = 'Del!E2E-Passw0rd';
const UNMODELLED = 'zz_del_unmodelled';
const PROJECT_X = '1a2b3c4d-0000-4000-8000-00000000000a';
const PROJECT_SHARED = '1a2b3c4d-0000-4000-8000-00000000000b';
const PROJECT_Z = '1a2b3c4d-0000-4000-8000-00000000000c';

async function main() {
  const t = new Checks();
  const { port, dbName, mongoose, close } = await bootScratchApp({
    // A value that is not a token: nothing here may reach a real Expo account.
    EXPO_TOKEN: 'e2e-not-a-real-token',
    EXPO_ACCOUNT: 'zz-e2e-account',
  });

  /* eslint-disable @typescript-eslint/no-var-requires */
  const { withoutTenantScope } = require('../../src/core/tenancy/context');
  const { signPlatformToken, signSessionToken } = require('../../src/core/auth/tokens');
  const { setAppExperience } = require('../../src/core/platform/appExperience');
  const { __setEasRunner } = require('../../src/core/platform/easClient');
  const deletion = require('../../src/core/platform/orgDeletion');
  const storage = require('../../src/core/storage/storageService');
  const Org = require('../../src/models/Org').default;
  const PlatformUser = require('../../src/models/PlatformUser').default;
  /* eslint-enable @typescript-eslint/no-var-requires */

  const db = mongoose.connection.db!;
  const { ObjectId } = mongoose.Types;
  const unscoped = <T>(fn: () => Promise<T>) => withoutTenantScope('e2e:org-delete', fn) as Promise<T>;
  const col = (name: string) => db.collection(name);

  // ── The scripted EAS CLI ────────────────────────────────────────────────────
  const easCalls: string[][] = [];
  let easAnswer: (args: string[]) => { stdout: string; stderr: string; exitCode: number } = () => ({
    stdout: '',
    stderr: 'no answer scripted',
    exitCode: 1,
  });
  __setEasRunner(async (args: string[]) => {
    easCalls.push(args);
    return easAnswer(args);
  });
  const SUDO = {
    stdout: '',
    stderr:
      'Error: Deleting a project requires a session in sudo mode. Run this command interactively to confirm your password, then retry in non-interactive mode while sudo mode is active.',
    exitCode: 1,
  };
  const gone = (id: string) => ({ stdout: '', stderr: `[GraphQL] Experience with id '${id}' does not exist.`, exitCode: 1 });

  const fixtureOrgIds = async (): Promise<string[]> =>
    (await unscoped(() => Org.find({ slug: { $regex: '^zz-del-' } }).select('_id').lean())).map((o: any) => String(o._id));
  const storagePrefixesSeen = new Set<string>();

  const cleanup = async () => {
    const ids = await fixtureOrgIds();
    const both = ids.flatMap((id) => [id, new ObjectId(id)]);
    for (const name of ['users', 'guardianlinks', 'exams', 'attempts', 'notifications', 'entitlements', 'organizationregistrations', 'appbuildjobs', 'platformaudits']) {
      await col(name).deleteMany({ orgId: { $in: both } }).catch(() => undefined);
    }
    await col('users').deleteMany({ email: { $regex: '^zz-del-' } }).catch(() => undefined);
    await unscoped(() => PlatformUser.deleteMany({ email: { $regex: '^zz-del-' } }));
    for (const id of ids) storagePrefixesSeen.add(`organizations/${id}/`);
    for (const prefix of storagePrefixesSeen) await storage.deleteStoragePrefix(prefix).catch(() => undefined);
    await unscoped(() => Org.deleteMany({ slug: { $regex: '^zz-del-' } }));
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c: any) => c.name as string);
    for (const name of names.filter((n) => n === UNMODELLED || n.startsWith('reg_zz_del_'))) {
      await db.dropCollection(name).catch(() => undefined);
    }
  };

  /** Everything an organization owns, by collection — the independent count. */
  const ownedCounts = async (orgId: string) => {
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c: any) => c.name as string)
      .filter((n) => !n.startsWith('system.') && n !== 'orgs' && n !== 'platformaudits' && !n.startsWith('reg_'))
      .sort();
    const out: Record<string, number> = {};
    for (const name of names) {
      const n = await col(name).countDocuments({ orgId: { $in: [orgId, new ObjectId(orgId)] } });
      if (n) out[name] = n;
    }
    return out;
  };
  const exists = async (name: string) => (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;

  try {
    await cleanup();
    console.log(`\nORGANIZATION DELETION  (db: ${dbName})`);

    /* ══ Fixtures ═══════════════════════════════════════════════════════════ */
    t.section('fixtures');
    const makeOrg = (key: string, extra: Record<string, unknown> = {}) =>
      unscoped(() =>
        Org.create({
          name: `Deletion ${key.toUpperCase()} Institute`,
          slug: `${RUN}-${key}`,
          status: 'suspended',
          branding: { appName: `Deletion ${key.toUpperCase()}` },
          ...extra,
        }),
      );
    const X = String((await makeOrg('x', { status: 'active', mobile: { androidPackage: `com.zzdel.x.p${process.pid}`, easProjectId: PROJECT_X, easOwner: 'zz-e2e-account' } }))._id);
    const Y = String((await makeOrg('y', { status: 'active', mobile: { androidPackage: `com.zzdel.y.p${process.pid}`, easProjectId: PROJECT_SHARED, easOwner: 'zz-e2e-account' } }))._id);
    const W = String((await makeOrg('w', { mobile: { easProjectId: PROJECT_SHARED, easOwner: 'zz-e2e-account' } }))._id);
    const Z = String((await makeOrg('z', { mobile: { easProjectId: PROJECT_Z, easOwner: 'zz-e2e-account' } }))._id);
    const V = String((await makeOrg('v'))._id);
    const S = String((await makeOrg('s'))._id);
    const P = String((await makeOrg('p', { isPlatformOwned: true }))._id);
    const slugOf = (key: string) => `${RUN}-${key}`;

    await setAppExperience(X, { registrationPolicy: 'open', roles: { student: true } });
    await setAppExperience(Y, { registrationPolicy: 'open', roles: { student: true } });
    const regOf = async (id: string) =>
      (await unscoped(() => Org.findById(id).select('registrationStore').lean()))?.registrationStore?.collection as string;
    const regX = await regOf(X);
    const regY = await regOf(Y);

    const seed = async (orgId: string, key: string, n: { users: number; exams: number; attempts: number; notes: number; unmodelled: number; reg: number; regCol?: string }) => {
      const oid = new ObjectId(orgId);
      const users = Array.from({ length: n.users }, (_, i) => ({ name: `Del ${key}${i}`, email: `${RUN}-${key}-${i}@example.test`, role: i === 0 ? 'student' : 'teacher', status: 'approved', orgId }));
      const inserted = await col('users').insertMany(users);
      const firstUser = inserted.insertedIds[0];
      await col('guardianlinks').insertOne({ orgId, parentId: new ObjectId(), studentId: firstUser, status: 'verified', method: 'student-code+phone' });
      const exams = await col('exams').insertMany(Array.from({ length: n.exams }, (_, i) => ({ title: `${RUN} ${key} exam ${i}`, orgId })));
      await col('attempts').insertMany(Array.from({ length: n.attempts }, () => ({ userId: firstUser, examId: exams.insertedIds[0], orgId, resultPublished: true })));
      await col('notifications').insertMany(Array.from({ length: n.notes }, (_, i) => ({ title: `${RUN} note ${i}`, orgId })));
      await col('entitlements').insertOne({ orgId: oid, modules: [], limits: {} });
      await col(UNMODELLED).insertMany(Array.from({ length: n.unmodelled }, (_, i) => ({ orgId, i })));
      if (n.regCol) await col(n.regCol).insertMany(Array.from({ length: n.reg }, (_, i) => ({ email: `${RUN}-${key}-reg${i}@example.test` })));
      await col('platformaudits').insertOne({ action: 'e2e.fixture', orgId, createdAt: new Date() });
    };
    await seed(X, 'x', { users: 3, exams: 2, attempts: 3, notes: 2, unmodelled: 2, reg: 2, regCol: regX });
    await seed(Y, 'y', { users: 2, exams: 1, attempts: 1, notes: 1, unmodelled: 1, reg: 1, regCol: regY });
    for (const [id, key] of [[W, 'w'], [Z, 'z'], [V, 'v'], [S, 's']] as const) {
      await col('users').insertOne({ name: `Del ${key}`, email: `${RUN}-${key}-0@example.test`, role: 'student', orgId: id });
    }
    // A row nobody owns, in a shared collection and in the unmodelled one.
    await col('users').insertOne({ name: 'Del unowned', email: `${RUN}-unowned@example.test`, role: 'student' });
    await col(UNMODELLED).insertOne({ note: 'no organization' });
    // ObjectId-typed ownership, as the platform models store it.
    const application = await col('organizationregistrations').insertOne({ orgId: new ObjectId(X), orgSlug: slugOf('x'), status: 'approved', institute: { name: RUN } });
    await col('appbuildjobs').insertOne({ orgId: new ObjectId(X), status: 'succeeded', platform: 'android', profile: 'preview' });

    // Real objects in the real bucket.
    const put = (orgId: string, name: string) =>
      storage.putTenantFile({ buffer: Buffer.from(`${RUN} ${name}`), fileName: `${name}.txt`, contentType: 'text/plain', module: 'materials', orgId, requireOrg: true });
    for (let i = 0; i < 3; i++) await put(X, `x${i}`);
    for (let i = 0; i < 2; i++) await put(Y, `y${i}`);
    await storage.putApplicationAsset({ buffer: Buffer.from(RUN), applicationId: String(application.insertedId), fileName: 'logo.txt', contentType: 'text/plain', kind: 'logo' });
    const prefixX = `organizations/${X}/`;
    const prefixY = `organizations/${Y}/`;
    const prefixApp = `applications/${application.insertedId}/`;
    [prefixX, prefixY, prefixApp].forEach((p) => storagePrefixesSeen.add(p));
    t.check(
      'fixtures: 3 + 1 files for X, 2 for Y, in the real bucket',
      (await storage.countStoragePrefix(prefixX)) === 3 && (await storage.countStoragePrefix(prefixApp)) === 1 && (await storage.countStoragePrefix(prefixY)) === 2,
    );
    const yBefore = await ownedCounts(Y);
    const unownedBefore = (await col('users').countDocuments({ orgId: { $exists: false } })) + (await col(UNMODELLED).countDocuments({ orgId: { $exists: false } }));

    /* ══ 1. Who may delete ══════════════════════════════════════════════════ */
    t.section('who may delete');
    const staff = async (role: string) => {
      const u = await unscoped(() => PlatformUser.create({ name: `Del ${role}`, email: `${RUN}-${role}@platform.test`, password: PASSWORD, role }));
      return { id: String(u._id), token: signPlatformToken({ id: String(u._id), role, tokenVersion: 0 }) as string };
    };
    const owner = await staff('owner');
    const engineer = await staff('engineer');
    const billing = await staff('billing');
    const preview = (org: string, token?: string) => request(port, 'GET', `/api/platform/orgs/${org}/deletion/preview`, { token });
    const start = (org: string, token: string, body: unknown) => request(port, 'POST', `/api/platform/orgs/${org}/deletion`, { token, body });
    t.check('no token → 401', (await preview(X)).status === 401);
    const tenantToken = signSessionToken({ id: String(new ObjectId()), role: 'admin', orgId: X });
    t.check("an organization administrator's token → refused", [401, 403].includes((await preview(X, tenantToken)).status));
    t.check('engineer (no org.delete) → 403', (await preview(X, engineer.token)).status === 403);
    t.check('billing (no org.delete) → 403', (await preview(X, billing.token)).status === 403);
    const engStart = await start(X, engineer.token, { confirmSlug: slugOf('x'), acknowledge: true, planToken: 'x' });
    t.check('...and cannot start one', engStart.status === 403, `${engStart.status}`);

    /* ══ 2. What blocks a deletion ══════════════════════════════════════════ */
    t.section('what blocks a deletion');
    const live = await preview(X, owner.token);
    t.check(
      'an active organization: blocked, and no confirmation token issued',
      live.status === 200 && live.json?.plan?.blockers?.some((b: string) => /Suspend/.test(b)) && live.json?.planToken === null,
      live.raw.slice(0, 300),
    );
    const pinnedBefore = process.env.ORG_ID;
    process.env.ORG_ID = S;
    const pinned = await preview(S, owner.token);
    if (pinnedBefore === undefined) delete process.env.ORG_ID;
    else process.env.ORG_ID = pinnedBefore;
    t.check('the organization this server is pinned to: blocked', pinned.json?.plan?.blockers?.some((b: string) => /pinned/.test(b)), pinned.raw.slice(0, 300));
    const owned = await preview(P, owner.token);
    t.check('a platform-owned organization: blocked', owned.json?.plan?.blockers?.some((b: string) => /owned by the platform/.test(b)));
    const build = await col('appbuildjobs').insertOne({ orgId: new ObjectId(V), status: 'building', platform: 'android', profile: 'preview' });
    const building = await preview(V, owner.token);
    await col('appbuildjobs').deleteOne({ _id: build.insertedId });
    t.check('an organization with a build running: blocked', building.json?.plan?.blockers?.some((b: string) => /build is still running/.test(b)));
    const notFound = await preview(String(new ObjectId()), owner.token);
    const malformed = await preview('not-an-id', owner.token);
    t.check('an unknown or malformed organization id → 404', notFound.status === 404 && malformed.status === 404, `${notFound.status} ${malformed.status}`);
    const suspend = await request(port, 'POST', `/api/platform/orgs/${X}/status`, { token: owner.token, body: { status: 'suspended' } });
    t.check('suspending X through the console route', suspend.status === 200);

    /* ══ 3. The plan is the database ════════════════════════════════════════ */
    t.section('the plan is the database');
    const pv = await preview(X, owner.token);
    const plan = pv.json?.plan;
    const step = (key: string) => plan?.steps?.find((s: any) => s.key === key);
    const xCounts = await ownedCounts(X);
    t.check('no blockers now, and a confirmation token', plan?.blockers?.length === 0 && typeof pv.json?.planToken === 'string', pv.raw.slice(0, 300));
    t.check(
      'every collection holding X’s rows is a step, with the database’s count',
      Object.entries(xCounts).every(([name, n]) => step(`documents:${name}`)?.planned === n),
      JSON.stringify({ xCounts, steps: plan?.steps?.map((s: any) => [s.key, s.planned]) }),
    );
    t.check('...including a collection no model describes', step(`documents:${UNMODELLED}`)?.planned === 2);
    t.check('...and ObjectId-typed ownership', step('documents:entitlements')?.planned === 1 && step('documents:organizationregistrations')?.planned === 1 && step('documents:appbuildjobs')?.planned === 1);
    t.check('the app’s own registration collection is dropped whole', step(`collection:${regX}`)?.planned === 2);
    t.check('files: the organization’s prefix and its application’s', step(`storage:${prefixX}`)?.planned === 3 && step(`storage:${prefixApp}`)?.planned === 1);
    t.check('the Expo project is listed as external', step(`external:expo:${PROJECT_X}`)?.resource?.fullName === `@zz-e2e-account/${slugOf('x')}`);
    t.check(
      'never the registry, the platform audit log, or another organization’s collection',
      !plan?.steps?.some((s: any) => /:(orgs|platformaudits)$/.test(s.key) || s.key === `collection:${regY}`),
    );
    t.check('totals are the sum of the steps', plan?.totals?.documents === Object.values(xCounts).reduce((a: number, b: number) => a + b, 0));

    /* ══ 4. Confirmation ════════════════════════════════════════════════════ */
    t.section('a malformed confirmation deletes nothing');
    const token = pv.json.planToken as string;
    const refusals: [string, unknown][] = [
      ['a wrong slug', { confirmSlug: slugOf('y'), acknowledge: true, planToken: token }],
      ['the slug in different case', { confirmSlug: slugOf('x').toUpperCase(), acknowledge: true, planToken: token }],
      ['no acknowledgement', { confirmSlug: slugOf('x'), planToken: token }],
      ['acknowledgement as a string', { confirmSlug: slugOf('x'), acknowledge: 'true', planToken: token }],
      ['no preview token', { confirmSlug: slugOf('x'), acknowledge: true }],
      ["another organization's token", { confirmSlug: slugOf('x'), acknowledge: true, planToken: deletion.issuePlanToken(Y, owner.id) }],
      ["another staff member's token", { confirmSlug: slugOf('x'), acknowledge: true, planToken: deletion.issuePlanToken(X, engineer.id) }],
      ['an expired token', { confirmSlug: slugOf('x'), acknowledge: true, planToken: deletion.issuePlanToken(X, owner.id, Date.now() - 20 * 60 * 1000) }],
      ['a forged token', { confirmSlug: slugOf('x'), acknowledge: true, planToken: `${Date.now() + 60000}.${'0'.repeat(64)}` }],
    ];
    for (const [label, body] of refusals) {
      const r = await start(X, owner.token, body);
      t.check(`${label} → 400`, r.status === 400, `${r.status} ${r.raw.slice(0, 200)}`);
    }
    t.check('...and every row is still there', JSON.stringify(await ownedCounts(X)) === JSON.stringify(xCounts));
    t.check('...and no deletion was recorded', !(await unscoped(() => Org.findById(X).lean()))?.deletion);

    /* ══ 5. A failure part-way, and resuming ════════════════════════════════ */
    t.section('a failure part-way is visible and resumable');
    easAnswer = () => SUDO;
    deletion.__deletionTestHooks.failAtStep = 'documents:users';
    const begun = await start(X, owner.token, {
      confirmSlug: slugOf('x'),
      acknowledge: true,
      planToken: token,
      // None of this is read: what is deleted comes from the server's own scan.
      orgId: Y,
      collections: ['orgs', 'platformaudits', regY],
      steps: [{ key: 'documents:orgs', kind: 'documents' }],
    });
    t.check('a valid confirmation starts it in the background (202)', begun.status === 202, begun.raw.slice(0, 200));
    const frozen = await request(port, 'POST', `/api/platform/orgs/${X}/status`, { token: owner.token, body: { status: 'active' } });
    t.check('while deleting, the organization cannot be reactivated', frozen.status === 409 && frozen.json?.code === 'ORG_DELETING', `${frozen.status}`);
    await deletion.settled(X);
    const failed = await request(port, 'GET', `/api/platform/orgs/${X}/deletion`, { token: owner.token });
    t.check('the run stops at the failed step, and says which', failed.json?.state === 'failed' && failed.json?.deletion?.failedStep === 'documents:users', failed.raw.slice(0, 300));
    t.check('files were already removed (storage runs first)', (await storage.countStoragePrefix(prefixX)) === 0 && (await storage.countStoragePrefix(prefixApp)) === 0);
    t.check('users were not — the deletion is visibly partial, not silently done', (await col('users').countDocuments({ orgId: X })) === 3);
    t.check('the organization is still there', Boolean(await unscoped(() => Org.findById(X).lean())));
    t.check('the failure is in the platform audit log', (await col('platformaudits').countDocuments({ orgId: X, action: 'org.delete.failed' })) === 1);
    // A row written for X while the deletion was stopped, in a step already done.
    await col('notifications').insertOne({ title: `${RUN} late`, orgId: X });
    const resumed = await request(port, 'POST', `/api/platform/orgs/${X}/deletion/resume`, { token: owner.token });
    t.check('resume → 202', resumed.status === 202, resumed.raw);
    await deletion.settled(X);

    /* ══ 6. Expo refuses: incomplete, honestly ══════════════════════════════ */
    t.section('Expo refuses → incomplete, never "done"');
    const inc = await request(port, 'GET', `/api/platform/orgs/${X}/deletion`, { token: owner.token });
    const ext = inc.json?.deletion?.steps?.find((s: any) => s.kind === 'external');
    t.check('state is incomplete', inc.json?.state === 'incomplete', inc.raw.slice(0, 300));
    t.check('...the project is marked orphaned, with Expo’s reason', ext?.outcome === 'orphaned' && /sudo/.test(ext?.reason ?? ''), JSON.stringify(ext));
    t.check(
      'Expo was asked for exactly this project, by the name derived from the organization',
      easCalls.some((a) => a.join(' ') === `project:delete ${PROJECT_X} --dangerously-confirm-deletion @zz-e2e-account/${slugOf('x')} --non-interactive --json`),
      JSON.stringify(easCalls),
    );
    t.check('every row X owned is gone', Object.keys(await ownedCounts(X)).length === 0, JSON.stringify(await ownedCounts(X)));
    t.check(
      '...including the row written mid-deletion (found by the rescan)',
      (inc.json?.deletion?.steps?.find((s: any) => s.key === 'documents:notifications')?.removed ?? 0) === 3,
    );
    t.check('the app’s registration collection is dropped', !(await exists(regX)));
    const tomb = await unscoped(() => Org.findById(X).lean());
    t.check(
      'the organization remains as a stripped record naming what is left',
      Boolean(tomb) && tomb.status === 'suspended' && !tomb.mobile && !tomb.registrationStore,
      JSON.stringify({ status: tomb?.status, mobile: tomb?.mobile, reg: tomb?.registrationStore }),
    );
    t.check(
      'audit says incomplete, and does not say completed',
      (await col('platformaudits').countDocuments({ orgId: X, action: 'org.delete.incomplete' })) === 1 &&
        (await col('platformaudits').countDocuments({ orgId: X, action: 'org.delete.completed' })) === 0,
    );
    const blocked = await preview(X, owner.token);
    t.check('it cannot be started again from scratch', blocked.json?.plan?.blockers?.some((b: string) => /already deleted/.test(b)));

    t.section('...until the project is gone');
    easAnswer = () => gone(PROJECT_X);
    await request(port, 'POST', `/api/platform/orgs/${X}/deletion/resume`, { token: owner.token });
    await deletion.settled(X);
    const done = await request(port, 'GET', `/api/platform/orgs/${X}/deletion`, { token: owner.token });
    t.check(
      'a retry that finds the project gone completes it',
      done.json?.state === 'completed' && done.json?.summary?.result === 'completed' && done.json?.summary?.external?.[0]?.outcome === 'deleted',
      done.raw.slice(0, 400),
    );
    t.check('the organization record is gone', !(await unscoped(() => Org.findById(X).lean())));
    t.check('the platform audit log keeps its history of X', (await col('platformaudits').countDocuments({ orgId: X, action: 'e2e.fixture' })) === 1);
    const summaryText = JSON.stringify(done.json?.summary ?? {});
    t.check('the completion record carries counts, not people', !/@example\.test|Del x/.test(summaryText), summaryText.slice(0, 300));
    t.check('resuming a finished deletion → 404', (await request(port, 'POST', `/api/platform/orgs/${X}/deletion/resume`, { token: owner.token })).status === 404);
    await deletion.runDeletion(X);
    t.check('running it again is a no-op', !(await unscoped(() => Org.findById(X).lean())) && Object.keys(await ownedCounts(X)).length === 0);

    /* ══ 7. Organization Y, untouched ═══════════════════════════════════════ */
    t.section('Organization Y is untouched');
    t.check('every one of Y’s rows, collection by collection', JSON.stringify(await ownedCounts(Y)) === JSON.stringify(yBefore), JSON.stringify({ before: yBefore, after: await ownedCounts(Y) }));
    t.check('Y’s files', (await storage.countStoragePrefix(prefixY)) === 2);
    t.check('Y’s registration collection and its record', (await exists(regY)) && (await col(regY).countDocuments({})) === 1);
    t.check('Y’s organization record and Expo project', (await unscoped(() => Org.findById(Y).lean()))?.mobile?.easProjectId === PROJECT_SHARED);
    const unownedAfter = (await col('users').countDocuments({ orgId: { $exists: false } })) + (await col(UNMODELLED).countDocuments({ orgId: { $exists: false } }));
    t.check('rows no organization owns are untouched', unownedAfter === unownedBefore, `${unownedBefore} → ${unownedAfter}`);

    /* ══ 8. A shared project, an explicit finish, a race, a crash ══════════ */
    t.section('a project another organization uses is never deleted');
    const callsBefore = easCalls.length;
    const pw = await preview(W, owner.token);
    await start(W, owner.token, { confirmSlug: slugOf('w'), acknowledge: true, planToken: pw.json?.planToken });
    await deletion.settled(W);
    const w = await deletion.deletionStatus(W);
    t.check(
      'W completes; its shared project is reported, not deleted',
      w.state === 'completed' && w.summary?.external?.[0]?.outcome === 'shared' && w.summary?.result === 'completed-with-external-retained',
      JSON.stringify(w),
    );
    t.check('...and Expo was never asked', easCalls.slice(callsBefore).every((a) => !a.includes(PROJECT_SHARED)));

    t.section('finishing without the project is an explicit, recorded decision');
    easAnswer = () => SUDO;
    const pz = await preview(Z, owner.token);
    await start(Z, owner.token, { confirmSlug: slugOf('z'), acknowledge: true, planToken: pz.json?.planToken });
    await deletion.settled(Z);
    t.check('Z ends incomplete', (await deletion.deletionStatus(Z)).state === 'incomplete');
    const finish = (body: unknown) => request(port, 'POST', `/api/platform/orgs/${Z}/deletion/finish`, { token: owner.token, body });
    t.check('finish with a wrong slug → 400', (await finish({ confirmSlug: slugOf('x'), acknowledge: true })).status === 400);
    t.check('finish without acknowledging → 400', (await finish({ confirmSlug: slugOf('z') })).status === 400);
    t.check('an engineer cannot finish it', (await request(port, 'POST', `/api/platform/orgs/${Z}/deletion/finish`, { token: engineer.token, body: { confirmSlug: slugOf('z'), acknowledge: true } })).status === 403);
    t.check('finish, confirmed → 202', (await finish({ confirmSlug: slugOf('z'), acknowledge: true })).status === 202);
    await deletion.settled(Z);
    const z = await deletion.deletionStatus(Z);
    t.check(
      'recorded as completed WITH the project retained — not as deleted',
      z.state === 'completed' && z.summary?.result === 'completed-with-external-retained' && z.summary?.external?.[0]?.outcome === 'retained' && /Left in place by/.test(z.summary?.external?.[0]?.reason ?? ''),
      JSON.stringify(z.summary?.external),
    );

    t.section('two starts at once run once');
    const pvv = await preview(V, owner.token);
    const [r1, r2] = await Promise.all([
      start(V, owner.token, { confirmSlug: slugOf('v'), acknowledge: true, planToken: pvv.json?.planToken }),
      start(V, owner.token, { confirmSlug: slugOf('v'), acknowledge: true, planToken: pvv.json?.planToken }),
    ]);
    t.check('one 202, one 409', [r1.status, r2.status].sort().join(',') === '202,409', `${r1.status} ${r2.status}`);
    await deletion.settled(V);
    t.check('...and V is deleted exactly once', (await deletion.deletionStatus(V)).state === 'completed' && (await col('platformaudits').countDocuments({ orgId: V, action: 'org.delete.completed' })) === 1);

    t.section('a deletion that stalled when its process died resumes on boot');
    deletion.__deletionTestHooks.failAtStep = 'documents:users';
    const pss = await preview(S, owner.token);
    await start(S, owner.token, { confirmSlug: slugOf('s'), acknowledge: true, planToken: pss.json?.planToken });
    await deletion.settled(S);
    // Pretend the process died mid-run: "running", with a heartbeat long gone.
    await unscoped(() => Org.updateOne({ _id: S }, { $set: { 'deletion.status': 'running', 'deletion.heartbeatAt': new Date(Date.now() - 10 * 60 * 1000) } }));
    t.check('a stale run reads as stalled', (await deletion.deletionStatus(S)).state === 'stalled');
    const n = await deletion.resumeStalledDeletions();
    const again = await deletion.resumeStalledDeletions();
    t.check('boot picks it up once', n >= 1 && again === 0, `${n} then ${again}`);
    await deletion.settled(S);
    t.check('...and finishes it', (await deletion.deletionStatus(S)).state === 'completed' && (await col('users').countDocuments({ orgId: S })) === 0);

    /* ══ 9. Storage paths ═══════════════════════════════════════════════════ */
    t.section('storage paths outside an owned prefix are refused before the bucket is touched');
    const refusedPrefixes = ['', 'legacy/', 'organizations/', `organizations/${Y}`, `organizations/${X}/../${Y}/`, 'applications/../', `organizations/${Y}/*`, 'organizations/ZZZZZZZZZZZZZZZZZZZZZZZZ/'];
    for (const p of refusedPrefixes) {
      let refused = false;
      try {
        await storage.deleteStoragePrefix(p);
      } catch (err) {
        refused = (err as Error).name === 'StoragePrefixRefused';
      }
      t.check(`"${p}" → refused`, refused);
    }
    t.check('Y’s files survived every one of those', (await storage.countStoragePrefix(prefixY)) === 2);
  } catch (err) {
    t.check('the suite ran to the end', false, (err as Error).stack ?? String(err));
  } finally {
    deletion.__deletionTestHooks.failAtStep = null;
    __setEasRunner(null);
    await cleanup().catch((e: Error) => console.error('cleanup failed:', e.message));
    let leftFiles = 0;
    for (const prefix of storagePrefixesSeen) leftFiles += await storage.countStoragePrefix(prefix).catch(() => 0);
    const leftOrgs = await fixtureOrgIds();
    t.check('cleanup left no fixture, file or collection behind', leftFiles === 0 && leftOrgs.length === 0 && !(await exists(UNMODELLED)), `${leftFiles} files, ${leftOrgs.length} orgs`);
    await close();
  }
  t.report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
