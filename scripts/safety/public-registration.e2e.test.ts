/**
 * Public registration writes to the configured application's collection, and
 * nowhere else — proved against a real database.
 *
 * ── What this proves ────────────────────────────────────────────────────────
 *
 *     APP A → Organization A → reg_<a>
 *     APP B → Organization B → reg_<b>
 *
 * Registrations are sent over real HTTP to the real Express app, with the same
 * headers the mobile app sends (`X-Org-Id`, `X-App-Id`), and every assertion is
 * made by READING THE COLLECTIONS BACK — never by trusting a response body.
 * Nothing is mocked: the tenancy middleware, the Mongoose plugin, the unique
 * indexes, the transaction and the audit log are all the production code
 * against a real MongoDB.
 *
 * It then tries to break the rule: a request for one organization carrying
 * another's application id, a body naming another organization's collection,
 * a closed organization, a suspended one, an admin role, an unproven parent, a
 * duplicate — and checks, by counting documents, that nothing was written
 * anywhere it should not be.
 *
 * The core A/B routing is run twice, under `warn` AND `enforce`, because a
 * guarantee that holds only while the tenancy plugin happens to be filtering
 * reads is not a guarantee this code provides.
 *
 * ── Where it runs ───────────────────────────────────────────────────────────
 * A scratch database derived from MONGO_URI, refused if it is production. The
 * Atlas cluster has very few free collection slots, so this REUSES the existing
 * scratch database and creates only the three `reg_` collections it needs —
 * then drops them, and every fixture, in a `finally`, including after a crash
 * of a previous run.
 *
 *   npx ts-node --transpile-only scripts/safety/public-registration.e2e.test.ts \
 *     --scratch-suffix scratch_app
 */

import http from 'http';
import { randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import { config } from 'dotenv';
import jwt from 'jsonwebtoken';
import { assertNotProduction, configureDnsForSrv, requireEnv } from './lib';

config();

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

function deriveScratchUri(productionUri: string, suffix: string): string {
  const m = productionUri.match(
    /^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/,
  );
  if (!m) throw new Error('MONGO_URI could not be parsed.');
  return `${m[1]}${m[2]}_${suffix}${m[3] ?? ''}`;
}

interface Res {
  status: number;
  json: any;
  raw: string;
}

function request(
  port: number,
  method: string,
  reqPath: string,
  opts: {
    body?: unknown;
    headers?: Record<string, string>;
    token?: string;
  } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        timeout: 30000,
        headers: {
          ...(opts.headers ?? {}),
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed: any = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode ?? 0, json: parsed, raw });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** A marker unique to this run, so concurrent or crashed runs never collide. */
const RUN = `zz-reg-${process.pid}`;
const MARK_EMAIL = `${RUN}`;
// Generated per run — a throwaway account on a scratch database; never stored.
const PASSWORD = `Tst-${randomBytes(9).toString('hex')}!9Aa`;

async function main() {
  const productionUri = requireEnv('MONGO_URI');
  const suffix = arg('--scratch-suffix') || 'scratch_app';
  const uri = deriveScratchUri(productionUri, suffix);
  assertNotProduction(uri, productionUri);

  configureDnsForSrv();
  process.env.MONGO_URI = uri;
  process.env.TENANT_MODE = 'claim';
  process.env.TENANT_ENFORCEMENT = 'warn';
  process.env.ENABLE_CRON = 'false';
  process.env.PPT_WORKER_EMBEDDED = 'false';
  process.env.REDIS_ENABLED = 'false';
  process.env.AUTH_RATE_LIMIT_MAX = '5000';
  process.env.PUBLIC_FORM_RATE_LIMIT_MAX = '5000';
  process.env.GUARDIAN_VERIFY_MAX = '5000';
  process.env.APP_BUILD_QUEUE_NAME = `app-builds-test-${process.pid}`;
  process.on('unhandledRejection', () => {
    /* mirrors server.ts tolerance */
  });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registerTenancy } = require('../../src/core/tenancy');
  registerTenancy();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mongoose = require('mongoose');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { withoutTenantScope } = require('../../src/core/tenancy/context');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    clearHostResolutionCache,
  } = require('../../src/core/tenancy/hostResolution');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { signPlatformToken } = require('../../src/core/auth/tokens');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { setAppExperience } = require('../../src/core/platform/appExperience');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    registrationModel,
  } = require('../../src/core/registration/registrationStore');
  const Org = require('../../src/models/Org').default;
  const User = require('../../src/models/User').default;
  const AuditLog = require('../../src/models/AuditLog').default;
  const PlatformUser = require('../../src/models/PlatformUser').default;

  const app = require('../../src/app').default || require('../../src/app');
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  const db = mongoose.connection.db;
  const dbName = db.databaseName;

  /** Every collection this run could have created, for cleanup. */
  const regCollections = async (): Promise<string[]> =>
    (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c: { name: string }) => c.name)
      .filter((n: string) => n.startsWith('reg_zz_reg_'));

  const cleanup = async () => {
    await withoutTenantScope('e2e:cleanup', async () => {
      const orgs = await Org.find({ slug: { $regex: '^zz-reg-' } })
        .select('_id')
        .lean();
      const ids = orgs.map((o: { _id: unknown }) => String(o._id));
      const users = await User.find({ email: { $regex: '^zz-reg-' } })
        .select('_id')
        .lean();
      await Promise.all([
        AuditLog.deleteMany({
          userId: { $in: users.map((u: { _id: unknown }) => u._id) },
        }),
        User.deleteMany({ email: { $regex: '^zz-reg-' } }),
        Org.deleteMany({ _id: { $in: ids } }),
        PlatformUser.deleteMany({ email: { $regex: '^zz-reg-' } }),
      ]);
    });
    for (const name of await regCollections()) {
      await db.dropCollection(name).catch(() => undefined);
    }
  };

  const count = async (
    collection: string,
    filter: Record<string, unknown> = {},
  ) =>
    withoutTenantScope('e2e:count', async () =>
      registrationModel(collection).countDocuments(filter),
    );

  try {
    await cleanup(); // anything a crashed earlier run left behind

    /* ══ Fixtures ═══════════════════════════════════════════════════════ */
    console.log(`\nPUBLIC REGISTRATION  (db: ${dbName})\n`);
    console.log('fixtures');

    const makeOrg = (key: string, status = 'active') =>
      withoutTenantScope('e2e:org', async () =>
        Org.create({
          name: `Registration ${key.toUpperCase()} Institute`,
          slug: `${RUN}-${key}`,
          status,
          branding: {
            appName: `Registration ${key.toUpperCase()}`,
            tagline: `Org ${key}`,
          },
          mobile: { androidPackage: `com.zzreg.${key}.p${process.pid}` },
        }),
      );

    const [orgA, orgB, orgC, orgD, orgS] = await Promise.all([
      makeOrg('a'),
      makeOrg('b'),
      makeOrg('c'),
      makeOrg('d'),
      makeOrg('s', 'suspended'),
    ]);
    const A = String(orgA._id),
      B = String(orgB._id),
      C = String(orgC._id),
      D = String(orgD._id),
      S = String(orgS._id);
    const appOf = (key: string) => `com.zzreg.${key}.p${process.pid}`;

    // Configured through the SAME write path the console and onboarding use.
    await setAppExperience(A, {
      registrationPolicy: 'approval',
      roles: { student: true, teacher: true, parent: true },
      authCopy: {
        supportEmail: 'help@a.example',
        registerMessage: 'Join Institute A.',
      },
    });
    await setAppExperience(B, {
      registrationPolicy: 'open',
      roles: { student: true, teacher: true },
    });
    await setAppExperience(C, {
      registrationPolicy: 'invite',
      authCopy: { registerMessage: 'C creates accounts itself.' },
    });
    await setAppExperience(D, {
      registrationPolicy: 'open',
      roles: { student: true, teacher: false },
    });
    // Suspended, with an open policy written directly — status must win.
    await withoutTenantScope('e2e:org-s', async () =>
      Org.updateOne(
        { _id: S },
        { $set: { appExperience: { registrationPolicy: 'open' } } },
      ),
    );

    const storeOf = async (id: string) =>
      (
        await withoutTenantScope('e2e:store', async () =>
          Org.findById(id).select('registrationStore').lean(),
        )
      )?.registrationStore?.collection as string | undefined;
    const [colA, colB, colC, colD] = await Promise.all([
      storeOf(A),
      storeOf(B),
      storeOf(C),
      storeOf(D),
    ]);

    check(
      'opening registration provisions a dedicated collection for A',
      Boolean(colA && colA.startsWith('reg_')),
      String(colA),
    );
    check(
      '...and a different one for B',
      Boolean(colB && colB.startsWith('reg_') && colB !== colA),
      `${colA} / ${colB}`,
    );
    check(
      'a closed organization is given no collection at all',
      colC === undefined,
      String(colC),
    );
    const existing = (await regCollections()).sort();
    check(
      'the collections really exist in the database',
      [colA, colB, colD].every((c) => existing.includes(c as string)),
      existing.join(', '),
    );

    const headersFor = (
      org: string,
      appId?: string,
    ): Record<string, string> => ({
      'X-Org-Id': org,
      ...(appId ? { 'X-App-Id': appId } : {}),
    });
    const person = (tag: string, extra: Record<string, unknown> = {}) => ({
      name: `Reg ${tag}`,
      email: `${MARK_EMAIL}-${tag}@example.test`,
      phone: '9876543210',
      password: PASSWORD,
      registrationSource: 'mobile',
      ...extra,
    });
    const register = (org: string, appId: string | undefined, body: unknown) =>
      request(port, 'POST', '/api/auth/register', {
        headers: headersFor(org, appId),
        body,
      });

    /** Every response body this run sees, to prove none of them leak storage. */
    const seen: string[] = [];
    const track = (r: Res) => {
      seen.push(r.raw);
      return r;
    };

    /* ══ 1. The policy the app reads ════════════════════════════════════ */
    console.log('\nwhat each app is told');
    process.env.ALLOW_PUBLIC_REGISTER = 'true';
    clearHostResolutionCache();

    const polA = track(
      await request(port, 'GET', '/api/auth/registration-policy', {
        headers: headersFor(A),
      }),
    );
    const polB = track(
      await request(port, 'GET', '/api/auth/registration-policy', {
        headers: headersFor(B),
      }),
    );
    const polC = track(
      await request(port, 'GET', '/api/auth/registration-policy', {
        headers: headersFor(C),
      }),
    );
    const polX = track(
      await request(port, 'GET', '/api/auth/registration-policy', {
        headers: headersFor(`${RUN}-nope`),
      }),
    );
    check(
      'A is open, with approval, for students, teachers and parents',
      polA.json?.open === true &&
        polA.json?.studentApprovalRequired === true &&
        JSON.stringify(polA.json?.roles) ===
          JSON.stringify(['student', 'teacher', 'parent']),
      polA.raw,
    );
    check(
      '...and B, which did not ask for Parent, does not offer it',
      !polB.json?.roles?.includes('parent'),
      polB.raw,
    );
    check(
      'B is open without approval',
      polB.json?.open === true && polB.json?.studentApprovalRequired === false,
      polB.raw,
    );
    check(
      'C is closed, with its own words',
      polC.json?.open === false &&
        polC.json?.reason === 'closed' &&
        polC.json?.message === 'C creates accounts itself.',
      polC.raw,
    );
    check(
      'an unknown app is told so',
      polX.json?.open === false && polX.json?.reason === 'unknown-application',
      polX.raw,
    );

    /* ══ 2. The deployment gate ═════════════════════════════════════════ */
    console.log('\nthe deployment gate');
    process.env.ALLOW_PUBLIC_REGISTER = 'false';
    const gated = track(await register(A, appOf('a'), person('gated')));
    check(
      'with the gate off, an open organization still refuses',
      gated.status === 405,
      `${gated.status} ${gated.raw}`,
    );
    check(
      '...and nothing was written',
      (await count(colA as string)) === 0 &&
        !(await withoutTenantScope('e2e:u', async () =>
          User.exists({ email: person('gated').email }),
        )),
    );
    const polGated = track(
      await request(port, 'GET', '/api/auth/registration-policy', {
        headers: headersFor(A),
      }),
    );
    check(
      '...and the app is told why',
      polGated.json?.open === false && polGated.json?.reason === 'deployment',
    );
    process.env.ALLOW_PUBLIC_REGISTER = 'true';

    /* ══ 3. A → A, B → B, under warn AND enforce ════════════════════════ */
    for (const mode of ['warn', 'enforce'] as const) {
      console.log(`\nrouting, TENANT_ENFORCEMENT=${mode}`);
      process.env.TENANT_ENFORCEMENT = mode;
      const beforeA = await count(colA as string);
      const beforeB = await count(colB as string);

      const ra = track(await register(A, appOf('a'), person(`a-${mode}`)));
      check(
        `A's student is accepted and left pending (${mode})`,
        ra.status === 201 && ra.json?.status === 'pending' && !ra.json?.token,
        `${ra.status} ${ra.raw}`,
      );

      const rb = track(await register(B, appOf('b'), person(`b-${mode}`)));
      check(
        `B's student is accepted and active, with a session (${mode})`,
        rb.status === 201 &&
          rb.json?.status === 'approved' &&
          typeof rb.json?.token === 'string',
        `${rb.status} ${rb.raw}`,
      );

      check(
        `A's registration is in A's collection (${mode})`,
        (await count(colA as string, { email: person(`a-${mode}`).email })) ===
          1,
      );
      check(
        `...and NOT in B's (${mode})`,
        (await count(colB as string, { email: person(`a-${mode}`).email })) ===
          0,
      );
      check(
        `B's registration is in B's collection (${mode})`,
        (await count(colB as string, { email: person(`b-${mode}`).email })) ===
          1,
      );
      check(
        `...and NOT in A's (${mode})`,
        (await count(colA as string, { email: person(`b-${mode}`).email })) ===
          0,
      );
      check(
        `each collection grew by exactly one (${mode})`,
        (await count(colA as string)) === beforeA + 1 &&
          (await count(colB as string)) === beforeB + 1,
      );

      if (rb.json?.token) {
        const claims = jwt.decode(rb.json.token) as {
          orgId?: string;
          role?: string;
        } | null;
        check(
          `B's session belongs to B (${mode})`,
          claims?.orgId === B && claims?.role === 'student',
          JSON.stringify(claims),
        );
      }
    }
    process.env.TENANT_ENFORCEMENT = 'warn';

    /* ══ 4. Traceability ════════════════════════════════════════════════ */
    console.log('\ntraceability');
    const recA = await withoutTenantScope('e2e:rec', async () =>
      registrationModel(colA as string)
        .findOne({ email: person('a-warn').email })
        .lean(),
    );
    const userA = await withoutTenantScope('e2e:user', async () =>
      User.findOne({ email: person('a-warn').email }).lean(),
    );
    check(
      'the record carries its organization and application',
      recA?.orgId === A &&
        recA?.applicationId === appOf('a') &&
        recA?.policy === 'approval',
      JSON.stringify(recA),
    );
    check(
      'the account is in the platform store, stamped with A, pending',
      userA?.orgId === A &&
        userA?.status === 'pending' &&
        userA?.role === 'student',
      JSON.stringify(userA && { orgId: userA.orgId, status: userA.status }),
    );
    check(
      'account and record point at each other',
      String(recA?.userId) === String(userA?._id) &&
        String(userA?.registrationId) === String(recA?._id),
    );
    check(
      'no password is kept in the registration record',
      recA && !('password' in recA),
    );
    check(
      'the password on the account is hashed',
      typeof userA?.password === 'string' &&
        userA.password !== PASSWORD &&
        userA.password.startsWith('$2'),
    );
    const audit = await withoutTenantScope('e2e:audit', async () =>
      AuditLog.findOne({
        userId: userA?._id,
        action: 'auth.public-registration',
      }).lean(),
    );
    check(
      'the registration is audited, against organization A',
      audit?.orgId === A,
      JSON.stringify(audit && { orgId: audit.orgId }),
    );

    /* ══ 5. Trying to cross the line ════════════════════════════════════ */
    console.log('\ncross-organization manipulation');
    const snapshot = async () => ({
      a: await count(colA as string),
      b: await count(colB as string),
      d: await count(colD as string),
      users: await withoutTenantScope('e2e:users', async () =>
        User.countDocuments({ email: { $regex: '^zz-reg-' } }),
      ),
    });
    const same = (x: Record<string, number>, y: Record<string, number>) =>
      JSON.stringify(x) === JSON.stringify(y);

    let before = await snapshot();
    const mixed = track(await register(B, appOf('a'), person('mixed')));
    check(
      "B's hint with A's application is refused",
      mixed.status === 400 && mixed.json?.code === 'APPLICATION_MISMATCH',
      `${mixed.status} ${mixed.raw}`,
    );
    check(
      '...and nothing was written anywhere',
      same(before, await snapshot()),
    );

    before = await snapshot();
    const steered = track(
      await register(
        A,
        appOf('a'),
        person('steered', {
          orgId: B,
          organizationId: B,
          collection: colB,
          store: colB,
          applicationId: appOf('b'),
          status: 'approved',
          role: 'student',
        }),
      ),
    );
    check(
      'a body naming B’s organization and collection is accepted for A only',
      steered.status === 201,
      `${steered.status} ${steered.raw}`,
    );
    const after = await snapshot();
    check(
      '...it landed in A’s collection',
      after.a === before.a + 1 && after.b === before.b,
    );
    const steeredUser = await withoutTenantScope('e2e:u2', async () =>
      User.findOne({ email: person('steered').email }).lean(),
    );
    check(
      '...as an A account, still pending — the body’s status was ignored',
      steeredUser?.orgId === A && steeredUser?.status === 'pending',
      JSON.stringify(
        steeredUser && { orgId: steeredUser.orgId, status: steeredUser.status },
      ),
    );
    const steeredRec = await withoutTenantScope('e2e:r2', async () =>
      registrationModel(colA as string)
        .findOne({ email: person('steered').email })
        .lean(),
    );
    check(
      '...recording A’s application, not the one in the body',
      steeredRec?.applicationId === appOf('a'),
      String(steeredRec?.applicationId),
    );

    before = await snapshot();
    const closed = track(await register(C, appOf('c'), person('closed')));
    check(
      'a closed organization refuses',
      closed.status === 403 && closed.json?.code === 'REGISTRATION_CLOSED',
      `${closed.status} ${closed.raw}`,
    );
    check(
      '...with its own message',
      closed.json?.message === 'C creates accounts itself.',
    );
    check('...and nothing was written', same(before, await snapshot()));

    /* ══ 6. Invalid applications ════════════════════════════════════════ */
    console.log('\ninvalid applications');
    before = await snapshot();
    const unknown = track(
      await register(`${RUN}-nope`, undefined, person('unknown')),
    );
    check(
      'an unknown organization is refused',
      unknown.status === 400 && unknown.json?.code === 'UNKNOWN_APPLICATION',
      `${unknown.status} ${unknown.raw}`,
    );
    const none = track(
      await request(port, 'POST', '/api/auth/register', {
        body: person('none'),
      }),
    );
    check(
      'a request naming no organization is refused',
      none.status === 400 && none.json?.code === 'UNKNOWN_APPLICATION',
      `${none.status} ${none.raw}`,
    );
    const suspended = track(await register(S, appOf('s'), person('suspended')));
    check(
      'a suspended organization is refused, whatever its policy says',
      suspended.status === 400 &&
        suspended.json?.code === 'UNKNOWN_APPLICATION',
      `${suspended.status} ${suspended.raw}`,
    );
    check('...and none of them wrote anything', same(before, await snapshot()));

    /* ══ 7. Roles ═══════════════════════════════════════════════════════ */
    console.log('\nroles');
    before = await snapshot();
    const admin = track(
      await register(A, appOf('a'), person('admin', { role: 'admin' })),
    );
    check(
      'admin is refused outright',
      admin.status === 403 && admin.json?.code === 'ROLE_NOT_ALLOWED',
      `${admin.status} ${admin.raw}`,
    );
    const parent = track(
      await register(A, appOf('a'), person('parent', { role: 'parent' })),
    );
    check(
      'a parent with no proof of a student is refused, with the one generic answer',
      parent.status === 400 && parent.json?.code === 'WARD_NOT_VERIFIED',
      `${parent.status} ${parent.raw}`,
    );
    const parentB = track(
      await register(B, appOf('b'), person('parent-b', { role: 'parent' })),
    );
    check(
      'a parent is refused where the organization did not enable parents',
      parentB.status === 400 && parentB.json?.code === 'ROLE_NOT_AVAILABLE',
      `${parentB.status} ${parentB.raw}`,
    );
    const teacherD = track(
      await register(D, appOf('d'), person('teacher-d', { role: 'teacher' })),
    );
    check(
      'a teacher is refused where the organization did not enable teachers',
      teacherD.status === 400 && teacherD.json?.code === 'ROLE_NOT_AVAILABLE',
      `${teacherD.status} ${teacherD.raw}`,
    );
    const garbage = track(
      await register(A, appOf('a'), person('garbage', { role: 'principal' })),
    );
    check(
      'an invented role is refused, not downgraded',
      garbage.status === 400 && garbage.json?.code === 'ROLE_NOT_AVAILABLE',
    );
    check(
      '...and no refused role wrote anything',
      same(before, await snapshot()),
    );

    const teacherB = track(
      await register(B, appOf('b'), person('teacher-b', { role: 'teacher' })),
    );
    check(
      'a teacher under an OPEN policy is still left pending',
      teacherB.status === 201 && teacherB.json?.status === 'pending',
      `${teacherB.status} ${teacherB.raw}`,
    );
    check('...with no session issued', !teacherB.json?.token);
    const teacherUser = await withoutTenantScope('e2e:t', async () =>
      User.findOne({ email: person('teacher-b').email }).lean(),
    );
    check(
      '...as a pending teacher account in B',
      teacherUser?.role === 'teacher' &&
        teacherUser?.status === 'pending' &&
        teacherUser?.orgId === B,
    );

    const pendingLogin = track(
      await request(port, 'POST', '/api/auth/login', {
        headers: headersFor(B),
        body: { email: person('teacher-b').email, password: PASSWORD },
      }),
    );
    check(
      'signing in as that teacher says "pending", not "welcome"',
      pendingLogin.status === 403 && pendingLogin.json?.status === 'pending',
      `${pendingLogin.status} ${pendingLogin.raw}`,
    );

    /* ══ 8. Details and duplicates ══════════════════════════════════════ */
    console.log('\ndetails and duplicates');
    const bad = track(
      await register(A, appOf('a'), {
        ...person('bad'),
        email: 'not-an-email',
        password: 'short',
      }),
    );
    check(
      'bad details are refused, field by field',
      bad.status === 400 &&
        bad.json?.code === 'INVALID_DETAILS' &&
        bad.json?.fields?.email &&
        bad.json?.fields?.password,
      bad.raw,
    );

    before = await snapshot();
    const dup = track(await register(A, appOf('a'), person('a-warn')));
    check(
      'the same email twice in one app is refused',
      dup.status === 409 && dup.json?.code === 'ALREADY_REGISTERED',
      `${dup.status} ${dup.raw}`,
    );
    check('...and nothing new was written', same(before, await snapshot()));

    // The same person at a DIFFERENT institute. Whether that is allowed depends
    // on the platform-wide email index that predates tenant-local uniqueness.
    const indexes = await db.collection('users').indexes();
    const globalEmail = indexes.some(
      (ix: { key: Record<string, number>; unique?: boolean }) =>
        ix.unique && Object.keys(ix.key).length === 1 && ix.key.email === 1,
    );
    before = await snapshot();
    const cross = track(await register(D, appOf('d'), person('a-warn')));
    if (globalEmail) {
      check(
        'with the platform-wide email index present, another institute cannot reuse the email',
        cross.status === 409 && cross.json?.code === 'ALREADY_REGISTERED',
        `${cross.status} ${cross.raw}`,
      );
      check(
        '...and the refused write left NO registration record in D, and no account',
        same(before, await snapshot()),
      );
    } else {
      check(
        'without the platform-wide index, another institute may register the same email',
        cross.status === 201,
        `${cross.status} ${cross.raw}`,
      );
      check(
        '...into D alone',
        (await count(colD as string, { email: person('a-warn').email })) === 1,
      );
    }

    /* ══ 9. Nothing leaks where it is stored ════════════════════════════ */
    console.log('\nwhat responses reveal');
    const leaked = seen.filter(
      (body) =>
        /reg_zz_reg_|"collection"|registrationStore/.test(body) ||
        body.includes(dbName),
    );
    check(
      'no response to an app ever names a collection or a database',
      leaked.length === 0,
      leaked[0]?.slice(0, 200),
    );

    /* ══ 10. The operator's controls ════════════════════════════════════ */
    console.log('\nthe console');
    const owner = await withoutTenantScope('e2e:staff', async () =>
      PlatformUser.create({
        name: 'Reg Owner',
        email: `${RUN}-owner@platform.test`,
        password: PASSWORD,
        role: 'owner',
      }),
    );
    const token = signPlatformToken({
      id: String(owner._id),
      role: 'owner',
      tokenVersion: 0,
    });

    const view = await request(
      port,
      'GET',
      `/api/platform/orgs/${A}/registration`,
      { token },
    );
    check(
      'an operator can see where A’s registrations go',
      view.status === 200 && view.json?.store?.collection === colA,
      view.raw,
    );

    const hijack = await request(
      port,
      'PUT',
      `/api/platform/orgs/${D}/registration`,
      {
        token,
        body: {
          policy: 'open',
          roles: { student: true },
          collection: 'users',
          store: { collection: colA },
        },
      },
    );
    check(
      'a console request cannot choose the collection',
      hijack.status === 200 && (await storeOf(D)) === colD,
      `${hijack.status} store=${await storeOf(D)}`,
    );

    const close = await request(
      port,
      'PUT',
      `/api/platform/orgs/${D}/registration`,
      { token, body: { policy: 'invite' } },
    );
    check(
      'closing registration from the console takes effect',
      close.status === 200 && close.json?.policy === 'invite',
      close.raw,
    );
    const afterClose = track(
      await register(D, appOf('d'), person('after-close')),
    );
    check(
      '...the app is refused immediately, no rebuild needed',
      afterClose.status === 403 &&
        afterClose.json?.code === 'REGISTRATION_CLOSED',
    );
    check(
      '...and D keeps its collection and its history',
      (await storeOf(D)) === colD && existing.includes(colD as string),
    );

    /* ══ 11. The invariant, stated over everything written ══════════════ */
    console.log('\nthe invariant');
    let misplaced = 0;
    for (const [orgId, col] of [
      [A, colA],
      [B, colB],
      [D, colD],
    ] as [string, string][]) {
      const records = await withoutTenantScope('e2e:all', async () =>
        registrationModel(col).find({}).lean(),
      );
      for (const r of records) {
        const u = await withoutTenantScope('e2e:owner', async () =>
          User.findById(r.userId).select('orgId').lean(),
        );
        if (r.orgId !== orgId || u?.orgId !== orgId) misplaced++;
      }
    }
    check(
      'every record in every collection belongs to that collection’s organization, and so does its account',
      misplaced === 0,
      `${misplaced} misplaced`,
    );
  } finally {
    await cleanup().catch((e: Error) =>
      console.error('cleanup failed:', e.message),
    );
    const left = await regCollections().catch(() => ['?']);
    check(
      'cleanup removed every collection this run created',
      left.length === 0,
      left.join(', '),
    );
    server.close();
    await mongoose.disconnect();
  }

  console.log(`\n  ${checks - failures}/${checks} checks passed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
