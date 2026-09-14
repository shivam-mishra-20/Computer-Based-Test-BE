/**
 * Tenant context across the schedule image-upload boundary.
 *
 * ── The regression this locks down ──────────────────────────────────────────
 * `POST /api/schedule/extract-image` failed with
 *
 *     StorageAccessDenied: Cannot store a tenant file without an organization
 *     context.
 *
 * not because the caller lacked an organization, but because the context was
 * DESTROYED between the middleware that opened it and the handler that used it.
 * `multer` consumes the request stream and resumes the chain from the socket's
 * async context — a resource created when the connection was accepted, long
 * before any per-request `AsyncLocalStorage.run()` — so every handler behind a
 * multipart parse ran with no store at all.
 *
 * That is invisible under `TENANT_ENFORCEMENT=warn`, where reads are not
 * filtered and a missing context is merely recorded. Object storage is the one
 * consumer that is unconditionally fail-closed, so it was the first thing to
 * break — and it broke with a 500.
 *
 * ── Where the organization is, and is not, required ─────────────────────────
 * Keeping the photo needs one; reading it does not. So the route treats the
 * organization as OPTIONAL: without one it extracts anyway and warns that the
 * original was not kept. The line these checks hold is that "optional" never
 * becomes an unattributed write — no organization means no upload at all, not
 * an upload onto some shared path, because a file under no owner can never be
 * authorized afterwards. `putTenantFile` still refuses one outright.
 *
 * ── What this proves, and what it deliberately does not ─────────────────────
 * Everything here runs against the REAL modules over a REAL HTTP server: the
 * real `tenantContextMiddleware`, real signed tokens, a real `multer` instance
 * configured exactly as the route's, the real `preservingTenantContext`
 * wrapper, the real `putTenantFile` refusal and the real path builder.
 *
 * What is NOT exercised is the Firebase `file.save()` itself. That is the same
 * boundary `storage-tenancy.test.ts` documents, and here it is a hard rule
 * rather than a limitation: this machine's `.env` carries live Firebase
 * credentials, so calling `putTenantFile` with a valid organization would write
 * a real object into the real bucket. The tenancy DECISION — which organization
 * a write is attributed to, and what path it lands on — is resolved before
 * Firebase is contacted, and that decision is what is checked here.
 *
 *   npx ts-node --transpile-only scripts/safety/schedule-upload-tenancy.test.ts
 */

// Every `any` below sits on a boundary that genuinely has no static shape: a
// parsed HTTP response body, multer's `fileFilter` callback (copied verbatim
// from the route so the filter under test is the same one), and Express's
// error-handler signature. Narrowing them would describe the assertions rather
// than the wire, and the assertions are what this file is for.
/* eslint-disable @typescript-eslint/no-explicit-any */

process.env.TENANT_MODE = 'claim';
process.env.TENANT_ENFORCEMENT = 'warn';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'schedule-upload-tenancy-test-secret';

import express, { NextFunction, Request, Response } from 'express';
import http from 'http';
import net from 'net';
import { AddressInfo } from 'net';
import { readFileSync } from 'fs';
import { join } from 'path';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import multer from 'multer';

// No database is available here, and none is needed: the organization is
// resolved from the signed claim. Without this, the one path that does reach
// Mongoose (an `X-Org-Id` that has to be resolved before it can be compared to
// the claim) would sit in the driver's buffer for ten seconds before failing.
mongoose.set('bufferCommands', false);

import { tenantContextMiddleware } from '../../src/middlewares/tenantContext';
import { errorHandler } from '../../src/middlewares/errorHandler';
import {
  currentOrgId,
  runWithoutAnyContext,
} from '../../src/core/tenancy/context';
import { preservingTenantContext } from '../../src/core/tenancy/requestContext';
import {
  putTenantFile,
  StorageAccessDenied,
} from '../../src/core/storage/storageService';
import {
  pathBelongsToOrg,
  parseTenantPath,
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

// ── A second context-destroying boundary, standing in for the rate limiter ──
// `uploadLimiter` and `aiLimiter` sit ahead of multer and answer from a Redis
// connection, so they drop the context for exactly the same reason multer does.
// Reproducing that here matters: without it the suite would pass against a fix
// that only handled multer, which is the narrower bug. The socket is opened at
// module load — OUTSIDE any request context — which is what makes its callbacks
// resume with no store, precisely like a long-lived Redis client's.
const echo = net.createServer((socket) => socket.pipe(socket));
let echoClient: net.Socket;

function startEchoBoundary(): Promise<void> {
  return new Promise((resolve) => {
    echo.listen(0, '127.0.0.1', () => {
      echoClient = net.connect(
        (echo.address() as AddressInfo).port,
        '127.0.0.1',
        () => resolve(),
      );
    });
  });
}

function asyncBoundary(_req: Request, _res: Response, next: NextFunction) {
  echoClient.once('data', () => next());
  echoClient.write('.');
}

// ── The request the route actually receives ────────────────────────────────
// A real multipart body over a real socket. Nothing here is simulated: the
// socket is precisely the async resource whose context multer resumes from, so
// a test that posted a JSON body would prove nothing.
function postImage(
  port: number,
  path: string,
  token: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  const boundary = `----scheduleTest${Math.random().toString(16).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="dateHint"\r\n\r\n2026-09-14\r\n`,
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="timetable.png"\r\n` +
        `Content-Type: image/png\r\n\r\n`,
    ),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const headers: Record<string, string | number> = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': body.length,
    ...extraHeaders,
  };
  if (token) headers.authorization = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, method: 'POST', headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let parsed: any = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* a non-JSON body is itself informative */
        }
        resolve({
          status: res.statusCode || 0,
          body: parsed,
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** The same request, carrying a file type the route's filter refuses. */
function postPdf(
  port: number,
  path: string,
  token: string,
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  const boundary = `----scheduleReject${Math.random().toString(16).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="notes.pdf"\r\n` +
        `Content-Type: application/pdf\r\n\r\n`,
    ),
    Buffer.from('%PDF-1.4'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        port,
        path,
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': body.length,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed: any = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* a non-JSON body is itself informative */
          }
          resolve({
            status: res.statusCode || 0,
            body: parsed,
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function tokenFor(orgId: string | null): string {
  const claims: Record<string, unknown> = {
    id: 'admin-under-test',
    role: 'admin',
  };
  if (orgId) claims.orgId = orgId;
  return jwt.sign(claims, process.env.JWT_SECRET as string);
}

/**
 * The route's upload parser, configured as the route configures it.
 *
 * `authMiddleware` is not in this chain because it reads the User document from
 * Mongo, and the limiters are not because they need Redis. Neither participates
 * in resolving the organization — `tenantContextMiddleware` does that, from the
 * signed claim, and it is the real one here. That the route still runs both
 * ahead of the parser is asserted against the route source at the end.
 */
const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    const okTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (okTypes.includes(file.mimetype)) return cb(null, true);
    return cb(new Error('Only image files (PNG/JPEG/WEBP) are allowed'));
  },
});

/**
 * What the real handler does: resolve the organization, store under it IF there
 * is one, and extract either way.
 *
 * The organization is optional here by decision — reading the photo needs none,
 * only keeping it does — so a missing one skips the upload and warns. What it
 * must never do is write anyway: an unattributed file cannot be authorized
 * later, so `storagePath` is empty rather than pointing somewhere shared.
 */
async function scheduleHandler(req: Request, res: Response) {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  const orgId = currentOrgId();

  // An await before the write, as the real route has one
  // (`normalizeImageForVision`). The context must be the same on the far side.
  await new Promise((r) => setTimeout(r, 1));

  const ext = (req.file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  let storagePath = '';
  const storageWarnings: string[] = [];
  if (currentOrgId()) {
    // The path `putTenantFile` would produce, from the same builder it uses.
    // The upload itself is not performed — see the header.
    storagePath = tenantFilePath({
      orgId: currentOrgId() as string,
      module: 'schedule',
      fileId: 'fixedFileIdForTest',
      fileName: `schedule-import.${ext}`,
    });
  } else {
    storageWarnings.push(
      'The original photo was not saved because your session carries no organization, ' +
        'so the side-by-side comparison is unavailable. The extracted classes below are unaffected.',
    );
  }

  return res.json({
    orgIdAtHandler: orgId,
    orgIdAfterAwait: currentOrgId(),
    dateHint: req.body?.dateHint ?? null,
    fileName: req.file.originalname,
    fileSize: req.file.size,
    storagePath,
    warnings: storageWarnings,
  });
}

function buildApp() {
  const app = express();
  app.use(tenantContextMiddleware);

  // The FIXED composition — what the route now does.
  app.post(
    '/api/schedule/extract-image',
    asyncBoundary,
    preservingTenantContext(parser.single('image')),
    scheduleHandler,
  );

  // The BROKEN composition, kept so this suite proves it is testing something
  // real. If this route ever starts reporting an organization, the defect has
  // been fixed elsewhere and these checks have stopped being a regression guard.
  app.post(
    '/api/schedule/extract-image-unwrapped',
    asyncBoundary,
    parser.single('image'),
    scheduleHandler,
  );

  // The rejection path: a non-image is refused by the parser's fileFilter, which
  // answers with `next(err)`. The wrapper must restore the context there too —
  // an error handler that logs or records outside the tenant context attributes
  // the failure to nobody — and it must not swallow the error on the way.
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    res.setHeader('x-org-at-error-handler', String(currentOrgId()));
    return errorHandler(err, req, res, next);
  });

  return app;
}

async function main() {
  await startEchoBoundary();
  const server = http.createServer(buildApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  try {
    // ════════════════════════════════════════════════════════════════════════
    console.log(
      '\nthe defect is real — an unwrapped multipart parse loses the context',
    );
    // ════════════════════════════════════════════════════════════════════════

    const broken = await postImage(
      port,
      '/api/schedule/extract-image-unwrapped',
      tokenFor(ORG_A),
    );
    eq(
      'a valid org claim still reaches the handler with none',
      broken.body?.orgIdAtHandler,
      null,
    );
    check(
      'so the photo would be dropped even though the caller named an organization',
      broken.body?.storagePath === '',
      String(broken.body?.storagePath),
    );

    // ════════════════════════════════════════════════════════════════════════
    console.log(
      '\na valid authenticated tenant request stores with the right organization',
    );
    // ════════════════════════════════════════════════════════════════════════

    const ok = await postImage(
      port,
      '/api/schedule/extract-image',
      tokenFor(ORG_A),
    );
    eq('the upload succeeds', ok.status, 200);
    eq(
      'the handler sees the organization from the signed claim',
      ok.body?.orgIdAtHandler,
      ORG_A,
    );
    eq(
      'and still sees it after the pre-write await',
      ok.body?.orgIdAfterAwait,
      ORG_A,
    );
    check(
      'the storage path is namespaced to that organization',
      typeof ok.body?.storagePath === 'string' &&
        ok.body.storagePath.startsWith(`organizations/${ORG_A}/schedule/`),
      String(ok.body?.storagePath),
    );
    eq(
      'the path names ORG_A as its owner',
      parseTenantPath(ok.body?.storagePath)?.orgId,
      ORG_A,
    );

    // ════════════════════════════════════════════════════════════════════════
    console.log('\nexisting schedule extraction behaviour is intact');
    // ════════════════════════════════════════════════════════════════════════

    eq('the multipart file still arrives', ok.body?.fileName, 'timetable.png');
    eq('with its bytes', ok.body?.fileSize, 8);
    eq('and the non-file fields still parse', ok.body?.dateHint, '2026-09-14');

    // ════════════════════════════════════════════════════════════════════════
    console.log('\ntenant A cannot store or retrieve through tenant B');
    // ════════════════════════════════════════════════════════════════════════

    // Interleaved on purpose: one shared process, two organizations in flight.
    const [a, b] = await Promise.all([
      postImage(port, '/api/schedule/extract-image', tokenFor(ORG_A)),
      postImage(port, '/api/schedule/extract-image', tokenFor(ORG_B)),
    ]);
    eq(
      'concurrent request A is attributed to A',
      a.body?.orgIdAtHandler,
      ORG_A,
    );
    eq(
      'concurrent request B is attributed to B',
      b.body?.orgIdAtHandler,
      ORG_B,
    );
    check(
      'two organizations uploading the same schedule photo get different paths',
      a.body?.storagePath !== b.body?.storagePath,
      `${a.body?.storagePath}\n      ${b.body?.storagePath}`,
    );
    check(
      "A's path is not readable as B",
      !pathBelongsToOrg(a.body?.storagePath, ORG_B),
    );
    check(
      "B's path is not readable as A",
      !pathBelongsToOrg(b.body?.storagePath, ORG_A),
    );
    check(
      'each organization may read its own',
      pathBelongsToOrg(a.body?.storagePath, ORG_A) &&
        pathBelongsToOrg(b.body?.storagePath, ORG_B),
    );

    // A forged `X-Org-Id` alongside a signed claim is refused outright, so such
    // a request never reaches the parser, let alone storage.
    const forged = await postImage(
      port,
      '/api/schedule/extract-image',
      tokenFor(ORG_A),
      {
        'x-org-id': ORG_B,
      },
    );
    eq("A's token naming B in a header is rejected", forged.status, 400);
    eq(
      'and rejected as a tenant mismatch, not served',
      forged.body?.code,
      'TENANT_MISMATCH',
    );

    // ════════════════════════════════════════════════════════════════════════
    console.log(
      '\nmissing organization context degrades, it does not fail — and never 500s',
    );
    // ════════════════════════════════════════════════════════════════════════

    const noClaim = await postImage(
      port,
      '/api/schedule/extract-image',
      tokenFor(null),
    );
    eq('a token with no orgId claim still extracts', noClaim.status, 200);
    eq(
      'the handler simply has no organization',
      noClaim.body?.orgIdAtHandler,
      null,
    );
    check(
      'and nothing is written — no path is produced at all',
      noClaim.body?.storagePath === '',
      String(noClaim.body?.storagePath),
    );
    check(
      'the response says why the original is missing',
      Array.isArray(noClaim.body?.warnings) &&
        noClaim.body.warnings.some((w: string) => /was not saved/i.test(w)),
      JSON.stringify(noClaim.body?.warnings),
    );
    eq(
      'the extraction payload is otherwise intact',
      noClaim.body?.dateHint,
      '2026-09-14',
    );

    const noToken = await postImage(port, '/api/schedule/extract-image', null);
    eq(
      'an upload with no credential at all also extracts',
      noToken.status,
      200,
    );
    check(
      'and stores nothing',
      noToken.body?.storagePath === '',
      String(noToken.body?.storagePath),
    );
    check(
      'never a 5xx from the storage layer',
      noToken.status < 500 && noClaim.status < 500,
    );

    // ════════════════════════════════════════════════════════════════════════
    console.log(
      '\na rejected upload still reaches the error handler, in context',
    );
    // ════════════════════════════════════════════════════════════════════════

    const rejected = await postPdf(
      port,
      '/api/schedule/extract-image',
      tokenFor(ORG_A),
    );
    check(
      'a non-image is still refused by the file filter',
      rejected.status >= 400,
      `status ${rejected.status}`,
    );
    check(
      "and refused with the filter's own message, not swallowed",
      /Only image files/.test(JSON.stringify(rejected.body)),
      JSON.stringify(rejected.body),
    );
    eq(
      'the error handler runs inside the tenant context',
      rejected.headers['x-org-at-error-handler'],
      ORG_A,
    );

    // ════════════════════════════════════════════════════════════════════════
    console.log(
      '\nputTenantFile stays fail-closed — the guard does not replace it',
    );
    // ════════════════════════════════════════════════════════════════════════

    // Runs with NO ambient context, and must refuse BEFORE Firebase is touched.
    // That ordering is what makes this safe to run without a credential.
    let refused: unknown = null;
    await runWithoutAnyContext(async () => {
      try {
        await putTenantFile({
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          fileName: 'schedule-import.png',
          contentType: 'image/png',
          module: 'schedule',
        });
      } catch (err) {
        refused = err;
      }
    });
    check(
      'an unscoped write is refused',
      refused instanceof StorageAccessDenied,
    );
    eq(
      'and refused for the right reason',
      (refused as StorageAccessDenied)?.code,
      'STORAGE_ACCESS_DENIED',
    );

    let refusedExplicitNull: unknown = null;
    try {
      await putTenantFile({
        buffer: Buffer.from([0x89]),
        fileName: 'x.png',
        contentType: 'image/png',
        module: 'schedule',
        orgId: null,
      });
    } catch (err) {
      refusedExplicitNull = err;
    }
    check(
      'an explicit null organization is refused too',
      refusedExplicitNull instanceof StorageAccessDenied,
    );

    // ════════════════════════════════════════════════════════════════════════
    console.log('\nno cross-tenant storage path can be produced');
    // ════════════════════════════════════════════════════════════════════════

    const traversal = tenantFilePath({
      orgId: ORG_A,
      module: 'schedule',
      fileId: 'f1',
      fileName: `../../${ORG_B}/schedule/stolen.png`,
    });
    check(
      'a traversing filename cannot escape the organization prefix',
      traversal.startsWith(`organizations/${ORG_A}/schedule/`) &&
        !traversal.includes('..'),
      traversal,
    );
    eq('and the owner is still A', parseTenantPath(traversal)?.orgId, ORG_A);
    check(
      "a traversing filename cannot land in B's namespace",
      !pathBelongsToOrg(traversal, ORG_B),
    );

    const entityTraversal = tenantFilePath({
      orgId: ORG_A,
      module: 'schedule',
      entityId: `../../${ORG_B}`,
      fileId: 'f1',
      fileName: 'notes.png',
    });
    check(
      'nor can a traversing entity id',
      entityTraversal.startsWith(`organizations/${ORG_A}/schedule/`) &&
        !entityTraversal.includes('..'),
      entityTraversal,
    );

    // ════════════════════════════════════════════════════════════════════════
    console.log('\nthe real route is wired the way these checks assume');
    // ════════════════════════════════════════════════════════════════════════

    // The composition above mirrors the route. This reads the route itself, so
    // the mirror cannot drift from it unnoticed — unwrapping the parser, or
    // moving the guard after the write, fails here.
    const routeSrc = readFileSync(
      join(process.cwd(), 'src', 'routes', 'api', 'scheduleRoutes.ts'),
      'utf8',
    );
    const extractBlock = routeSrc.slice(routeSrc.indexOf("'/extract-image',"));

    check(
      'the upload parser is wrapped in preservingTenantContext',
      /preservingTenantContext\(\s*scheduleImageUpload\.single\('image'\)\s*\)/.test(
        extractBlock,
      ),
    );
    const resolveAt = extractBlock.indexOf('const orgId = currentOrgId();');
    const putAt = extractBlock.indexOf('putTenantFile({');
    check('the handler resolves the organization itself', resolveAt > -1);
    check(
      'and resolves it BEFORE the storage write',
      resolveAt > -1 && putAt > -1 && resolveAt < putAt,
    );
    check(
      'the write is pinned to the organization resolved at the top of the handler',
      /putTenantFile\(\{[\s\S]{0,400}?\borgId,/.test(extractBlock),
    );
    // The organization is optional, but the WRITE is not: `putTenantFile` must
    // sit inside `if (orgId)`, so "optional" can never quietly become an
    // unattributed upload.
    check(
      'the storage write is guarded by a present organization',
      /if\s*\(orgId\)\s*\{[\s\S]{0,200}?putTenantFile\(\{/.test(extractBlock),
    );
    check(
      'and the skipped case warns instead of failing',
      /storageWarnings\.push\(/.test(extractBlock) &&
        /warnings:\s*\[\s*\.\.\.storageWarnings/.test(extractBlock),
    );
    check(
      'no TENANT_CONTEXT_REQUIRED hard-block remains',
      !extractBlock.includes('TENANT_CONTEXT_REQUIRED'),
    );
    check(
      'authentication still runs ahead of the parser',
      extractBlock.indexOf('authMiddleware') <
        extractBlock.indexOf('preservingTenantContext') &&
        extractBlock.indexOf("requireRole('admin')") <
          extractBlock.indexOf('preservingTenantContext'),
    );
    check(
      'and the rate limits are still applied',
      /aiLimiter,/.test(extractBlock) && /uploadLimiter,/.test(extractBlock),
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    echoClient?.destroy();
    echo.close();
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
