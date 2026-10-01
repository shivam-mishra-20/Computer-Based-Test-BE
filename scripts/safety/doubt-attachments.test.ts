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
process.env.FIREBASE_STORAGE_BUCKET = 'test-bucket';

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  signDoubtAttachments,
  signDoubtListAttachments,
  signDoubtMessageAttachments,
} from '../../src/core/storage/serialize';
import {
  isBareDoubtPath,
  isDoubtFolderPath,
  LEGACY_PREFIX,
  pathBelongsToOrg,
  TENANT_PREFIX,
} from '../../src/core/storage/paths';
import * as storageService from '../../src/core/storage/storageService';
import { resolveStorageTarget } from '../../src/core/storage/storageService';

const ORG_A = '6a8441e8c4c17e061913e297';
const DOUBT_ID = '68d5a1f2c4c17e061913e2aa';
const OTHER_DOUBT = '68d5a1f2c4c17e061913e2bb';

// Firebase is never contacted. `serialize.ts` reads `signUnchecked` off the
// module at call time, so replacing the export stands in for the bucket, and
// every path it is asked to sign is recorded.
const signed: string[] = [];
let signingFails = false;
(storageService as { signUnchecked: unknown }).signUnchecked = async (path: string) => {
  if (signingFails) throw new Error('no credential');
  signed.push(path);
  return `https://signed.example/${path}?X-Goog-Signature=x`;
};

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
    /resolveDoubtFileUrl\(file\.storagePath \|\| file\.url, doubtId/.test(fileSrc),
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
    ).includes('return resolveFileUrl(stored, { orgId })'),
  );
  check(
    'and that namespace is not treated as publicly readable',
    !new RegExp(`storage\\.googleapis\\.com[^\\n]*${LEGACY_PREFIX}`).test(
      stripComments(doubtSrc) + stripComments(fileSrc),
    ),
  );


  // ══════════════════════════════════════════════════════════════════════════
  console.log("\nthe app's own uploads (bare doubts/{doubtId}/…) are signed, not published");
  // ══════════════════════════════════════════════════════════════════════════

  // The second report of the same symptom. The app uploads through
  // `/upload-url`, which issued `doubts/{doubtId}/…`; P9A stopped making those
  // objects public but `resolveFileUrl` still treats a bare path as a public
  // pre-tenant object, so the client got an unsigned URL that 403s.
  const barePath = `doubts/${DOUBT_ID}/1758817518078_photo.jpg`;
  const unsignedPublic = `https://storage.googleapis.com/test-bucket/${barePath}`;

  const appUpload = {
    _id: { toString: () => DOUBT_ID }, // what a populated document carries
    messages: [
      {
        message: '📎 Image',
        attachments: [{ url: barePath, storagePath: barePath, fileType: 'image/jpeg' }],
      },
    ],
  };
  await signDoubtAttachments(appUpload, null);
  const appAtt = appUpload.messages[0].attachments[0];
  check(
    "an attachment in this doubt's folder gets a signed URL",
    signed.includes(barePath) && appAtt.url.includes('X-Goog-Signature'),
    appAtt.url,
  );
  check(
    'and never the unsigned public URL that 403s',
    appAtt.url !== unsignedPublic,
    appAtt.url,
  );

  const urlOnly: any = doubtWith([{ url: barePath, fileType: 'image/jpeg' }]);
  urlOnly._id = DOUBT_ID;
  await signDoubtAttachments(urlOnly, null);
  check(
    'a row that only carries `url` is signed the same way',
    urlOnly.messages[0].attachments[0].url.includes('X-Goog-Signature'),
    urlOnly.messages[0].attachments[0].url,
  );

  // A client can put any path into a message. Naming another conversation's
  // file must not get it signed on the strength of THIS conversation.
  signed.length = 0;
  const foreign = `doubts/${OTHER_DOUBT}/1758817518078_theirs.jpg`;
  const borrowed: any = doubtWith([{ url: foreign, storagePath: foreign, fileType: 'image/jpeg' }]);
  borrowed._id = DOUBT_ID;
  await signDoubtAttachments(borrowed, null);
  check(
    "another doubt's file is not signed through this one",
    !signed.includes(foreign) &&
      !String(borrowed.messages[0].attachments[0].url).includes('X-Goog-Signature'),
    borrowed.messages[0].attachments[0].url,
  );

  const inboxOfTwo: any[] = [
    { _id: DOUBT_ID, messages: [{ attachments: [{ storagePath: barePath }] }] },
    {
      _id: OTHER_DOUBT,
      messages: [{ attachments: [{ storagePath: `doubts/${OTHER_DOUBT}/1_x.jpg` }] }],
    },
  ];
  await signDoubtListAttachments(inboxOfTwo, null);
  check(
    'an inbox signs each doubt against its own id',
    inboxOfTwo.every((d) =>
      String(d.messages[0].attachments[0].url).includes('X-Goog-Signature'),
    ),
  );

  signingFails = true;
  const unsignable: any = doubtWith([{ storagePath: barePath, fileType: 'image/jpeg' }]);
  unsignable._id = DOUBT_ID;
  await signDoubtAttachments(unsignable, null);
  eq(
    'a signing failure is a missing image, not a failed conversation',
    unsignable.messages[0].attachments[0].url,
    '',
  );
  signingFails = false;

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nwhich paths belong to a doubt');
  // ══════════════════════════════════════════════════════════════════════════

  const folderCases: Array<[string, string, boolean]> = [
    [`doubts/${DOUBT_ID}/f.jpg`, 'bare', true],
    [`/doubts/${DOUBT_ID}/f.jpg`, 'bare, leading slash', true],
    [`doubts/${DOUBT_ID}/msg1/f.jpg`, 'bare, with the old message folder', true],
    [`doubts/${DOUBT_ID}`, 'bare, no file', false],
    [`doubts/${OTHER_DOUBT}/f.jpg`, 'bare, another doubt', false],
    [`doubts/${DOUBT_ID}x/f.jpg`, 'bare, id prefix only', false],
    [`${LEGACY_PREFIX}/doubts/${DOUBT_ID}/abc_f.jpg`, 'no-organization', true],
    [`${LEGACY_PREFIX}/doubts/${DOUBT_ID}_m1/abc_f.jpg`, 'no-organization, per message', true],
    [`${LEGACY_PREFIX}/doubts/${OTHER_DOUBT}/abc_f.jpg`, 'no-organization, another doubt', false],
    [`${LEGACY_PREFIX}/homework/${DOUBT_ID}/abc_f.jpg`, 'no-organization, another module', false],
    [`${TENANT_PREFIX}/${ORG_A}/doubts/${DOUBT_ID}/abc_f.jpg`, 'tenant', true],
    [`${TENANT_PREFIX}/${ORG_A}/homework/${DOUBT_ID}/abc_f.jpg`, 'tenant, another module', false],
    [`https://storage.googleapis.com/b/doubts/${DOUBT_ID}/f.jpg`, 'an absolute URL', false],
    ['', 'empty', false],
  ];
  for (const [path, label, expected] of folderCases) {
    eq(`isDoubtFolderPath — ${label}`, isDoubtFolderPath(path, DOUBT_ID), expected);
  }
  eq('a non-ObjectId doubt id matches nothing', isDoubtFolderPath('doubts/x/f.jpg', 'x'), false);
  eq('isBareDoubtPath — bare', isBareDoubtPath(`doubts/${DOUBT_ID}/f.jpg`, DOUBT_ID), true);
  eq(
    'isBareDoubtPath — the private namespaces are not "bare"',
    isBareDoubtPath(`${LEGACY_PREFIX}/doubts/${DOUBT_ID}/abc_f.jpg`, DOUBT_ID) ||
      isBareDoubtPath(`${TENANT_PREFIX}/${ORG_A}/doubts/${DOUBT_ID}/abc_f.jpg`, DOUBT_ID),
    false,
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n/upload-url issues the same private paths as /upload');
  // ══════════════════════════════════════════════════════════════════════════

  const noOrgTarget = resolveStorageTarget({
    fileName: 'photo 1.jpg',
    module: 'doubts',
    entityId: DOUBT_ID,
    orgId: null,
  });
  check(
    'without an organization it lands in the private namespace, in the doubt folder',
    noOrgTarget.storagePath.startsWith(`${LEGACY_PREFIX}/doubts/${DOUBT_ID}/`) &&
      isDoubtFolderPath(noOrgTarget.storagePath, DOUBT_ID),
    noOrgTarget.storagePath,
  );
  const orgTarget = resolveStorageTarget({
    fileName: 'photo.jpg',
    module: 'doubts',
    entityId: DOUBT_ID,
    orgId: ORG_A,
  });
  check(
    'with one it is tenant-owned, in the doubt folder',
    pathBelongsToOrg(orgTarget.storagePath, ORG_A) &&
      isDoubtFolderPath(orgTarget.storagePath, DOUBT_ID),
    orgTarget.storagePath,
  );

  const uploadUrlSrc = stripComments(fileSrc).split('export const generateUploadUrl')[1] || '';
  check(
    'generateUploadUrl takes its path from resolveStorageTarget',
    /resolveStorageTarget\(\{[\s\S]{0,120}module: 'doubts'/.test(uploadUrlSrc),
  );
  check(
    'and no longer builds a bare doubts/ path',
    !/`doubts\/\$\{/.test(uploadUrlSrc),
  );
  // These two hand out SIGNED URLs for private objects, so a doubt id or a
  // file id alone must not be enough — the caller has to be in the doubt.
  for (const handler of ['getFileSignedUrl', 'getDoubtFiles']) {
    const body = stripComments(fileSrc).split(`export const ${handler}`)[1]?.split('export const')[0] || '';
    check(
      `${handler} checks the caller is in the doubt before signing`,
      /callerCanReadDoubt\(req, doubtId\)[\s\S]*resolveDoubtFileUrl\(/.test(body),
    );
  }
  check(
    "save-file-metadata only records a path from the doubt's own folder",
    /isDoubtFolderPath\(storagePath, String\(doubtId\)\)/.test(stripComments(doubtSrc)),
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
