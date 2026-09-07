/**
 * Tenant isolation of object storage.
 *
 * ── What this can and cannot prove ──────────────────────────────────────────
 * The AUTHORIZATION decision — may this caller read this path — is a pure
 * function, and it is checked here exhaustively. That is deliberate design:
 * `signedUrlForTenantPath` refuses BEFORE it contacts Firebase, so the control
 * holds even when Storage is unreachable, and it can be tested without a
 * credential.
 *
 * What is NOT covered here is the signing itself and the bucket ACL, because
 * both need live Firebase and the service-account key available on this machine
 * fails `invalid_grant` for Storage, Firestore and Auth alike. Those are listed
 * as production verification steps rather than claimed as tested.
 *
 *   npx ts-node --transpile-only scripts/safety/storage-tenancy.test.ts
 */

import {
  isAbsoluteUrl,
  isLegacyPath,
  parseTenantPath,
  pathBelongsToOrg,
  sanitizeSegment,
  storagePathFromPublicUrl,
  tenantFilePath,
} from '../../src/core/storage/paths';

const ORG_A = '6a8441e8c4c17e061913e297';
const ORG_B = '6a8441ebc4c17e061913e2bb';

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function eq<T>(label: string, actual: T, expected: T) {
  check(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function main() {
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nevery tenant path names its owner');
  // ══════════════════════════════════════════════════════════════════════════

  const aMaterial = tenantFilePath({
    orgId: ORG_A,
    module: 'materials',
    entityId: '11_Physics',
    fileId: 'f1',
    fileName: 'notes.pdf',
  });
  const bMaterial = tenantFilePath({
    orgId: ORG_B,
    module: 'materials',
    entityId: '11_Physics',
    fileId: 'f1',
    fileName: 'notes.pdf',
  });

  eq('path is organizations/{orgId}/{module}/{entity}/{fileId}_{name}', aMaterial,
    `organizations/${ORG_A}/materials/11_Physics/f1_notes.pdf`);

  // ── The exact defect this phase fixed ────────────────────────────────────
  // Under `materials/{classLevel}/{subject}/` these two were the SAME folder.
  check(
    'two institutes with the same class AND subject no longer share a path',
    aMaterial !== bMaterial,
    `${aMaterial}\n      ${bMaterial}`,
  );
  eq('and the owner is recoverable from the path', parseTenantPath(aMaterial)?.orgId, ORG_A);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nOrg 001 can reach its own files, and only its own');
  // ══════════════════════════════════════════════════════════════════════════

  check('org A may read its own material', pathBelongsToOrg(aMaterial, ORG_A));
  check('org B may read its own material', pathBelongsToOrg(bMaterial, ORG_B));
  check("org A may NOT read org B's material", !pathBelongsToOrg(bMaterial, ORG_A));
  check("org B may NOT read org A's material", !pathBelongsToOrg(aMaterial, ORG_B));

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nguessed paths are denied');
  // ══════════════════════════════════════════════════════════════════════════

  const guesses = [
    `organizations/${ORG_B}/materials/11_Physics/f1_notes.pdf`, // the real one
    `organizations/${ORG_B}/homework/anything/x_y.pdf`,
    `organizations/../${ORG_B}/materials/x.pdf`,
    `organizations/${ORG_A}xx/materials/x.pdf`, // prefix of a real org id
    `/organizations/${ORG_B}/materials/x.pdf`,
    'materials/11/Physics/anything.pdf', // the OLD shared path
    '',
  ];
  for (const guess of guesses) {
    check(
      `org A is denied "${guess.slice(0, 46) || '(empty)'}"`,
      !pathBelongsToOrg(guess, ORG_A),
    );
  }

  // A near-miss that must NOT be accepted: an org id that merely starts the
  // same. String prefix matching would let `…e297xx` read `…e297`'s files.
  check(
    'an org id that is a prefix of another does not grant access',
    !pathBelongsToOrg(`organizations/${ORG_A}extra/materials/x.pdf`, ORG_A),
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\npath traversal cannot escape the tenant prefix');
  // ══════════════════════════════════════════════════════════════════════════

  const evil = tenantFilePath({
    orgId: ORG_A,
    module: 'materials',
    entityId: '../../..',
    fileId: '../../etc',
    fileName: '../../../passwd',
  });
  check('traversal segments are neutralised', !evil.includes('..'), evil);
  check('and the result still belongs to the organization', pathBelongsToOrg(evil, ORG_A), evil);
  eq('sanitizeSegment strips separators', sanitizeSegment('a/b\\c'), 'a_b_c');
  eq('sanitizeSegment collapses dot runs', sanitizeSegment('..'), 'file');
  eq('sanitizeSegment never returns empty', sanitizeSegment(''), 'file');

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nno organization means no tenant file');
  // ══════════════════════════════════════════════════════════════════════════

  check('a tenant path cannot be authorized without an org', !pathBelongsToOrg(aMaterial, null));
  check('or with an empty org', !pathBelongsToOrg(aMaterial, ''));

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nlegacy files are recognised as legacy, not silently trusted');
  // ══════════════════════════════════════════════════════════════════════════

  check('an old shared path is legacy', isLegacyPath('materials/11/Physics/x.pdf'));
  check('a new tenant path is not legacy', !isLegacyPath(aMaterial));
  check(
    'a legacy path is NOT authorized by path alone — it carries no owner',
    !pathBelongsToOrg('materials/11/Physics/x.pdf', ORG_A),
  );

  const publicUrl = `https://storage.googleapis.com/my-bucket/${aMaterial}`;
  check('an absolute URL is detected', isAbsoluteUrl(publicUrl));
  eq('and its storage path is recoverable', storagePathFromPublicUrl(publicUrl, 'my-bucket'), aMaterial);
  eq(
    'a URL for a DIFFERENT bucket yields nothing',
    storagePathFromPublicUrl(publicUrl, 'other-bucket'),
    null,
  );

  // The compatibility rule, stated as a test: a legacy public URL that happens
  // to point at a tenant path is still attributable, so an old row can be
  // checked once it has been migrated.
  check(
    'a public URL wrapping a tenant path is attributable to its owner',
    pathBelongsToOrg(storagePathFromPublicUrl(publicUrl, 'my-bucket'), ORG_A),
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\na signed URL cannot be reused across tenants');
  // ══════════════════════════════════════════════════════════════════════════
  // A signed URL is minted for ONE object path. Reuse across tenants would mean
  // org B holding a URL that reads org A's object — which requires org A's path
  // to have been signed for org B, and that is exactly what is refused above.
  // Asserted as the property that makes it true, since the signing itself needs
  // live Firebase.
  const everyOrgAPath = [aMaterial, evil];
  check(
    'no org A path is signable for org B',
    everyOrgAPath.every((p) => !pathBelongsToOrg(p, ORG_B)),
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nmodule and entity survive the round trip');
  // ══════════════════════════════════════════════════════════════════════════

  const parsed = parseTenantPath(aMaterial);
  eq('module', parsed?.module, 'materials');
  eq('entity', parsed?.entityId, '11_Physics');
  eq('file name', parsed?.fileName, 'f1_notes.pdf');

  const noEntity = tenantFilePath({
    orgId: ORG_A,
    module: 'images',
    fileId: 'abc',
    fileName: 'logo.png',
  });
  eq('a module with no entity still parses', parseTenantPath(noEntity)?.module, 'images');
  eq('and has no entity', parseTenantPath(noEntity)?.entityId, undefined);
  check('and still belongs to its org', pathBelongsToOrg(noEntity, ORG_A));

  console.log('');
  if (failures) {
    console.error(`STORAGE TENANCY TESTS FAILED — ${failures} of ${checks}.`);
    process.exit(1);
  }
  console.log(`All ${checks} storage tenancy checks passed.`);
}

main();
