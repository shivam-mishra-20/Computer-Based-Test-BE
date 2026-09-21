/**
 * Doubt attachments have to be fetchable by the client.
 *
 * ── The reported failure ────────────────────────────────────────────────────
 * "Users are able to upload images but the image is not rendered after
 * uploading or sending." The upload was never the problem — every byte reached
 * storage. The READ was.
 *
 * Two distinct breakages, both left over from the world before `putTenantFile`
 * made new objects PRIVATE:
 *
 *   1. REST reads returned `attachments[].url` untouched. Since the upload
 *      began storing a PATH, the app received `legacy/doubts/…` and put it
 *      straight into an <Image>, which of course renders nothing.
 *
 *   2. The socket payload — and `getDoubtFiles` — REWROTE the path into
 *      `https://storage.googleapis.com/<bucket>/<path>`. That was right while
 *      every object carried a public ACL. Against a private object it is a
 *      link that 403s, which is why "sent it, saw nothing" was the symptom
 *      rather than "saw a broken path".
 *
 * A fabricated public URL for a private object is not a fallback — it is a URL
 * that cannot ever work, and it is the specific thing this suite forbids.
 *
 *   npx ts-node --transpile-only scripts/safety/doubt-attachments.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

process.env.TENANT_MODE = process.env.TENANT_MODE || 'claim';
process.env.TENANT_ENFORCEMENT = 'warn';

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  signDoubtAttachments,
  signDoubtListAttachments,
  signDoubtMessageAttachments,
} from '../../src/core/storage/serialize';
import { LEGACY_PREFIX, TENANT_PREFIX } from '../../src/core/storage/paths';

const ORG_A = '6a8441e8c4c17e061913e297';

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

const doubtWith = (attachments: any[]) => ({
  _id: 'd1',
  messages: [{ _id: 'm1', message: '📎 Image', attachments }],
});

async function main() {
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nthe stored value is a PATH — it never reaches the client raw');
  // ══════════════════════════════════════════════════════════════════════════

  // Firebase is not contacted: a tenant path that does not belong to the
  // caller is refused BEFORE signing, which is the branch exercised here. The
  // point being pinned is that the raw path never survives.
  const crossOrg = doubtWith([
    {
      url: `${TENANT_PREFIX}/someone-else/doubts/d1/f1_photo.jpg`,
      storagePath: `${TENANT_PREFIX}/someone-else/doubts/d1/f1_photo.jpg`,
      fileType: 'image/jpeg',
    },
  ]);
  await signDoubtAttachments(crossOrg, ORG_A);
  const a0 = crossOrg.messages[0].attachments[0];
  check(
    "another organization's attachment is not handed over",
    a0.url === '',
    a0.url,
  );
  check(
    'and the raw path is gone from the response',
    !String(a0.url).startsWith(TENANT_PREFIX),
    a0.url,
  );
  check(
    'the rest of the message survives',
    crossOrg.messages[0].message === '📎 Image',
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nlegacy public URLs pass through untouched');
  // ══════════════════════════════════════════════════════════════════════════

  // Rows written before the hardening store a real, still-public URL. Signing
  // them would imply a privacy the object does not have.
  const legacyUrl = 'https://storage.googleapis.com/bucket/doubts/d1/old.jpg';
  const legacyDoubt = doubtWith([{ url: legacyUrl, fileType: 'image/jpeg' }]);
  await signDoubtAttachments(legacyDoubt, ORG_A);
  eq(
    'an absolute URL is returned unchanged',
    legacyDoubt.messages[0].attachments[0].url,
    legacyUrl,
  );

  // storagePath wins when both are present, because it is the authoritative one.
  const both = doubtWith([
    {
      url: legacyUrl,
      storagePath: `${TENANT_PREFIX}/${'nope'}/doubts/d/f_x.jpg`,
      fileType: 'image/jpeg',
    },
  ]);
  await signDoubtAttachments(both, ORG_A);
  check(
    'storagePath is preferred over a stale url field',
    both.messages[0].attachments[0].url !== legacyUrl,
    both.messages[0].attachments[0].url,
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nmalformed and empty shapes are survivable');
  // ══════════════════════════════════════════════════════════════════════════

  await signDoubtMessageAttachments(undefined);
  await signDoubtMessageAttachments(null);
  await signDoubtMessageAttachments([]);
  await signDoubtMessageAttachments([
    {},
    { attachments: null },
    { attachments: [] },
  ]);
  await signDoubtAttachments(null);
  await signDoubtAttachments(undefined);
  eq(
    'a list of nothing is a list of nothing',
    await signDoubtListAttachments([]),
    [],
  );
  check('none of the above threw', true);

  const noPath = doubtWith([{ fileName: 'x.jpg', fileType: 'image/jpeg' }]);
  await signDoubtAttachments(noPath, ORG_A);
  check(
    'an attachment with no reference is left alone',
    noPath.messages[0].attachments[0].url === undefined,
    String(noPath.messages[0].attachments[0].url),
  );

  // A whole inbox at once.
  const inbox = [
    doubtWith([{ url: legacyUrl, fileType: 'image/jpeg' }]),
    doubtWith([]),
  ];
  await signDoubtListAttachments(inbox, ORG_A);
  eq(
    'every doubt in a list is processed',
    inbox[0].messages[0].attachments[0].url,
    legacyUrl,
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nno route fabricates a public URL for a private object');
  // ══════════════════════════════════════════════════════════════════════════

  const doubtSrc = readFileSync(
    join(process.cwd(), 'src', 'routes', 'api', 'doubtRoutes.ts'),
    'utf8',
  );
  const fileSrc = readFileSync(
    join(process.cwd(), 'src', 'controllers', 'fileController.ts'),
    'utf8',
  );
  const stripComments = (t: string) =>
    t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const FABRICATION = /https:\/\/storage\.googleapis\.com\/\$\{/;
  check(
    'doubtRoutes builds no storage.googleapis.com URL',
    !FABRICATION.test(stripComments(doubtSrc)),
  );
  check(
    'fileController builds none either',
    !FABRICATION.test(stripComments(fileSrc)),
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nevery doubts response and the socket payload are signed');
  // ══════════════════════════════════════════════════════════════════════════

  // A read that forgets to sign is the bug, so the count is pinned: every
  // handler that returns a doubt, and the socket emit, must call the signer.
  const signerCalls = (
    doubtSrc.match(/signDoubtAttachments\(|signDoubtListAttachments\(/g) || []
  ).length;
  check(
    'at least seven call sites (three inboxes, three detail responses, one emit)',
    signerCalls >= 7,
    `found ${signerCalls}`,
  );
  check(
    'the socket payload is signed before it is emitted',
    /await signDoubtAttachments\(populated\);[\s\S]{0,600}?SocketService\.emitDoubtUpdate\(/.test(
      doubtSrc,
    ),
  );
  check(
    'the thread detail is signed before it is returned',
    /await signDoubtAttachments\(detail\);[\s\S]{0,200}?return res\.json\(detail\);/.test(
      doubtSrc,
    ),
  );
  check(
    'getDoubtFiles resolves rather than constructs',
    /resolveFileUrl\(file\.storagePath \|\| file\.url/.test(fileSrc),
  );

  // The upload response must keep returning the PATH. Returning a signed URL
  // there would put an EXPIRING url into the message the client then stores.
  check(
    'the upload response still hands back the storage path',
    /const publicUrl = storagePath;/.test(fileSrc),
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nthe no-organization namespace is reachable, not published');
  // ══════════════════════════════════════════════════════════════════════════

  // Legacy-deployment uploads land in `legacy/…`. Those are PRIVATE and must be
  // signed — never turned into a bare public URL, which is what the old code
  // did to anything that was not already `https://`.
  check(
    'the serializer routes a legacy-namespace path through resolveFileUrl',
    readFileSync(
      join(process.cwd(), 'src', 'core', 'storage', 'serialize.ts'),
      'utf8',
    ).includes('resolveFileUrl(stored, { orgId })'),
  );
  check(
    'and that namespace is not treated as publicly readable',
    !new RegExp(`storage\\.googleapis\\.com[^\\n]*${LEGACY_PREFIX}`).test(
      stripComments(doubtSrc) + stripComments(fileSrc),
    ),
  );

  console.log(
    `\n${failures ? '✗ FAILED' : '✓ PASSED'} — ${checks - failures}/${checks} checks\n`,
  );
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error('\nharness error:', err);
  process.exit(1);
});
