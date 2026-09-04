/**
 * Can this machine reach production Firebase at all? READ ONLY.
 *
 * ── Why this is its own script ──────────────────────────────────────────────
 * `storage-audit.ts` reads SOURCE — it proves no code path can make a file
 * world-readable again. It never touches Firebase, so it cannot answer the
 * question the cutover actually needs: is the production bucket reachable with
 * the credentials available here, and what is in it.
 *
 * That distinction matters because a previous phase recorded that the local
 * service-account key fails `invalid_grant` for Storage, Firestore AND Auth.
 * If that is still true, every Firebase step of the cutover is BLOCKED on
 * someone with console access rather than on any code — and a checklist that
 * did not say so would send someone to run a migration that cannot start.
 *
 * ── Strictly read-only ──────────────────────────────────────────────────────
 * It lists and it counts. It does not upload, delete, change an ACL, or write
 * a metadata field. The one thing it deliberately does NOT do is attempt a
 * write to see whether writes work: finding out by doing it is exactly the
 * failure mode the whole programme has been avoiding.
 *
 *   npx ts-node --transpile-only scripts/safety/firebase-access-check.ts
 */

import { config } from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

config();

interface Result {
  area: string;
  ok: boolean;
  detail: string;
}

const results: Result[] = [];
function record(area: string, ok: boolean, detail: string): void {
  results.push({ area, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${area.padEnd(22)} ${detail}`);
}

async function main(): Promise<void> {
  console.log('\nFIREBASE ACCESS — READ ONLY\n');

  // ── 1. What credentials exist here ───────────────────────────────────────
  const keyPath = join(process.cwd(), '..', 'cbt-exam-be', 'firebase-admin.json');
  const hasKeyFile = existsSync(keyPath);
  let projectId = '';
  let clientEmail = '';
  if (hasKeyFile) {
    try {
      const key = JSON.parse(readFileSync(keyPath, 'utf8'));
      projectId = key.project_id ?? '';
      clientEmail = key.client_email ?? '';
    } catch {
      /* unreadable */
    }
  }
  record('service account file', hasKeyFile, hasKeyFile ? `${projectId || 'unknown project'}` : 'absent');
  if (clientEmail) console.log(`      identity: ${clientEmail}`);

  const bucket = process.env.FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_BUCKET || '';
  record('bucket configured', Boolean(bucket), bucket || 'FIREBASE_STORAGE_BUCKET is unset');

  if (!hasKeyFile) {
    console.log('\n  No credentials on this machine — every Firebase step is BLOCKED here.');
    return;
  }

  // ── 2. Does the credential actually authenticate ─────────────────────────
  let admin: typeof import('firebase-admin');
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    admin = require('firebase-admin');
  } catch (error) {
    record('firebase-admin sdk', false, (error as Error).message);
    return;
  }

  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(readFileSync(keyPath, 'utf8'))),
        storageBucket: bucket || undefined,
      });
    }
    record('sdk initialised', true, 'credential parsed and app created');
  } catch (error) {
    record('sdk initialised', false, (error as Error).message);
    return;
  }

  // ── 3. Storage: list a single object ─────────────────────────────────────
  // One object is enough to prove the token is accepted, and cheap enough to
  // run against a bucket of any size.
  try {
    const [files] = await admin.storage().bucket().getFiles({ maxResults: 1 });
    record('storage read', true, `bucket reachable, ${files.length} object sampled`);

    // The P9A question: is anything still world-readable?
    if (files.length) {
      const [meta] = await files[0].getMetadata();
      const isPublic = JSON.stringify(meta.acl ?? []).includes('allUsers');
      record('sampled object acl', !isPublic, isPublic ? 'PUBLIC (allUsers)' : 'not world-readable');
    }
  } catch (error) {
    const message = (error as Error).message.split('\n')[0];
    record('storage read', false, message);
  }

  // ── 3b. Size the legacy-file migration ───────────────────────────────────
  // Bounded on purpose: a full listing of an unknown bucket is an unbounded
  // operation, and the cutover needs an ORDER OF MAGNITUDE, not an exact
  // census. The two legacy path families are the ones P9A identified as
  // sharing a namespace between institutes.
  try {
    const LIMIT = 2000;
    const [sample] = await admin.storage().bucket().getFiles({ maxResults: LIMIT });
    let publicCount = 0;
    let legacyMaterials = 0;
    let legacyStudy = 0;
    let tenantScoped = 0;

    for (const file of sample) {
      const name = file.name;
      if (name.startsWith('materials/')) legacyMaterials++;
      else if (name.startsWith('study-resources/')) legacyStudy++;
      else if (name.startsWith('organizations/')) tenantScoped++;
      const acl = (file.metadata as { acl?: unknown }).acl;
      if (acl && JSON.stringify(acl).includes('allUsers')) publicCount++;
    }

    record(
      'bucket sample',
      true,
      `${sample.length}${sample.length === LIMIT ? '+ (capped)' : ''} objects examined`,
    );
    record('world-readable in sample', publicCount === 0, `${publicCount}`);
    console.log(`      legacy materials/…        ${legacyMaterials}`);
    console.log(`      legacy study-resources/…  ${legacyStudy}`);
    console.log(`      organizations/…           ${tenantScoped}`);
  } catch (error) {
    record('bucket sample', false, (error as Error).message.split('\n')[0]);
  }

  // ── 4. Auth: read one user ───────────────────────────────────────────────
  try {
    const page = await admin.auth().listUsers(1);
    record('auth read', true, `reachable, ${page.users.length} user sampled`);
  } catch (error) {
    record('auth read', false, (error as Error).message.split('\n')[0]);
  }

  // ── 5. Firestore: read one document ──────────────────────────────────────
  try {
    const snapshot = await admin.firestore().listCollections();
    record('firestore read', true, `${snapshot.length} top-level collection(s)`);
  } catch (error) {
    record('firestore read', false, (error as Error).message.split('\n')[0]);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length) {
    console.log(`  ${failed.length} of ${results.length} checks could not complete from this machine.`);
    console.log('  Firebase cutover steps are BLOCKED on credentials/console access, not on code.');
  } else {
    console.log(`  All ${results.length} Firebase reads succeeded from this machine.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
