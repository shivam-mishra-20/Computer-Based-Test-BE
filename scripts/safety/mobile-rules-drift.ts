/**
 * The mobile build rules exist twice. This proves they are the same rules.
 *
 * ── Why there are two copies at all ─────────────────────────────────────────
 * `src/core/platform/mobileBuildRules.ts` answers "is this organization ready
 * to build" for the console. `client-platform-app` has to answer the same
 * question at build time, inside the Expo config loader, with no network and no
 * server — so it needs the rules locally, and it gets them through
 * `platform-client-core`.
 *
 * They were briefly ONE copy, imported by the backend from
 * `@platform/client-core`. That broke the production container: the package is
 * a sibling git repository, `file:../platform-client-core` resolves only on a
 * developer's machine, and `esbuild --packages=external` deferred the failure
 * from build time to `node dist/server.js`. The backend has to be installable
 * from its own checkout alone.
 *
 * ── So the guarantee moves from the import to this check ────────────────────
 * A shared import made drift impossible. A copy makes drift silent — and drift
 * here is the specific failure the whole readiness feature exists to prevent:
 * the console reporting READY for a build the app then refuses, which moves the
 * error to whoever is least able to diagnose it.
 *
 * So the two files are compared below the header, byte for byte. Headers differ
 * on purpose — each explains itself to its own reader — and everything from the
 * first section marker onward must be identical.
 *
 * ── Why a missing sibling is a skip and not a failure ───────────────────────
 * A container is given this repository and nothing else. Failing there would
 * make a correct deployment look broken, and would teach people to ignore the
 * check. It skips, says so, and returns success — the comparison is a
 * development-time guarantee, enforced where both repositories exist.
 *
 *   npm run safety:mobile-rules
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

/** Everything below this marker must match. */
const BODY_MARKER = '/* ══';

const MINE = join(__dirname, '..', '..', 'src', 'core', 'platform', 'mobileBuildRules.ts');

/**
 * The mirrored copy. Overridable so the check can run from a checkout laid out
 * differently, rather than assuming everyone keeps siblings side by side.
 */
const MIRROR =
  process.env.PLATFORM_CLIENT_CORE_PATH
    ? resolve(process.env.PLATFORM_CLIENT_CORE_PATH, 'src', 'mobileBuild.ts')
    : join(__dirname, '..', '..', '..', 'platform-client-core', 'src', 'mobileBuild.ts');

function bodyOf(path: string): string {
  const source = readFileSync(path, 'utf8');
  const at = source.indexOf(BODY_MARKER);
  if (at < 0) {
    throw new Error(
      `${path} has no "${BODY_MARKER}" section marker, so the comparable body cannot be found. ` +
        'Either the file was restructured or the marker was removed; this check needs one.',
    );
  }
  return source.slice(at);
}

/** The first line that differs, with a little context on each side. */
function firstDifference(a: string, b: string): string {
  const left = a.split('\n');
  const right = b.split('\n');
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    if (left[i] !== right[i]) {
      return (
        `  first difference at body line ${i + 1}:\n` +
        `    backend : ${JSON.stringify(left[i] ?? '<end of file>')}\n` +
        `    mirror  : ${JSON.stringify(right[i] ?? '<end of file>')}`
      );
    }
  }
  return '  the files differ in length only.';
}

function main(): void {
  console.log('\nMOBILE BUILD RULES — drift check\n');

  if (!existsSync(MINE)) {
    console.error(`  ✗ backend rules not found at ${MINE}`);
    process.exit(1);
  }

  if (!existsSync(MIRROR)) {
    console.log(`  – skipped: no platform-client-core checkout at\n      ${MIRROR}`);
    console.log('    This is expected in a container, which is given this repository alone.');
    console.log('    Set PLATFORM_CLIENT_CORE_PATH to compare against a checkout elsewhere.\n');
    return;
  }

  const mine = bodyOf(MINE);
  const mirror = bodyOf(MIRROR);

  if (mine === mirror) {
    const lines = mine.split('\n').length;
    console.log(`  ✓ the rules are identical (${lines} lines compared, byte for byte)`);
    console.log(`      backend : src/core/platform/mobileBuildRules.ts`);
    console.log(`      mirror  : platform-client-core/src/mobileBuild.ts\n`);
    return;
  }

  console.error('  ✗ THE TWO COPIES HAVE DIVERGED.\n');
  console.error(firstDifference(mine, mirror));
  console.error(
    '\n  The console and client-platform-app would now disagree about whether an\n' +
      '  organization can build. Copy everything below the header from the file you\n' +
      '  changed into the other, then run this again.\n',
  );
  process.exit(1);
}

main();
