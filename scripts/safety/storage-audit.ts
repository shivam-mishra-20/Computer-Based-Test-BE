/**
 * Object storage must stay tenant-safe.
 *
 * ── What this prevents coming back ──────────────────────────────────────────
 * Before P9A every uploaded file was world-readable and two path families were
 * shared between institutes:
 *
 *   materials/{classLevel}/{subject}/…      both segments are TENANT values
 *   study-resources/pdfs/{classLevel}/…     same
 *
 * The fix is only durable if the old way stops being reachable. This fails the
 * build when `uploadToFirebase` — the uploader that always called
 * `makePublic()` — regains a caller, and when a literal storage path is built
 * outside the tenant helpers.
 *
 *   npx ts-node --transpile-only scripts/safety/storage-audit.ts
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(process.cwd(), 'src');

/** The only file allowed to define or mention the deprecated uploader. */
const UPLOADER_HOME = 'services/firebaseService.ts';

/**
 * Path prefixes that were tenant-unsafe. A string literal starting with one of
 * these, outside the storage core, means someone is building a path by hand
 * again.
 */
const FORBIDDEN_PREFIXES = [
  'materials/',
  'study-resources/',
  'homework/',
  'diagrams/',
  'profile-images/',
  'schedule-imports/',
  'registration-profiles/',
];

const STORAGE_CORE = ['core/storage/paths.ts', 'core/storage/storageService.ts'];

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

/** Remove block and line comments so documentation cannot trip the audit. */
function stripComments(text: string): string {
  const NL = String.fromCharCode(10);
  return text
    .split(NL)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join(NL);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function main() {
  console.log('Object storage tenancy\n');
  const files = walk(SRC).map((f) => relative(SRC, f).split('\\').join('/'));

  // ── The deprecated uploader has no callers ────────────────────────────────
  const callers: string[] = [];
  for (const file of files) {
    if (file === UPLOADER_HOME) continue;
    const text = readFileSync(join(SRC, file), 'utf8');
    // A call, not merely the word in a comment.
    if (/\buploadToFirebase\s*\(/.test(text)) callers.push(file);
  }
  check(
    'uploadToFirebase() has no callers — every upload goes through the tenant helpers',
    callers.length === 0,
    callers.length
      ? `called from:\n      ${callers.join('\n      ')}\n      ` +
        `Use putTenantFile() for tenant files, or putPublicTenantAsset() for an ` +
        `asset that must stay publicly fetchable.`
      : '',
  );

  // ── makePublic() is confined to the one explicit helper ───────────────────
  const publicCallers: string[] = [];
  for (const file of files) {
    if (STORAGE_CORE.includes(file) || file === UPLOADER_HOME) continue;
    const text = stripComments(readFileSync(join(SRC, file), 'utf8'));
    if (/\.makePublic\s*\(|public:\s*true/.test(text)) publicCallers.push(file);
  }
  check(
    'nothing outside the storage core makes an object public',
    publicCallers.length === 0,
    publicCallers.join(', '),
  );

  // ── No hand-built storage paths ───────────────────────────────────────────
  const handBuilt: string[] = [];
  for (const file of files) {
    if (STORAGE_CORE.includes(file)) continue;
    // Comments are stripped first. Every one of these prefixes is NAMED in a
    // comment somewhere, explaining what it used to be and why it changed.
    // Matching those would make the audit fail on its own documentation, and
    // the obvious way to "fix" that would be deleting the explanation.
    const text = stripComments(readFileSync(join(SRC, file), 'utf8'));
    for (const prefix of FORBIDDEN_PREFIXES) {
      // A template or plain string literal that STARTS with the prefix.
      const pattern = new RegExp('[\'"`]' + prefix.split('/').join('\\/'));
      if (pattern.test(text)) handBuilt.push(`${file} — "${prefix}…"`);
    }
  }
  check(
    'no tenant-unsafe storage path is built by hand',
    handBuilt.length === 0,
    handBuilt.length
      ? `${handBuilt.join('\n      ')}\n      ` +
        `Paths come from core/storage/paths.ts, which puts every tenant object ` +
        `under organizations/{orgId}/.`
      : '',
  );

  // ── The storage core exists and exports what callers need ─────────────────
  const service = readFileSync(join(SRC, 'core/storage/storageService.ts'), 'utf8');
  for (const symbol of [
    'putTenantFile',
    'putPublicTenantAsset',
    'signedUrlForTenantPath',
    'resolveFileUrl',
    'deleteTenantFile',
  ]) {
    check(`storageService exports ${symbol}`, service.includes(`export async function ${symbol}`) || service.includes(`export function ${symbol}`));
  }

  // Only the BODY of putTenantFile. Scanning the whole file matched
  // putPublicTenantAsset further down, which sets a public ACL on purpose —
  // an audit that cannot tell the private uploader from the public one is
  // not checking anything.
  const privateBody = service.slice(
    service.indexOf('export async function putTenantFile'),
    service.indexOf('export async function signedUrlForTenantPath'),
  );
  check(
    'putTenantFile never sets a public ACL',
    privateBody.length > 0 && !/makePublic|public:\s*true/.test(stripComments(privateBody)),
    'a private uploader that makes objects public is the bug this phase fixed',
  );

  console.log('');
  if (failures) {
    console.error(`STORAGE AUDIT FAILED — ${failures} of ${checks}.`);
    process.exit(1);
  }
  console.log(`Storage audit passed — ${checks} checks.`);
}

main();
