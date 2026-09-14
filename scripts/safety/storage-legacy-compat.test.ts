/**
 * Storage without an organization — the legacy compatibility surface.
 *
 * ── The production failure this locks down ──────────────────────────────────
 *     POST /api/homework/{id}/upload  ->  500
 *     StorageAccessDenied: Cannot store a tenant file without an organization
 *     context.
 *
 * `putTenantFile` was unconditionally fail-closed. That is right once isolation
 * is live and wrong for the deployment serving abhigyan-gurukul-app, where most
 * requests have never carried an organization — so homework, materials, study
 * resources and doubt attachments all broke at once, to enforce in one
 * subsystem a guarantee the rest of the system is not yet making.
 *
 * There were TWO ways to arrive at that error, and both are covered here:
 *
 *   1. The request genuinely had no organization (legacy deployment).
 *   2. The request HAD one and multer destroyed it — multer consumes the
 *      request stream and resumes the chain from the socket's async context,
 *      where the AsyncLocalStorage store no longer exists. Every upload route
 *      sat behind that boundary, so even a perfectly org-scoped request reached
 *      storage with nothing.
 *
 * Fixing only (1) would have been worse than the bug: an org-carrying request
 * whose context was eaten would have silently written to the unattributed
 * namespace instead of erroring, and nobody would have found out until the
 * backfill.
 *
 * ── What runs here ──────────────────────────────────────────────────────────
 * The real path builders, the real decision function, the real tenancy config,
 * the real multer instance the routes use, and a real HTTP server over a real
 * socket. `resolveStorageTarget` is separated from the upload precisely so the
 * attribution decision can be exercised exhaustively without a credential — the
 * same discipline `pathBelongsToOrg` already follows. Firebase `file.save()` is
 * NOT called: this machine's .env carries live credentials and a test must not
 * write into the real bucket.
 *
 *   npx ts-node --transpile-only scripts/safety/storage-legacy-compat.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import express, { Request, Response } from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.TENANT_MODE = process.env.TENANT_MODE || 'claim';
process.env.TENANT_ENFORCEMENT = 'warn';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'storage-legacy-compat-test-secret';

mongoose.set('bufferCommands', false);

import {
  resolveStorageTarget,
  signedUrlForTenantPath,
  deleteTenantFile,
  ownerOrgIdOf,
  StorageAccessDenied,
} from '../../src/core/storage/storageService';
import {
  isLegacyNamespacePath,
  isLegacyPath,
  LEGACY_PREFIX,
  parseTenantPath,
  pathBelongsToOrg,
  TENANT_PREFIX,
  type StorageModule,
} from '../../src/core/storage/paths';
import { legacyStorageCompatEnabled } from '../../src/core/tenancy/config';
import {
  runWithTenant,
  runWithoutAnyContext,
  currentOrgId,
} from '../../src/core/tenancy/context';
import { tenantContextMiddleware } from '../../src/middlewares/tenantContext';
import { upload } from '../../src/middlewares/upload';

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

function expectDenied(label: string, fn: () => unknown) {
  try {
    fn();
    check(label, false, 'no error thrown');
  } catch (err) {
    check(label, err instanceof StorageAccessDenied, String(err));
  }
}

/** Every feature that stores a file through the tenant helper. */
const UPLOAD_FEATURES: Array<{
  feature: string;
  module: StorageModule;
  entityId?: string;
}> = [
  {
    feature: 'Homework',
    module: 'homework',
    entityId: '6aa7e5efacaa3b5f2541b564',
  },
  { feature: 'Materials', module: 'materials', entityId: '11_Physics' },
  {
    feature: 'Study Resources',
    module: 'study-resources',
    entityId: '11_Physics',
  },
  { feature: 'Doubts', module: 'doubts', entityId: 'doubt123_msg456' },
  { feature: 'Schedule', module: 'schedule' },
  { feature: 'AI content', module: 'ai-content', entityId: 'gen789' },
  { feature: 'Profile image', module: 'profile', entityId: 'user123' },
  { feature: 'Images', module: 'images' },
  { feature: 'Diagrams', module: 'diagrams', entityId: 'q42' },
  { feature: 'Imports', module: 'imports', entityId: 'paper1' },
];

function targetFor(f: (typeof UPLOAD_FEATURES)[number], orgId: string | null) {
  const input = {
    buffer: Buffer.from('x'),
    fileName: 'homework.pdf',
    contentType: 'application/pdf',
    module: f.module,
    entityId: f.entityId,
  };
  return orgId
    ? runWithTenant({ orgId, source: 'session' as const }, () =>
        resolveStorageTarget(input),
      )
    : runWithoutAnyContext(() => resolveStorageTarget(input));
}

async function main() {
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nthe compatibility switch is the one that already exists');
  // ══════════════════════════════════════════════════════════════════════════

  eq(
    'under warn, legacy storage is permitted',
    legacyStorageCompatEnabled(),
    true,
  );
  process.env.TENANT_ENFORCEMENT = 'enforce';
  eq('under enforce it is NOT', legacyStorageCompatEnabled(), false);
  process.env.TENANT_ENFORCEMENT = 'off';
  eq('under off it is permitted', legacyStorageCompatEnabled(), true);
  process.env.TENANT_ENFORCEMENT = 'warn';
  check(
    'it is read from TENANT_ENFORCEMENT, not a new flag',
    readFileSync(
      join(process.cwd(), 'src', 'core', 'tenancy', 'config.ts'),
      'utf8',
    ).includes("return tenantEnforcement() !== 'enforce';"),
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nevery upload feature works WITHOUT an organization');
  // ══════════════════════════════════════════════════════════════════════════

  const rows: string[] = [];
  for (const f of UPLOAD_FEATURES) {
    let target: ReturnType<typeof resolveStorageTarget> | null = null;
    let error: unknown = null;
    try {
      target = targetFor(f, null);
    } catch (err) {
      error = err;
    }
    check(
      `${f.feature}: no STORAGE_ACCESS_DENIED without an organization`,
      error === null && target !== null,
      String(error),
    );
    if (!target) continue;
    check(
      `${f.feature}: stored under the no-organization namespace`,
      target.kind === 'legacy' &&
        target.storagePath.startsWith(`${LEGACY_PREFIX}/`),
      target.storagePath,
    );
    check(
      `${f.feature}: NOT under an organization namespace`,
      !target.storagePath.startsWith(`${TENANT_PREFIX}/`),
      target.storagePath,
    );
    eq(`${f.feature}: no organization is invented`, target.orgId, '');
    rows.push(`  ${f.feature.padEnd(16)} legacy -> ${target.storagePath}`);
  }
  console.log(rows.join('\n'));

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nthe same features are tenant-scoped WITH an organization');
  // ══════════════════════════════════════════════════════════════════════════

  for (const f of UPLOAD_FEATURES) {
    const target = targetFor(f, ORG_A);
    check(
      `${f.feature}: organization-scoped path`,
      target.kind === 'tenant' &&
        target.storagePath.startsWith(`${TENANT_PREFIX}/${ORG_A}/`),
      target.storagePath,
    );
    eq(`${f.feature}: orgId preserved`, target.orgId, ORG_A);
    eq(
      `${f.feature}: path names its owner`,
      ownerOrgIdOf(target.storagePath),
      ORG_A,
    );
  }

  // Two organizations never collide, and neither can reach the other.
  const a = targetFor(UPLOAD_FEATURES[0], ORG_A);
  const b = targetFor(UPLOAD_FEATURES[0], ORG_B);
  check(
    'two organizations get different paths',
    a.storagePath !== b.storagePath,
  );
  check('A may read its own', pathBelongsToOrg(a.storagePath, ORG_A));
  check("A may NOT read B's", !pathBelongsToOrg(b.storagePath, ORG_A));
  check("B may NOT read A's", !pathBelongsToOrg(a.storagePath, ORG_B));

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nan unattributed object belongs to NOBODY');
  // ══════════════════════════════════════════════════════════════════════════

  const legacy = targetFor(UPLOAD_FEATURES[0], null);
  eq('it has no owner', ownerOrgIdOf(legacy.storagePath), null);
  check(
    'it does not parse as a tenant path',
    parseTenantPath(legacy.storagePath) === null,
  );
  check('org A cannot claim it', !pathBelongsToOrg(legacy.storagePath, ORG_A));
  check('org B cannot claim it', !pathBelongsToOrg(legacy.storagePath, ORG_B));
  check('nor can an empty org', !pathBelongsToOrg(legacy.storagePath, ''));
  check(
    'it is recognised as the no-org namespace',
    isLegacyNamespacePath(legacy.storagePath),
  );
  check(
    'and is NOT treated as a pre-tenant public object',
    !isLegacyPath(legacy.storagePath),
    'isLegacyPath would publish it as a raw storage.googleapis.com URL',
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nnothing became public, and nothing bypasses authorization');
  // ══════════════════════════════════════════════════════════════════════════

  const service = readFileSync(
    join(process.cwd(), 'src', 'core', 'storage', 'storageService.ts'),
    'utf8',
  );
  // Bounded to the no-organization branch of putTenantFile. Slicing wider
  // would sweep in putPublicTenantAsset, which sets a public ACL on purpose and
  // would make this check pass or fail for the wrong reason.
  const branchStart = service.indexOf(
    'if (!orgId) {',
    service.indexOf('export async function putTenantFile'),
  );
  const branchEnd = service.indexOf('legacy: true,', branchStart);
  check(
    'the no-organization branch was located',
    branchStart > -1 && branchEnd > branchStart,
  );
  // Comments are stripped first, exactly as storage-audit.ts does and for the
  // same reason: the branch CONTAINS the words "no `public: true` and no
  // makePublic()" as its explanation, and a check that matched its own
  // documentation would be fixed by deleting the documentation.
  const stripComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const legacyBranch = stripComments(service.slice(branchStart, branchEnd));
  check(
    'the no-org upload sets no public ACL',
    !/public:\s*true|makePublic\s*\(/.test(legacyBranch),
    legacyBranch.slice(0, 200),
  );
  check(
    'and writes an empty orgId rather than inventing one',
    /orgId: '',/.test(legacyBranch),
  );
  check(
    'no organization id is hardcoded anywhere in the storage core',
    !/ORG_001|org_001|['"]001['"]/.test(service),
  );
  check(
    'resolveFileUrl signs the no-org namespace instead of publishing it',
    service.includes('if (isLegacyNamespacePath(stored)) {') &&
      service.includes('return signedUrlForTenantPath(stored, options);'),
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nthe refusal still happens where it should');
  // ══════════════════════════════════════════════════════════════════════════

  expectDenied('requireOrg refuses a no-org write', () =>
    runWithoutAnyContext(() =>
      resolveStorageTarget({
        buffer: Buffer.from('x'),
        fileName: 'x.pdf',
        contentType: 'application/pdf',
        module: 'homework',
        requireOrg: true,
      }),
    ),
  );

  process.env.TENANT_ENFORCEMENT = 'enforce';
  expectDenied('under enforce, a no-org write is refused again', () =>
    runWithoutAnyContext(() =>
      resolveStorageTarget({
        buffer: Buffer.from('x'),
        fileName: 'x.pdf',
        contentType: 'application/pdf',
        module: 'homework',
      }),
    ),
  );
  let signDenied = false;
  await signedUrlForTenantPath(legacy.storagePath).catch((e) => {
    signDenied = e instanceof StorageAccessDenied;
  });
  check('and an unattributed object is not signable under enforce', signDenied);
  let delDenied = false;
  await deleteTenantFile(legacy.storagePath).catch((e) => {
    delDenied = e instanceof StorageAccessDenied;
  });
  check('nor deletable under enforce', delDenied);
  process.env.TENANT_ENFORCEMENT = 'warn';

  // Cross-organization access is refused in BOTH modes — this is the property
  // the compatibility path must not have loosened.
  let crossSign = false;
  await signedUrlForTenantPath(b.storagePath, { orgId: ORG_A }).catch((e) => {
    crossSign = e instanceof StorageAccessDenied;
  });
  check("org A cannot sign org B's file", crossSign);
  let crossDelete = false;
  await deleteTenantFile(b.storagePath, { orgId: ORG_A }).catch((e) => {
    crossDelete = e instanceof StorageAccessDenied;
  });
  check("org A cannot delete org B's file", crossDelete);
  let noCtxSign = false;
  await runWithoutAnyContext(async () => {
    await signedUrlForTenantPath(a.storagePath).catch((e) => {
      noCtxSign = e instanceof StorageAccessDenied;
    });
  });
  check('a no-org caller cannot sign an organization-owned file', noCtxSign);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\na traversing name cannot escape either namespace');
  // ══════════════════════════════════════════════════════════════════════════

  const escape = runWithoutAnyContext(() =>
    resolveStorageTarget({
      buffer: Buffer.from('x'),
      fileName: `../../${TENANT_PREFIX}/${ORG_B}/homework/stolen.pdf`,
      contentType: 'application/pdf',
      module: 'homework',
    }),
  );
  check(
    'a traversing filename stays in the no-org namespace',
    escape.storagePath.startsWith(`${LEGACY_PREFIX}/`) &&
      !escape.storagePath.includes('..'),
    escape.storagePath,
  );
  check(
    'and cannot land in an organization',
    !pathBelongsToOrg(escape.storagePath, ORG_B),
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nevery upload route keeps its tenant context through multer');
  // ══════════════════════════════════════════════════════════════════════════

  // The other half of the bug: a request that DOES have an organization must
  // reach storage with it. Wrapping the instance rather than each call site is
  // what makes this true for routes nobody remembered to edit.
  const uploadSrc = readFileSync(
    join(process.cwd(), 'src', 'middlewares', 'upload.ts'),
    'utf8',
  );
  const aiUploadSrc = readFileSync(
    join(process.cwd(), 'src', 'middlewares', 'uploadAiContent.ts'),
    'utf8',
  );
  check(
    'the shared upload instance is wrapped',
    uploadSrc.includes('preservingTenantContextOn('),
  );
  check(
    'the AI upload instance is wrapped',
    aiUploadSrc.includes('preservingTenantContextOn('),
  );

  // No route may build its own unwrapped multer.
  const routeDir = join(process.cwd(), 'src', 'routes', 'api');
  const unwrapped: string[] = [];
  for (const file of readdirSync(routeDir).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(join(routeDir, file), 'utf8');
    if (!/=\s*multer\(/.test(text)) continue;
    // A local instance is fine as long as its mounts are wrapped.
    const mounts = text.match(/\w+\.(single|array|fields|any)\(/g) || [];
    const wrapped = (text.match(/preservingTenantContext\(/g) || []).length;
    if (mounts.length > wrapped)
      unwrapped.push(`${file} (${mounts.length} mounts, ${wrapped} wrapped)`);
  }
  eq('no route mounts an unwrapped local multer', unwrapped, []);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nend to end, over a real socket — the homework upload');
  // ══════════════════════════════════════════════════════════════════════════

  const app = express();
  app.use(tenantContextMiddleware);
  // The homework route's own middleware chain, using the REAL shared instance.
  app.post(
    '/api/homework/:id/upload',
    upload.single('file'),
    (req: Request, res: Response) => {
      if (!req.file) return res.status(400).json({ error: 'No file provided' });
      try {
        const target = resolveStorageTarget({
          buffer: req.file.buffer,
          fileName: req.file.originalname,
          contentType: req.file.mimetype,
          module: 'homework',
          entityId: String(req.params.id),
        });
        return res.json({
          orgIdAtHandler: currentOrgId(),
          kind: target.kind,
          storagePath: target.storagePath,
          fileName: req.file.originalname,
          fileSize: req.file.size,
        });
      } catch (err) {
        return res.status(500).json({
          error: (err as Error).message,
          code: (err as any)?.code,
        });
      }
    },
  );

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const postPdf = (token: string | null) => {
    const boundary = `----hw${Math.random().toString(16).slice(2)}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="worksheet.pdf"\r\n` +
          `Content-Type: application/pdf\r\n\r\n`,
      ),
      Buffer.from('%PDF-1.4 test'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const headers: Record<string, string | number> = {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': body.length,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const rq = http.request(
        {
          port,
          path: '/api/homework/6aa7e5efacaa3b5f2541b564/upload',
          method: 'POST',
          headers,
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            let parsed: any = raw;
            try {
              parsed = JSON.parse(raw);
            } catch {
              /* informative as-is */
            }
            resolve({ status: res.statusCode || 0, body: parsed });
          });
        },
      );
      rq.on('error', reject);
      rq.end(body);
    });
  };

  try {
    // THE reported failure: a legacy request with no organization at all.
    const legacyReq = await postPdf(null);
    eq('the legacy homework upload succeeds', legacyReq.status, 200);
    check(
      'it is NOT STORAGE_ACCESS_DENIED',
      legacyReq.body?.code !== 'STORAGE_ACCESS_DENIED',
      JSON.stringify(legacyReq.body),
    );
    eq(
      'and lands in the no-organization namespace',
      legacyReq.body?.kind,
      'legacy',
    );
    check(
      'under a path naming the homework it belongs to',
      String(legacyReq.body?.storagePath || '').startsWith(
        `${LEGACY_PREFIX}/homework/6aa7e5efacaa3b5f2541b564/`,
      ),
      legacyReq.body?.storagePath,
    );
    eq(
      'the file itself still arrives',
      legacyReq.body?.fileName,
      'worksheet.pdf',
    );
    eq('with its bytes', legacyReq.body?.fileSize, 13);

    // And the other half: an org-carrying request must still be tenant-scoped
    // AFTER multer, which is exactly what used to be destroyed.
    const token = jwt.sign(
      { id: 'admin-under-test', role: 'admin', orgId: ORG_A },
      process.env.JWT_SECRET as string,
    );
    const orgReq = await postPdf(token);
    eq('an org-carrying homework upload succeeds', orgReq.status, 200);
    eq(
      'the context survived the multipart parse',
      orgReq.body?.orgIdAtHandler,
      ORG_A,
    );
    eq('and it is tenant-scoped, NOT legacy', orgReq.body?.kind, 'tenant');
    check(
      'under the organization namespace',
      String(orgReq.body?.storagePath || '').startsWith(
        `${TENANT_PREFIX}/${ORG_A}/homework/6aa7e5efacaa3b5f2541b564/`,
      ),
      orgReq.body?.storagePath,
    );
    check(
      'an org request never silently falls back to the no-org namespace',
      !String(orgReq.body?.storagePath || '').startsWith(`${LEGACY_PREFIX}/`),
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }

  console.log(
    `\n${failures ? '✗ FAILED' : '✓ PASSED'} — ${checks - failures}/${checks} checks\n`,
  );
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error('\nharness error:', err);
  process.exit(1);
});
