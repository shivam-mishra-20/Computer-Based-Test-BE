/**
 * Automated mobile app builds, end to end, against a real database.
 *
 * ── What is real here and what is not ───────────────────────────────────────
 * Real: the HTTP surface, the permission checks, the readiness rules, the
 * BuildJob document and its unique index, the queue payloads, the worker's
 * state machine, the generated organization configuration, the generated
 * eas.json, the asset resolution, and the isolation verification.
 *
 * Not real: the EAS CLI. A single Android build costs tens of minutes on
 * Expo's infrastructure and real money, so the CLI is replaced through
 * `__setEasRunner` with one that answers the way `eas build --json` does. That
 * substitution is stated rather than hidden, because a test that stubs the
 * build and then claims to have proved the build works has proved nothing.
 *
 * The CLI itself is exercised by `npm run smoke:eas-build`, which a person
 * runs on purpose with a token, against one organization, once.
 *
 *   npx ts-node --transpile-only scripts/safety/app-build.e2e.test.ts \
 *     --scratch-suffix scratch_build
 */

import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { promises as fsp } from 'fs';
import { config } from 'dotenv';
import { assertNotProduction, configureDnsForSrv, requireEnv } from './lib';

config();

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] ?? null : null;
}

function deriveScratchUri(productionUri: string, suffix: string): string {
  const m = productionUri.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/);
  if (!m) throw new Error('MONGO_URI could not be parsed.');
  return `${m[1]}${m[2]}_${suffix}${m[3] ?? ''}`;
}

const MARKER = 'zz-build';
const PASSWORD = 'AppBuildE2E!Passw0rd';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (ok) passed++;
  else failed++;
}

interface Res { status: number; json: any; raw: string }

function request(
  port: number, method: string, reqPath: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : null;
    const req = http.request(
      {
        host: '127.0.0.1', port, method, path: reqPath, timeout: 30000,
        headers: {
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed: any = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { /* non-JSON */ }
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


/**
 * A multipart POST, the way a browser sends one.
 *
 * The service-level `saveNativeAsset` calls further down do not exercise this,
 * and the first real failure of this feature lived here: the console labelled a
 * FormData body `application/json`, so `express.json` rejected it before
 * `cors()` had run, and the browser reported a CORS error for a body problem.
 */
function uploadRequest(
  port: number, reqPath: string,
  opts: { token?: string; filename: string; contentType: string; bytes: Buffer; origin?: string },
): Promise<Res & { headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const CRLF = String.fromCharCode(13, 10);
    const boundary = '----SafetyTestBoundary' + Date.now();
    const head = Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${opts.filename}"${CRLF}` +
      `Content-Type: ${opts.contentType}${CRLF}${CRLF}`,
    );
    const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
    const payload = Buffer.concat([head, opts.bytes, tail]);

    const req = http.request(
      {
        host: '127.0.0.1', port, method: 'POST', path: reqPath, timeout: 30000,
        headers: {
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.origin ? { Origin: opts.origin } : {}),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': payload.length,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed: any = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, json: parsed, raw, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(payload);
    req.end();
  });
}

/** A multipart payload sent as `application/json` — what the console used to do. */
function mislabelledUpload(port: number, reqPath: string, token: string): Promise<Res & { headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const CRLF = String.fromCharCode(13, 10);
    const payload = Buffer.from(
      `------WebKitFormBoundaryX${CRLF}Content-Disposition: form-data; name="file"${CRLF}${CRLF}not json${CRLF}------WebKitFormBoundaryX--`,
    );
    const req = http.request(
      {
        host: '127.0.0.1', port, method: 'POST', path: reqPath, timeout: 30000,
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: 'http://localhost:3100',
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed: any = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, json: parsed, raw, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(payload);
    req.end();
  });
}

/* ══ A scripted EAS CLI ═════════════════════════════════════════════════ */

interface FakeEasState {
  startCalls: { args: string[]; cwd: string }[];
  status: string;
  artifactUrl: string | null;
  failStart: boolean;
  errorCode?: string;
}

function installFakeEas(state: FakeEasState) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { __setEasRunner } = require('../../src/core/platform/easClient');
  __setEasRunner(async (args: string[], options: { cwd: string }) => {
    if (args[0] === 'build') {
      state.startCalls.push({ args, cwd: options.cwd });
      if (state.failStart) {
        return { stdout: '', stderr: 'Build failed to start: credentials error', exitCode: 1 };
      }
      return {
        stdout: JSON.stringify([
          { id: 'eas-build-0001', status: 'NEW', buildUrl: 'https://expo.dev/accounts/x/builds/eas-build-0001' },
        ]),
        stderr: '',
        exitCode: 0,
      };
    }
    if (args[0] === 'build:view') {
      return {
        stdout: JSON.stringify({
          id: 'eas-build-0001',
          status: state.status,
          buildUrl: 'https://expo.dev/accounts/x/builds/eas-build-0001',
          artifacts: state.artifactUrl ? { buildUrl: state.artifactUrl } : undefined,
          error: state.errorCode ? { errorCode: state.errorCode, message: 'gradle exploded' } : undefined,
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '{}', stderr: '', exitCode: 0 };
  });
}

/* ══ A throwaway app project ════════════════════════════════════════════ */

/**
 * The worker copies a real project. Building one here, rather than pointing at
 * the developer's checkout, keeps the test independent of what happens to be
 * on the machine and keeps it from writing anywhere near a real repository.
 */
async function makeFakeAppProject(root: string): Promise<void> {
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(path.join(root, 'config', 'organizations'), { recursive: true });
  await fsp.mkdir(path.join(root, 'assets', 'platform'), { recursive: true });
  await fsp.mkdir(path.join(root, 'node_modules'), { recursive: true });
  await fsp.mkdir(path.join(root, 'app'), { recursive: true });

  await fsp.writeFile(path.join(root, 'app.config.ts'), 'export default {};\n');
  await fsp.writeFile(path.join(root, 'package.json'), '{"name":"fake-app","version":"1.0.0"}\n');
  await fsp.writeFile(path.join(root, 'config', 'resolve.js'), 'module.exports = {};\n');
  await fsp.writeFile(
    path.join(root, 'config', 'organizations', 'platform.js'),
    "const platform = { mode: 'generic', organization: {}, native: {} };\nmodule.exports = { platform };\n",
  );
  // Another institute's configuration, which no build may ever pick up.
  await fsp.writeFile(
    path.join(root, 'config', 'organizations', 'rival-academy.js'),
    "const rivalAcademy = { mode: 'dedicated' };\nmodule.exports = { rivalAcademy };\n",
  );
  await fsp.mkdir(path.join(root, 'assets', 'rival-academy'), { recursive: true });
  await fsp.writeFile(path.join(root, 'assets', 'rival-academy', 'icon.png'), 'not-a-real-png');
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC',
  'base64',
);

async function main() {
  const productionUri = requireEnv('MONGO_URI');
  const suffix = arg('--scratch-suffix');
  if (!suffix) {
    console.error('Usage: app-build.e2e.test.ts --scratch-suffix <suffix>');
    process.exit(2);
  }
  const uri = deriveScratchUri(productionUri, suffix);
  assertNotProduction(uri, productionUri);

  configureDnsForSrv();
  process.env.MONGO_URI = uri;
  process.env.TENANT_MODE = 'claim';
  process.env.TENANT_ENFORCEMENT = 'warn';
  process.env.ENABLE_CRON = 'false';
  process.env.PPT_WORKER_EMBEDDED = 'false';
  process.env.REDIS_ENABLED = 'false';
  process.env.PUBLIC_FORM_RATE_LIMIT_MAX = '5000';
  process.env.UPLOAD_RATE_LIMIT_MAX = '5000';
  process.env.EXPO_TOKEN = 'test-token-not-a-real-one';
  // Its OWN queue. Redis is shared with the running server, and an earlier
  // version of this test pushed its jobs onto the real `app-builds` queue —
  // where a live worker would have picked up builds whose BuildJob rows live
  // in a scratch database. Read at module load, so it must be set before the
  // queue module is first required.
  process.env.APP_BUILD_QUEUE_NAME = `app-builds-test-${process.pid}`;
  process.on('unhandledRejection', () => { /* mirrors server.ts tolerance */ });

  const appRoot = path.join(process.cwd(), '.tmp-app-build-e2e');
  process.env.CLIENT_APP_PATH = appRoot;
  await makeFakeAppProject(appRoot);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registerTenancy } = require('../../src/core/tenancy');
  registerTenancy();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mongoose = require('mongoose');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { withoutTenantScope } = require('../../src/core/tenancy/context');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { signPlatformToken } = require('../../src/core/auth/tokens');
  const PlatformUser = require('../../src/models/PlatformUser').default;
  const Org = require('../../src/models/Org').default;
  const AppBuildJob = require('../../src/models/AppBuildJob').default;
  const PlatformAudit = require('../../src/models/PlatformAudit').default;

  const app = require('../../src/app').default || require('../../src/app');
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  const state: FakeEasState = { startCalls: [], status: 'IN_QUEUE', artifactUrl: null, failStart: false };
  installFakeEas(state);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { saveNativeAsset, NATIVE_ASSET_KINDS } = require('../../src/core/platform/mobileAssets');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const worker = require('../../src/workers/appBuildWorkerCore');
  // The worker's two stages, called directly: the queue itself is BullMQ's and
  // is not what this test is about.
  const runPrepare = (worker as { __test__?: Record<string, Function> }).__test__?.runPrepare;
  const runPoll = (worker as { __test__?: Record<string, Function> }).__test__?.runPoll;

  try {
    await withoutTenantScope('e2e:clean', async () => {
      await Promise.all([
        Org.deleteMany({ slug: { $regex: `^${MARKER}` } }),
        PlatformUser.deleteMany({ email: { $regex: MARKER } }),
      ]);
    });

    /* ══ 1. Fixtures ════════════════════════════════════════════════════ */
    console.log('\nfixtures');
    const [owner, viewer] = await withoutTenantScope('e2e:staff', async () =>
      Promise.all([
        PlatformUser.create({ name: 'Build Owner', email: `${MARKER}-owner@platform.test`, password: PASSWORD, role: 'owner' }),
        PlatformUser.create({ name: 'Build Viewer', email: `${MARKER}-viewer@platform.test`, password: PASSWORD, role: 'support' }),
      ]),
    );
    const ownerToken = signPlatformToken({ id: String(owner._id), role: 'owner', tokenVersion: 0 });
    const viewerToken = signPlatformToken({ id: String(viewer._id), role: 'support', tokenVersion: 0 });

    const org = await withoutTenantScope('e2e:org', async () =>
      Org.create({
        name: 'Build Test Institute',
        slug: `${MARKER}-institute`,
        status: 'active',
        branding: {
          appName: 'Build Test Institute',
          tagline: 'Testing the build pipeline',
          primaryColor: '#0F766E',
          secondaryColor: '#14B8A6',
          accentColor: '#042F2E',
          splashBackgroundColor: '#02201E',
        },
        mobile: {
          androidPackage: 'com.platform.buildtestinstitute',
          iosBundleId: 'com.platform.buildtestinstitute',
          scheme: 'buildtest',
          apiBaseUrl: 'https://api.buildtest.example.com/api',
          version: '1.0.0',
          backgroundColor: '#02201E',
          easProjectId: '00000000-0000-4000-8000-000000000001',
        },
      }),
    );
    const orgId = String(org._id);
    check('an organization with a complete native identity exists', Boolean(orgId));

    /* ══ 2. Readiness refuses before anything is queued ═════════════════ */
    console.log('\nbuild readiness');
    const notReady = await request(port, 'GET', `/api/platform/orgs/${orgId}/mobile/build-readiness`, { token: ownerToken });
    check('readiness is readable', notReady.status === 200, `got ${notReady.status}`);
    check('it refuses while the five images are missing', notReady.json?.ready === false);
    check('an organization with no Expo project is refused, in words',
      (notReady.json?.problems ?? []).some((p: string) => /Expo project/i.test(p)) === false,
      'fixtures carry an easProjectId, so this must not fire');
    check('...and names each missing image in words',
      (notReady.json?.problems ?? []).some((p: string) => /app icon/i.test(p) && /icon\.png/.test(p)),
      JSON.stringify(notReady.json?.problems));
    check('nothing in the refusal looks like a stack trace',
      !(notReady.json?.problems ?? []).some((p: string) => /\bat \w+\.|node_modules|Error:/.test(p)));

    const blocked = await request(port, 'POST', `/api/platform/orgs/${orgId}/mobile/builds`,
      { token: ownerToken, body: { artifactType: 'apk' } });
    check('a build cannot be started while it would fail', blocked.status === 422, `got ${blocked.status}`);
    const queuedWhileBlocked = await withoutTenantScope('e2e:count', async () => AppBuildJob.countDocuments({ orgId }));
    check('...and NOTHING was queued', queuedWhileBlocked === 0, `${queuedWhileBlocked} build(s) created`);

    /* ══ 3. Assets ══════════════════════════════════════════════════════ */
    console.log('\nnative assets');

    // Over HTTP, as a browser sends it.
    const uploaded = await uploadRequest(port, `/api/platform/orgs/${orgId}/mobile/assets/icon`, {
      token: ownerToken, filename: 'icon.png', contentType: 'image/png', bytes: PNG,
      origin: 'http://localhost:3100',
    });
    check('an image uploads over multipart', uploaded.status === 201,
      `got ${uploaded.status} ${uploaded.raw.slice(0, 200)}`);
    check('...and the response is usable from a browser origin',
      uploaded.headers['access-control-allow-origin'] === 'http://localhost:3100',
      String(uploaded.headers['access-control-allow-origin']));

    const notAnImage = await uploadRequest(port, `/api/platform/orgs/${orgId}/mobile/assets/icon`, {
      token: ownerToken, filename: 'icon.png', contentType: 'image/png',
      bytes: Buffer.from('GIF89a this is not a png'),
      origin: 'http://localhost:3100',
    });
    check('a file that is not really a PNG is refused', notAnImage.status === 400,
      `got ${notAnImage.status}`);
    check('...and THAT refusal is readable from the browser too',
      notAnImage.headers['access-control-allow-origin'] === 'http://localhost:3100');

    // A body that is not what its content type claims must fail as a BODY
    // problem. This is the exact shape that took the console down: everything
    // answering before `cors()` answered without an allow-origin header, so a
    // 400 arrived in the browser as "blocked by CORS policy".
    const mislabelled = await mislabelledUpload(port, `/api/platform/orgs/${orgId}/mobile/assets/icon`, ownerToken);
    check('a body that lies about its content type is refused as a request',
      mislabelled.status >= 400 && mislabelled.status < 500, `got ${mislabelled.status}`);
    check('...and NOT as a CORS failure — the origin header is still there',
      mislabelled.headers['access-control-allow-origin'] === 'http://localhost:3100',
      String(mislabelled.headers['access-control-allow-origin']));
    for (const kind of NATIVE_ASSET_KINDS) {
      await saveNativeAsset(orgId, kind, { buffer: PNG, originalname: `${kind}.png` });
    }
    const ready = await request(port, 'GET', `/api/platform/orgs/${orgId}/mobile/build-readiness`, { token: ownerToken });
    check('with the images uploaded, the organization is ready', ready.json?.ready === true,
      JSON.stringify(ready.json?.problems));
    check('every image reports where it came from',
      (ready.json?.assets ?? []).every((a: any) => a.present && a.source === 'stored'));

    /* ══ 4. Permissions ═════════════════════════════════════════════════ */
    console.log('\npermissions');
    const byViewer = await request(port, 'POST', `/api/platform/orgs/${orgId}/mobile/builds`,
      { token: viewerToken, body: { artifactType: 'apk' } });
    check('staff without app.manage CANNOT start a build', byViewer.status === 403, `got ${byViewer.status}`);
    const anon = await request(port, 'POST', `/api/platform/orgs/${orgId}/mobile/builds`, { body: { artifactType: 'apk' } });
    check('...nor can an anonymous caller', anon.status === 401, `got ${anon.status}`);
    const viewerRead = await request(port, 'GET', `/api/platform/orgs/${orgId}/mobile/builds`, { token: viewerToken });
    check('...but they may still READ the history', viewerRead.status === 200, `got ${viewerRead.status}`);

    /* ══ 5. Starting an APK build ═══════════════════════════════════════ */
    console.log('\nstarting an APK build');
    const started = await request(port, 'POST', `/api/platform/orgs/${orgId}/mobile/builds`,
      { token: ownerToken, body: { artifactType: 'apk' } });
    check('a build starts', started.status === 201, `got ${started.status} ${started.raw.slice(0, 200)}`);
    check('...and reports itself created', started.json?.created === true);
    const buildId = started.json?.build?.id;
    check('it has a build number', started.json?.build?.buildNumber === 1);
    check('the identity was resolved and recorded BEFORE any build ran',
      started.json?.build?.resolvedIdentity?.androidPackage === 'com.platform.buildtestinstitute',
      JSON.stringify(started.json?.build?.resolvedIdentity));

    /* ══ 6. Duplicates ══════════════════════════════════════════════════ */
    console.log('\nduplicate requests');
    const again = await Promise.all([
      request(port, 'POST', `/api/platform/orgs/${orgId}/mobile/builds`, { token: ownerToken, body: { artifactType: 'apk' } }),
      request(port, 'POST', `/api/platform/orgs/${orgId}/mobile/builds`, { token: ownerToken, body: { artifactType: 'apk' } }),
      request(port, 'POST', `/api/platform/orgs/${orgId}/mobile/builds`, { token: ownerToken, body: { artifactType: 'apk' } }),
    ]);
    check('three more clicks are all accepted', again.every((r) => r.status === 200 || r.status === 201));
    check('...and none of them created a second build', again.every((r) => r.json?.created === false),
      JSON.stringify(again.map((r) => r.json?.created)));
    const apkCount = await withoutTenantScope('e2e:count-apk', async () =>
      AppBuildJob.countDocuments({ orgId, artifactType: 'apk' }));
    check('exactly ONE APK build exists', apkCount === 1, `${apkCount} found`);

    /* ══ 7. AAB is independent ══════════════════════════════════════════ */
    console.log('\nAAB alongside APK');
    const aab = await request(port, 'POST', `/api/platform/orgs/${orgId}/mobile/builds`,
      { token: ownerToken, body: { artifactType: 'aab' } });
    check('an AAB build starts while the APK is live', aab.status === 201, `got ${aab.status}`);
    check('...as its own build', aab.json?.build?.artifactType === 'aab' && aab.json?.build?.id !== buildId);

    /* ══ 8. The worker ══════════════════════════════════════════════════ */
    console.log('\nthe build pipeline');
    if (!runPrepare || !runPoll) {
      check('the worker exposes its stages for testing', false, 'export __test__ from appBuildWorkerCore');
    } else {
      await runPrepare({ buildId, orgId, platform: 'android', artifactType: 'apk' });
      const afterPrepare = await withoutTenantScope('e2e:read', async () => AppBuildJob.findById(buildId));
      check('the worker started the build on EAS', state.startCalls.length === 1, `${state.startCalls.length} calls`);
      check('...non-interactively, with no waiting',
        state.startCalls[0]?.args.includes('--non-interactive') && state.startCalls[0]?.args.includes('--no-wait'));
      check('...under this organization’s own profile',
        state.startCalls[0]?.args.includes(`org-${MARKER}-institute-apk`),
        JSON.stringify(state.startCalls[0]?.args));
      check('the EAS build id was saved', afterPrepare?.easBuildId === 'eas-build-0001');
      check('the build moved to building', afterPrepare?.status === 'building', String(afterPrepare?.status));
      check('the generated configuration was fingerprinted', Boolean(afterPrepare?.generatedConfigHash));

      /* ══ 9. Isolation ═════════════════════════════════════════════════ */
      console.log('\norganization isolation');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { prepareWorkspace, verifyWorkspaceIdentity, easJsonFor } = require('../../src/core/platform/appBuildWorkspace');
      const ws = await prepareWorkspace({ orgId, buildId: `${buildId}-inspect`, artifactType: 'apk' });
      const orgDir = await fsp.readdir(path.join(ws.root, 'config', 'organizations'));
      check('the workspace holds only this institute and the generic build',
        orgDir.sort().join(',') === ['platform.js', `${MARKER}-institute.js`].sort().join(','),
        orgDir.join(','));
      check('no other institute’s assets came along',
        !(await fsp.readdir(path.join(ws.root, 'assets'))).includes('rival-academy'));
      const generatedFile = await fsp.readFile(
        path.join(ws.root, 'config', 'organizations', `${MARKER}-institute.js`), 'utf8');
      check('the generated config carries this orgId', generatedFile.includes(orgId));
      check('...and this Android package', generatedFile.includes('com.platform.buildtestinstitute'));
      check('...and nothing belonging to anyone else', !/rival/i.test(generatedFile));
      let verified = true;
      await verifyWorkspaceIdentity(ws, {
        orgId, androidPackage: 'com.platform.buildtestinstitute', scheme: 'buildtest', appName: 'Build Test Institute',
      }).catch(() => { verified = false; });
      check('the pre-build identity check passes for the right organization', verified);

      let caught = false;
      await verifyWorkspaceIdentity(ws, {
        orgId, androidPackage: 'com.platform.SOMEONEELSE', scheme: 'buildtest', appName: 'x',
      }).catch(() => { caught = true; });
      check('...and FAILS when the identity does not match', caught);

      /* ══ 10. APK vs AAB are different EAS configurations ══════════════ */
      console.log('\nartifact configuration');
      const apkJson = JSON.parse(easJsonFor({ profileName: 'p-apk', slug: 's', artifactType: 'apk', apiBaseUrl: 'https://x/api' }));
      const aabJson = JSON.parse(easJsonFor({ profileName: 'p-aab', slug: 's', artifactType: 'aab', apiBaseUrl: 'https://x/api' }));
      check('APK builds with android.buildType = apk', apkJson.build['p-apk'].android.buildType === 'apk');
      check('AAB builds with android.buildType = app-bundle', aabJson.build['p-aab'].android.buildType === 'app-bundle');
      check('the organization is injected as ORG_ID', apkJson.build['p-apk'].env.ORG_ID === 's');

      /* ══ 11. Following the build ══════════════════════════════════════ */
      console.log('\nfollowing the build');
      state.status = 'IN_PROGRESS';
      await runPoll({ buildId, orgId, platform: 'android', artifactType: 'apk', easBuildId: 'eas-build-0001', pollCount: 1 });
      const midway = await withoutTenantScope('e2e:read2', async () => AppBuildJob.findById(buildId));
      check('progress is reported while it runs', midway?.status === 'building' && (midway?.progress ?? 0) >= 70,
        `${midway?.status} ${midway?.progress}`);

      state.status = 'FINISHED';
      state.artifactUrl = 'https://expo.dev/artifacts/eas/real-artifact.apk';
      await runPoll({ buildId, orgId, platform: 'android', artifactType: 'apk', easBuildId: 'eas-build-0001', pollCount: 2 });
      const done = await withoutTenantScope('e2e:read3', async () => AppBuildJob.findById(buildId));
      check('a finished build is completed', done?.status === 'completed', String(done?.status));
      check('the artifact URL is the one EAS gave', done?.artifactUrl === 'https://expo.dev/artifacts/eas/real-artifact.apk');
      check('the download is named for what it is', String(done?.artifactFilename ?? '').endsWith('.apk'),
        String(done?.artifactFilename));

      const artifact = await request(port, 'GET', `/api/platform/mobile/builds/${buildId}/artifact`, { token: ownerToken });
      check('the console can fetch the download link', artifact.status === 200 && Boolean(artifact.json?.url));
      check('...and it is not a URL this server invented', String(artifact.json?.url).startsWith('https://expo.dev/'));

      /* ══ 12. Failure ══════════════════════════════════════════════════ */
      console.log('\na failed build');
      const aabId = aab.json?.build?.id;
      await runPrepare({ buildId: aabId, orgId, platform: 'android', artifactType: 'aab' });
      state.status = 'ERRORED';
      state.errorCode = 'EAS_BUILD_GRADLE_BUILD_FAILED';
      state.artifactUrl = null;
      await runPoll({ buildId: aabId, orgId, platform: 'android', artifactType: 'aab', easBuildId: 'eas-build-0001', pollCount: 1 });
      const failedBuild = await withoutTenantScope('e2e:read4', async () => AppBuildJob.findById(aabId));
      check('a failed build is recorded as failed', failedBuild?.status === 'failed', String(failedBuild?.status));
      check('...with a sentence, not a code',
        /compiling the app/i.test(String(failedBuild?.errorMessage)), String(failedBuild?.errorMessage));
      check('...and the detail is kept server-side', Boolean(failedBuild?.errorDetail));

      const viewFailed = await request(port, 'GET', `/api/platform/mobile/builds/${aabId}`, { token: ownerToken });
      check('the API never returns the detailed log', !('errorDetail' in (viewFailed.json?.build ?? {})),
        Object.keys(viewFailed.json?.build ?? {}).join(','));
      check('no Expo token appears anywhere in the response', !/test-token-not-a-real-one/.test(viewFailed.raw));

      /* ══ 13. A new build after a failure ══════════════════════════════ */
      const retry = await request(port, 'POST', `/api/platform/orgs/${orgId}/mobile/builds`,
        { token: ownerToken, body: { artifactType: 'aab' } });
      check('a new build may be started after a failure', retry.status === 201, `got ${retry.status}`);
    }


    /* ══ 15. The worker actually runs ═══════════════════════════════════ */
    //
    // Everything above drove the pipeline by calling the worker's stages
    // directly, which proves the stages and nothing about whether anyone ever
    // calls them. That gap is exactly where this feature failed in practice:
    // the queue accepted builds, the document said "Waiting for a build
    // worker", and no worker had been started. So this section starts the
    // REAL BullMQ worker and lets it consume a job on its own.
    console.log('\nthe worker, for real');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { startAppBuildWorker, stopAppBuildWorker } = require('../../src/workers/appBuildWorkerCore');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { appBuildQueue, APP_BUILD_QUEUE_NAME, buildJobId } = require('../../src/queues/appBuildQueue');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { reconcileOrphanedBuilds } = require('../../src/core/platform/appBuilds');

    check('the queue is registered under its own name',
      typeof APP_BUILD_QUEUE_NAME === 'string' && APP_BUILD_QUEUE_NAME.startsWith('app-builds'),
      String(APP_BUILD_QUEUE_NAME));

    const runningWorker = startAppBuildWorker();
    check('the worker starts', Boolean(runningWorker));
    check('...and is listening on that queue', runningWorker?.name === APP_BUILD_QUEUE_NAME,
      `${runningWorker?.name} vs ${APP_BUILD_QUEUE_NAME}`);
    check('...and starting it twice returns the same worker, not a second one',
      startAppBuildWorker() === runningWorker);

    // A fresh organization, so this build is not blocked by the live APK above.
    const org2 = await withoutTenantScope('e2e:org2', async () =>
      Org.create({
        name: 'Worker Test Institute',
        slug: `${MARKER}-worker`,
        status: 'active',
        branding: {
          appName: 'Worker Test Institute', tagline: 'Consumed by a real worker',
          primaryColor: '#0F766E', secondaryColor: '#14B8A6',
          accentColor: '#042F2E', splashBackgroundColor: '#02201E',
        },
        mobile: {
          androidPackage: 'com.platform.workertestinstitute',
          iosBundleId: 'com.platform.workertestinstitute',
          scheme: 'workertest',
          apiBaseUrl: 'https://api.workertest.example.com/api',
          version: '1.0.0', backgroundColor: '#02201E',
          easProjectId: '00000000-0000-4000-8000-000000000001',
        },
      }),
    );
    const org2Id = String(org2._id);
    for (const kind of NATIVE_ASSET_KINDS) {
      await saveNativeAsset(org2Id, kind, { buffer: PNG, originalname: `${kind}.png` });
    }

    state.startCalls.length = 0;
    state.status = 'IN_QUEUE';
    state.artifactUrl = null;
    state.errorCode = undefined;

    const workerBuild = await request(port, 'POST', `/api/platform/orgs/${org2Id}/mobile/builds`,
      { token: ownerToken, body: { artifactType: 'apk' } });
    check('a build is accepted', workerBuild.status === 201, `got ${workerBuild.status}`);
    const workerBuildId = workerBuild.json?.build?.id;
    check('...and starts life queued', workerBuild.json?.build?.status === 'queued',
      String(workerBuild.json?.build?.status));

    // Nobody calls runPrepare here. The worker has to find it.
    const waitFor = async (predicate: (b: any) => boolean, timeoutMs = 30000) => {
      const deadline = Date.now() + timeoutMs;
      let last: any = null;
      while (Date.now() < deadline) {
        last = await withoutTenantScope('e2e:poll', async () => AppBuildJob.findById(workerBuildId).lean());
        if (last && predicate(last)) return last;
        await new Promise((r) => setTimeout(r, 400));
      }
      return last;
    };

    const consumed = await waitFor((b) => b.status !== 'queued');
    check('the worker picks the job up without anyone asking',
      consumed?.status !== 'queued', `still ${consumed?.status}: "${consumed?.statusMessage}"`);

    const built = await waitFor((b) => b.status === 'building' || b.status === 'failed');
    check('prepare runs end to end and the build reaches EAS',
      built?.status === 'building', `${built?.status}: ${built?.errorMessage ?? built?.statusMessage}`);
    check('...the EAS build id is persisted', Boolean(built?.easBuildId), String(built?.easBuildId));
    check('...and the EAS CLI was invoked exactly once', state.startCalls.length === 1,
      `${state.startCalls.length} invocations`);

    // What the console sees is what the database says.
    const asConsoleSeesIt = await request(port, 'GET', `/api/platform/mobile/builds/${workerBuildId}`,
      { token: ownerToken });
    check('polling the API reflects the real state',
      asConsoleSeesIt.json?.build?.status === built?.status &&
      asConsoleSeesIt.json?.build?.easBuildId === built?.easBuildId,
      `${asConsoleSeesIt.json?.build?.status} / ${asConsoleSeesIt.json?.build?.easBuildId}`);
    check('...and no longer says it is waiting for a worker',
      !/waiting for a build worker/i.test(String(asConsoleSeesIt.json?.build?.statusMessage)),
      String(asConsoleSeesIt.json?.build?.statusMessage));

    /* ══ 16. A worker failure is persisted, not swallowed ═══════════════ */
    console.log('\na worker failure');
    const goodPath = process.env.CLIENT_APP_PATH;
    process.env.CLIENT_APP_PATH = path.join(appRoot, 'does-not-exist');

    const org3 = await withoutTenantScope('e2e:org3', async () =>
      Org.create({
        name: 'Broken Path Institute', slug: `${MARKER}-broken`, status: 'active',
        branding: {
          appName: 'Broken Path Institute', tagline: 'Fails in prepare',
          primaryColor: '#0F766E', secondaryColor: '#14B8A6',
          accentColor: '#042F2E', splashBackgroundColor: '#02201E',
        },
        mobile: {
          androidPackage: 'com.platform.brokenpathinstitute',
          iosBundleId: 'com.platform.brokenpathinstitute',
          scheme: 'brokenpath',
          apiBaseUrl: 'https://api.brokenpath.example.com/api',
          version: '1.0.0', backgroundColor: '#02201E',
          easProjectId: '00000000-0000-4000-8000-000000000001',
        },
      }),
    );
    const org3Id = String(org3._id);
    for (const kind of NATIVE_ASSET_KINDS) {
      await saveNativeAsset(org3Id, kind, { buffer: PNG, originalname: `${kind}.png` });
    }
    const doomed = await request(port, 'POST', `/api/platform/orgs/${org3Id}/mobile/builds`,
      { token: ownerToken, body: { artifactType: 'apk' } });
    const doomedId = doomed.json?.build?.id;

    let doomedState: any = null;
    const failDeadline = Date.now() + 40000;
    while (Date.now() < failDeadline) {
      doomedState = await withoutTenantScope('e2e:poll2', async () => AppBuildJob.findById(doomedId).lean());
      if (doomedState?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    check('a build that cannot be prepared ends as failed, not stuck',
      doomedState?.status === 'failed', `${doomedState?.status}: ${doomedState?.statusMessage}`);
    check('...with a reason a person can act on',
      /CLIENT_APP_PATH|mobile app project/i.test(String(doomedState?.errorMessage)),
      String(doomedState?.errorMessage));
    process.env.CLIENT_APP_PATH = goodPath;

    /* ══ 17. No orphan stays silent ═════════════════════════════════════ */
    console.log('\norphan recovery');
    const orphan = await withoutTenantScope('e2e:orphan', async () =>
      AppBuildJob.create({
        buildNumber: 99,
        orgId: org2._id,
        organizationSlug: `${MARKER}-worker`,
        platform: 'android',
        artifactType: 'aab',
        buildProfile: `org-${MARKER}-worker-aab`,
        appVersion: '1.0.0',
        requestedBy: owner._id,
        requestedByEmail: String(owner.email),
        status: 'queued',
        statusMessage: 'Waiting for a build worker',
        progress: 5,
        queuedAt: new Date(),
      }),
    );
    // Deliberately never enqueued — the exact state a build is left in when the
    // server accepted it and no worker existed.
    const orphanId = String(orphan._id);
    const hadJob = await appBuildQueue.getJob(buildJobId(orphanId)).catch(() => null);
    check('the orphan has no queue entry to begin with', !hadJob);

    const before = await withoutTenantScope('e2e:count-before', async () =>
      AppBuildJob.countDocuments({ orgId: org2._id }));
    const result = await reconcileOrphanedBuilds();
    check('reconciliation re-queues it', result.requeued >= 1, JSON.stringify(result));
    const after = await withoutTenantScope('e2e:count-after', async () =>
      AppBuildJob.countDocuments({ orgId: org2._id }));
    check('...without creating a second build', after === before, `${before} -> ${after}`);

    const orphanProgressed = await (async () => {
      const deadline = Date.now() + 30000;
      let last: any = null;
      while (Date.now() < deadline) {
        last = await withoutTenantScope('e2e:poll3', async () => AppBuildJob.findById(orphanId).lean());
        if (last && last.status !== 'queued') return last;
        await new Promise((r) => setTimeout(r, 400));
      }
      return last;
    })();
    check('...and the recovered build is then processed',
      orphanProgressed?.status !== 'queued', `still ${orphanProgressed?.status}`);

    await stopAppBuildWorker();
    check('the worker stops cleanly', true);


    /* ══ 18. Automatic EAS project provisioning ═════════════════════════ */
    //
    // An organization's first build creates its Expo project; every build
    // after that reuses it. The CLI is scripted here, so what is proved is the
    // ORCHESTRATION — when it runs, when it does not, what is stored, and that
    // nothing races into two projects. The CLI call itself is exercised by
    // `npm run smoke:eas-build`.
    console.log('\nEAS project provisioning');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ensureEasProject, storedEasProject } = require('../../src/core/platform/easProvisioning');

    const provOrg = await withoutTenantScope('e2e:prov-org', async () =>
      Org.create({
        name: 'Provisioning Institute', slug: `${MARKER}-prov`, status: 'active',
        branding: {
          appName: 'Provisioning Institute', tagline: 'Gets its own Expo project',
          primaryColor: '#0F766E', secondaryColor: '#14B8A6',
          accentColor: '#042F2E', splashBackgroundColor: '#02201E',
        },
        mobile: {
          androidPackage: 'com.platform.provisioninginstitute',
          iosBundleId: 'com.platform.provisioninginstitute',
          scheme: 'provinstitute',
          apiBaseUrl: 'https://api.prov.example.com/api',
          version: '1.0.0', backgroundColor: '#02201E',
          // Deliberately NO easProjectId.
        },
      }),
    );
    const provOrgId = String(provOrg._id);
    for (const kind of NATIVE_ASSET_KINDS) {
      await saveNativeAsset(provOrgId, kind, { buffer: PNG, originalname: `${kind}.png` });
    }

    check('an organization with no project is still READY to build',
      (await request(port, 'GET', `/api/platform/orgs/${provOrgId}/mobile/build-readiness`, { token: ownerToken }))
        .json?.ready === true,
      'a missing Expo project must not block — the build creates it');

    const preState = await request(port, 'GET', `/api/platform/orgs/${provOrgId}/mobile/build-readiness`,
      { token: ownerToken });
    check('...and the console is told it is not provisioned yet',
      preState.json?.easProject?.connected === false,
      JSON.stringify(preState.json?.easProject));

    check('nothing was created merely by looking at the organization',
      (await storedEasProject(provOrgId)) === null);

    // Scripted `eas init`.
    let initCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { __setEasRunner } = require('../../src/core/platform/easClient');
    const scriptedInit = (fail = false) => {
      __setEasRunner(async (args: string[], options: { cwd: string }) => {
        if (args[0] === 'init') {
          initCalls++;
          if (fail) return { stdout: '', stderr: 'Entity not authorized', exitCode: 1 };
          return {
            stdout: JSON.stringify({
              id: 'aaaaaaaa-1111-4444-8888-bbbbbbbbbbbb',
              slug: `${MARKER}-prov`,
              fullName: `@${process.env.EXPO_ACCOUNT}/${MARKER}-prov`,
              ownerAccount: { name: process.env.EXPO_ACCOUNT },
            }),
            stderr: '', exitCode: 0,
          };
        }
        if (args[0] === 'build') {
          state.startCalls.push({ args, cwd: options.cwd });
          return {
            stdout: JSON.stringify([{ id: 'eas-build-prov', status: 'NEW', buildUrl: 'https://expo.dev/b/prov' }]),
            stderr: '', exitCode: 0,
          };
        }
        return { stdout: '{}', stderr: '', exitCode: 0 };
      });
    };
    scriptedInit();

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { prepareWorkspace, discardWorkspace } = require('../../src/core/platform/appBuildWorkspace');
    const ws1 = await prepareWorkspace({ orgId: provOrgId, buildId: 'prov-1', artifactType: 'apk' });

    const first = await ensureEasProject({
      orgId: provOrgId, organizationSlug: `${MARKER}-prov`, workspaceRoot: ws1.root,
    });
    check('a missing project triggers provisioning', first.provisioned === true && initCalls === 1,
      `provisioned=${first.provisioned} initCalls=${initCalls}`);
    check('...and the project id comes back', first.projectId === 'aaaaaaaa-1111-4444-8888-bbbbbbbbbbbb',
      first.projectId);

    const persisted = await withoutTenantScope('e2e:prov-read', async () => Org.findById(provOrgId).lean());
    const pm = (persisted as any)?.mobile ?? {};
    check('the project id is persisted on the organization', pm.easProjectId === first.projectId, String(pm.easProjectId));
    check('...with the owning account', pm.easOwner === process.env.EXPO_ACCOUNT, String(pm.easOwner));
    check('...the project slug', pm.easProjectSlug === `${MARKER}-prov`, String(pm.easProjectSlug));
    check('...and when it happened', Boolean(pm.easProvisionedAt), String(pm.easProvisionedAt));

    const second = await ensureEasProject({
      orgId: provOrgId, organizationSlug: `${MARKER}-prov`, workspaceRoot: ws1.root,
    });
    check('a second call does NOT run the CLI again', initCalls === 1, `${initCalls} init calls`);
    check('...and reuses the stored project', second.projectId === first.projectId && second.provisioned === false);

    // Concurrency: several builds starting at once must converge on one project.
    const racerOrg = await withoutTenantScope('e2e:race-org', async () =>
      Org.create({
        name: 'Race Institute', slug: `${MARKER}-race`, status: 'active',
        branding: {
          appName: 'Race Institute', tagline: 'Concurrent provisioning',
          primaryColor: '#0F766E', secondaryColor: '#14B8A6',
          accentColor: '#042F2E', splashBackgroundColor: '#02201E',
        },
        mobile: {
          androidPackage: 'com.platform.raceinstitute', iosBundleId: 'com.platform.raceinstitute',
          scheme: 'raceinstitute', apiBaseUrl: 'https://api.race.example.com/api',
          version: '1.0.0', backgroundColor: '#02201E',
        },
      }),
    );
    const raceOrgId = String(racerOrg._id);
    for (const kind of NATIVE_ASSET_KINDS) {
      await saveNativeAsset(raceOrgId, kind, { buffer: PNG, originalname: `${kind}.png` });
    }
    const wsRace = await prepareWorkspace({ orgId: raceOrgId, buildId: 'prov-race', artifactType: 'apk' });
    initCalls = 0;
    __setEasRunner(async (args: string[]) => {
      if (args[0] === 'init') {
        initCalls++;
        // The CLI LINKS rather than duplicates, so concurrent callers get the
        // same project — which is the layer that actually holds under a race.
        await new Promise((r) => setTimeout(r, 50));
        return {
          stdout: JSON.stringify({
            id: 'cccccccc-2222-4444-8888-dddddddddddd',
            slug: `${MARKER}-race`,
            ownerAccount: { name: process.env.EXPO_ACCOUNT },
          }),
          stderr: '', exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    });

    const raced = await Promise.all([
      ensureEasProject({ orgId: raceOrgId, organizationSlug: `${MARKER}-race`, workspaceRoot: wsRace.root }),
      ensureEasProject({ orgId: raceOrgId, organizationSlug: `${MARKER}-race`, workspaceRoot: wsRace.root }),
      ensureEasProject({ orgId: raceOrgId, organizationSlug: `${MARKER}-race`, workspaceRoot: wsRace.root }),
    ]);
    check('concurrent builds converge on ONE project',
      new Set(raced.map((r: any) => r.projectId)).size === 1, JSON.stringify(raced.map((r: any) => r.projectId)));
    const raceStored = await withoutTenantScope('e2e:race-read', async () => Org.findById(raceOrgId).lean());
    check('...and the organization stores exactly one',
      (raceStored as any)?.mobile?.easProjectId === 'cccccccc-2222-4444-8888-dddddddddddd',
      String((raceStored as any)?.mobile?.easProjectId));

    // Identity: a project that is not this organization's is refused.
    __setEasRunner(async (args: string[]) => {
      if (args[0] === 'init') {
        return {
          stdout: JSON.stringify({
            id: 'eeeeeeee-3333-4444-8888-ffffffffffff',
            slug: 'client-platform-app',
            ownerAccount: { name: process.env.EXPO_ACCOUNT },
          }),
          stderr: '', exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    });
    const wrongOrg = await withoutTenantScope('e2e:wrong-org', async () =>
      Org.create({
        name: 'Wrong Project Institute', slug: `${MARKER}-wrong`, status: 'active',
        branding: {
          appName: 'Wrong Project Institute', tagline: 'Gets the shared project back',
          primaryColor: '#0F766E', secondaryColor: '#14B8A6',
          accentColor: '#042F2E', splashBackgroundColor: '#02201E',
        },
        mobile: {
          androidPackage: 'com.platform.wrongprojectinstitute', iosBundleId: 'com.platform.wrongprojectinstitute',
          scheme: 'wrongproject', apiBaseUrl: 'https://api.wrong.example.com/api',
          version: '1.0.0', backgroundColor: '#02201E',
        },
      }),
    );
    let identityRefused = false;
    await ensureEasProject({
      orgId: String(wrongOrg._id), organizationSlug: `${MARKER}-wrong`, workspaceRoot: wsRace.root,
    }).catch((e: any) => { identityRefused = e?.code === 'PROJECT_IDENTITY_MISMATCH'; });
    check('a project whose slug is not this organization is REFUSED', identityRefused,
      'the shared platform project must never be adopted as an institute’s own');
    const wrongStored = await withoutTenantScope('e2e:wrong-read', async () => Org.findById(wrongOrg._id).lean());
    check('...and nothing is stored for it', !(wrongStored as any)?.mobile?.easProjectId);

    // Failure: the build fails, it does not sit queued.
    console.log('\nprovisioning failure');
    scriptedInit(true);
    const failOrg = await withoutTenantScope('e2e:fail-org', async () =>
      Org.create({
        name: 'Provision Fail Institute', slug: `${MARKER}-provfail`, status: 'active',
        branding: {
          appName: 'Provision Fail Institute', tagline: 'Expo says no',
          primaryColor: '#0F766E', secondaryColor: '#14B8A6',
          accentColor: '#042F2E', splashBackgroundColor: '#02201E',
        },
        mobile: {
          androidPackage: 'com.platform.provisionfailinstitute', iosBundleId: 'com.platform.provisionfailinstitute',
          scheme: 'provfail', apiBaseUrl: 'https://api.provfail.example.com/api',
          version: '1.0.0', backgroundColor: '#02201E',
        },
      }),
    );
    const failOrgId = String(failOrg._id);
    for (const kind of NATIVE_ASSET_KINDS) {
      await saveNativeAsset(failOrgId, kind, { buffer: PNG, originalname: `${kind}.png` });
    }
    const failBuild = await request(port, 'POST', `/api/platform/orgs/${failOrgId}/mobile/builds`,
      { token: ownerToken, body: { artifactType: 'apk' } });
    const failBuildId = failBuild.json?.build?.id;
    await runPrepare({ buildId: failBuildId, orgId: failOrgId, platform: 'android', artifactType: 'apk' })
      .catch(() => { /* the worker rethrows after persisting */ });
    const failState = await withoutTenantScope('e2e:fail-read', async () => AppBuildJob.findById(failBuildId).lean());
    check('a build whose project cannot be created FAILS', (failState as any)?.status === 'failed',
      String((failState as any)?.status));
    check('...with a message about the Expo project',
      /Expo project/i.test(String((failState as any)?.errorMessage)), String((failState as any)?.errorMessage));
    check('...keeping the detail server-side', Boolean((failState as any)?.errorDetail));
    check('...and no EAS build was started for it', !(failState as any)?.easBuildId);
    const failView = await request(port, 'GET', `/api/platform/mobile/builds/${failBuildId}`, { token: ownerToken });
    check('...and the token is nowhere in the response', !/test-token-not-a-real-one/.test(failView.raw));

    await discardWorkspace('prov-1');
    await discardWorkspace('prov-race');
    installFakeEas(state);


    /* ══ 19. Local dependencies survive the upload ══════════════════════ */
    //
    // `@platform/client-core` is a `file:` dependency whose `main` points at
    // compiled output. The workspace had it and the ARCHIVE did not, because
    // an unanchored `dist/` in .easignore matches that directory at any depth
    // — so EAS installed a package with no entry point and died in "Read app
    // config". Both halves are asserted: the ignore rule, and the check that
    // would have caught it regardless.
    console.log('\nlocal dependencies');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {
      easIgnoreFor, isIgnoredByEasignore, verifyWorkspaceDependencies,
    } = require('../../src/core/platform/appBuildWorkspace');

    const compiled = 'vendor/client-core/dist/index.js';
    check('the OLD unanchored rule stripped the compiled entry point',
      isIgnoredByEasignore(compiled, ['node_modules/', 'android/', 'ios/', 'dist/', '.expo/', '*.log']) === true,
      'this is the rule that broke every build');
    check('the anchored rule keeps it',
      isIgnoredByEasignore(compiled, easIgnoreFor().split('\n')) === false);
    check('...while still dropping the app’s own top-level dist',
      isIgnoredByEasignore('dist/index.html', easIgnoreFor().split('\n')) === true);
    check('...and the linked node_modules at any depth',
      isIgnoredByEasignore('node_modules/expo/package.json', easIgnoreFor().split('\n')) === true);

    // A workspace with a local dependency whose entry point is real.
    const depWs = await prepareWorkspace({ orgId, buildId: 'dep-check', artifactType: 'apk' });
    const depDir = path.join(depWs.root, 'vendor', 'client-core');
    await fsp.mkdir(path.join(depDir, 'dist'), { recursive: true });
    await fsp.writeFile(path.join(depDir, 'package.json'),
      JSON.stringify({ name: '@platform/client-core', version: '1.0.0', main: 'dist/index.js', types: 'dist/index.d.ts' }));
    await fsp.writeFile(path.join(depDir, 'dist', 'index.js'), 'module.exports = {};\n');
    await fsp.writeFile(path.join(depDir, 'dist', 'index.d.ts'), 'export {};\n');
    const rootPkgPath = path.join(depWs.root, 'package.json');
    const rootPkg = JSON.parse(await fsp.readFile(rootPkgPath, 'utf8'));
    rootPkg.dependencies = { ...(rootPkg.dependencies ?? {}), '@platform/client-core': 'file:./vendor/client-core' };
    await fsp.writeFile(rootPkgPath, JSON.stringify(rootPkg, null, 2));

    let depOk = true;
    await verifyWorkspaceDependencies(depWs).catch(() => { depOk = false; });
    check('a workspace whose local package is complete passes', depOk);

    // Now break it the way the archive did.
    await fsp.rm(path.join(depDir, 'dist', 'index.js'), { force: true });
    let depErr: any = null;
    await verifyWorkspaceDependencies(depWs).catch((e: any) => { depErr = e; });
    check('a missing entry point is caught BEFORE EAS', depErr?.code === 'WORKSPACE_DEPENDENCY_MISSING',
      String(depErr?.code));
    check('...naming the package and the file',
      /@platform\/client-core/.test(String(depErr?.message)) && /dist\/index\.js/.test(String(depErr?.message)),
      String(depErr?.message));

    // And the subtler case: present on disk, stripped on upload.
    await fsp.writeFile(path.join(depDir, 'dist', 'index.js'), 'module.exports = {};\n');
    await fsp.writeFile(path.join(depWs.root, '.easignore'), 'node_modules/\ndist/\n');
    let ignoredErr: any = null;
    await verifyWorkspaceDependencies(depWs).catch((e: any) => { ignoredErr = e; });
    check('an entry point that EXISTS but would be stripped is also caught',
      ignoredErr?.code === 'WORKSPACE_DEPENDENCY_MISSING', String(ignoredErr?.code));
    check('...and says it is the upload that would lose it',
      /strip it from the upload/i.test(String(ignoredErr?.detail)), String(ignoredErr?.detail));

    await discardWorkspace('dep-check');

    /* ══ 14. History and audit ══════════════════════════════════════════ */
    console.log('\nhistory and audit');
    const history = await request(port, 'GET', `/api/platform/orgs/${orgId}/mobile/builds`, { token: ownerToken });
    check('the history lists every build, newest first', (history.json?.builds ?? []).length >= 3,
      `${(history.json?.builds ?? []).length} rows`);
    check('...with who asked for each one',
      (history.json?.builds ?? []).every((b: any) => typeof b.requestedByEmail === 'string' && b.requestedByEmail.length > 0));

    const audit = await withoutTenantScope('e2e:audit', async () =>
      PlatformAudit.find({ action: 'mobile.build.start', orgId: org._id }).lean());
    check('every build request is audited', (audit as unknown[]).length >= 2, `${(audit as unknown[]).length} entries`);
    const downloadAudit = await withoutTenantScope('e2e:audit2', async () =>
      PlatformAudit.countDocuments({ action: 'mobile.build.download' }));
    check('...and so is taking the artifact out', downloadAudit >= 1, `${downloadAudit} entries`);
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { __setEasRunner } = require('../../src/core/platform/easClient');
    __setEasRunner(null);
    await new Promise<void>((r) => server.close(() => r()));
    await fsp.rm(appRoot, { recursive: true, force: true }).catch(() => {});
    await mongoose.disconnect();
  }

  console.log(`\n${passed}/${passed + failed} checks passed.`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nHARNESS ERROR:', err);
  process.exit(2);
});
