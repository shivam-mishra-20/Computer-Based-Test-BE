/**
 * The design-template rules exist twice. This proves they are the same rules.
 *
 * ── Why there are two copies ────────────────────────────────────────────────
 * The mobile app, the web Design Studio and the platform console take the
 * templates, the selection validator and the lifecycle from
 * `@platform/client-core`. This server needs the same answers — whether a
 * submitted template exists, what a valid selection is, who may move a
 * request to which stage — and cannot import that sibling repository (the
 * reasons are in the header of src/core/platform/mobileBuildRules.ts). So it
 * keeps a copy in src/core/platform/design/.
 *
 * A copy makes drift silent, and drift here is concrete: the studio offering
 * a template the server rejects, or the server accepting a selection the
 * device then refuses to render. So each mirrored file is compared with its
 * source below the "Mirrored body" marker, byte for byte. Headers differ on
 * purpose (imports and explanations); bodies may not.
 *
 * Like `safety:mobile-rules`, a missing sibling checkout is a loud SKIP, not a
 * failure: a container is given this repository alone.
 *
 *   npm run safety:design-rules
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const BODY_MARKER = '/* ══ Mirrored body';

const FILES = [
  'schema.ts',
  'validate.ts',
  'lifecycle.ts',
  'catalogue/natural.ts',
  'catalogue/premium.ts',
  'catalogue/contemporary.ts',
  'catalogue/digital.ts',
  'catalogue/learning.ts',
  'catalogue/index.ts',
];

const MINE = join(__dirname, '..', '..', 'src', 'core', 'platform', 'design');
const MIRROR = process.env.PLATFORM_CLIENT_CORE_PATH
  ? resolve(process.env.PLATFORM_CLIENT_CORE_PATH, 'src', 'design')
  : join(__dirname, '..', '..', '..', 'platform-client-core', 'src', 'design');

function bodyOf(path: string): string {
  const source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const at = source.indexOf(BODY_MARKER);
  if (at < 0) throw new Error(`${path} has no "${BODY_MARKER}" marker, so its comparable body cannot be found.`);
  return source.slice(at);
}

function firstDifference(a: string, b: string): string {
  const left = a.split('\n');
  const right = b.split('\n');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) {
      return `    first difference at body line ${i + 1}:\n      backend : ${JSON.stringify(left[i] ?? '<end>')}\n      source  : ${JSON.stringify(right[i] ?? '<end>')}`;
    }
  }
  return '    the files differ in length only.';
}

function main(): void {
  if (!existsSync(MIRROR)) {
    console.log(`SKIP  platform-client-core not found at ${MIRROR} — the design-rules mirror cannot be compared here.`);
    return;
  }
  let failed = 0;
  for (const rel of FILES) {
    const mine = join(MINE, rel);
    const theirs = join(MIRROR, rel);
    if (!existsSync(mine) || !existsSync(theirs)) {
      failed++;
      console.error(`FAIL  ${rel}: ${!existsSync(mine) ? 'missing here' : 'missing in platform-client-core'}`);
      continue;
    }
    const a = bodyOf(mine);
    const b = bodyOf(theirs);
    if (a === b) {
      console.log(`PASS  ${rel}`);
    } else {
      failed++;
      console.error(`FAIL  ${rel} has drifted from platform-client-core\n${firstDifference(a, b)}`);
    }
  }
  if (failed) {
    console.error(`\n${failed} of ${FILES.length} mirrored design files differ. Copy the source body across.`);
    process.exit(1);
  }
  console.log(`\nAll ${FILES.length} mirrored design files match platform-client-core.`);
}

main();
