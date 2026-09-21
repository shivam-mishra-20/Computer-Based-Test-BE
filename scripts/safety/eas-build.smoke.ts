/**
 * The real EAS build, once, on purpose.
 *
 * ── Why this is separate from the safety test ───────────────────────────────
 * `safety:app-build` proves the pipeline: the permissions, the idempotency,
 * the generated configuration, the isolation, the state machine. It does that
 * against a scripted CLI, because a real Android build takes tens of minutes
 * of somebody's Expo quota and would make the suite unrunnable.
 *
 * This is the other half, and it is the half that can only be run by a person
 * who has decided to spend those minutes: it drives the ACTUAL `eas-cli`
 * against the ACTUAL Expo account for ONE organization, and reports what came
 * back. Nothing here is stubbed. If this passes, the CLI integration works; if
 * only the safety test passes, the CLI integration is unproven — which is the
 * distinction section 21 asks for and the reason both exist.
 *
 *   EXPO_TOKEN=... CLIENT_APP_PATH=../client-platform-app \
 *     npm run smoke:eas-build -- --org <orgId> --artifact apk
 *
 * It starts a build and exits. Follow it in the console, or on the URL it
 * prints. It does NOT submit anything to a store.
 */

import { config } from 'dotenv';
import { configureDnsForSrv, requireEnv } from './lib';

config();

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const orgId = arg('--org');
  const artifact = (arg('--artifact') || 'apk').toLowerCase();

  if (!orgId) {
    console.error('Usage: npm run smoke:eas-build -- --org <orgId> [--artifact apk|aab]');
    process.exit(2);
  }
  if (artifact !== 'apk' && artifact !== 'aab') {
    console.error('--artifact must be apk or aab');
    process.exit(2);
  }
  if (!String(process.env.EXPO_TOKEN || '').trim()) {
    console.error(
      'EXPO_TOKEN is not set. This smoke test talks to the real Expo account; it has nothing to do without one.',
    );
    process.exit(2);
  }
  if (!String(process.env.CLIENT_APP_PATH || '').trim()) {
    console.error('CLIENT_APP_PATH is not set. Point it at the client-platform-app directory.');
    process.exit(2);
  }

  const uri = requireEnv('MONGO_URI');
  configureDnsForSrv();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registerTenancy } = require('../../src/core/tenancy');
  registerTenancy();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mongoose = require('mongoose');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildReadiness } = require('../../src/core/platform/appBuilds');
    const readiness = await buildReadiness(orgId);
    console.log('\nreadiness');
    console.log('  ready :', readiness.ready);
    for (const problem of readiness.problems) console.log('  -', problem);
    if (!readiness.ready) {
      console.error('\nRefusing to spend build minutes on an organization that is not ready.');
      process.exit(1);
    }

    console.log('\nidentity');
    console.log('  org     :', readiness.identity?.orgId);
    console.log('  app     :', readiness.identity?.appName);
    console.log('  package :', readiness.identity?.androidPackage);
    console.log('  scheme  :', readiness.identity?.scheme);
    console.log('  api     :', readiness.identity?.apiBaseUrl);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { prepareWorkspace, verifyWorkspaceIdentity, discardWorkspace } =
      require('../../src/core/platform/appBuildWorkspace');
    const buildId = `smoke-${Date.now()}`;

    console.log('\npreparing a workspace');
    const workspace = await prepareWorkspace({
      orgId,
      buildId,
      artifactType: artifact,
      onProgress: (m: string) => console.log('  ', m),
    });
    console.log('  workspace :', workspace.root);
    console.log('  profile   :', workspace.profileName);
    console.log('  assets    :', workspace.assets.map((a: any) => `${a.kind}(${a.source})`).join(', '));

    await verifyWorkspaceIdentity(workspace, {
      orgId: String(readiness.identity?.orgId ?? ''),
      androidPackage: String(readiness.identity?.androidPackage ?? ''),
      scheme: String(readiness.identity?.scheme ?? ''),
      appName: String(readiness.identity?.appName ?? ''),
    });
    console.log('  identity verified');

    console.log('\nstarting the real EAS build — this uses your Expo quota');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { startEasBuild } = require('../../src/core/platform/easClient');
    const started = await startEasBuild({
      cwd: workspace.root,
      profile: workspace.profileName,
      platform: 'android',
    });

    console.log('\n✅ EAS accepted the build');
    console.log('  build id :', started.id);
    console.log('  status   :', started.status);
    console.log('  url      :', started.buildUrl ?? '(none returned)');
    console.log('\nNothing was submitted to any store.');

    await discardWorkspace(buildId);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err?.message || err);
  if (err?.detail) console.error('\n--- CLI output ---\n' + err.detail);
  process.exit(1);
});
