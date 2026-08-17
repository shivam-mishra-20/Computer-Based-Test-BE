/**
 * P0 — snapshot the API surface so a contract change cannot happen silently.
 *
 * Parses `src/app.ts` for mount prefixes and every `src/routes/api/*.ts` for
 * route declarations, and emits a sorted inventory of
 * `METHOD /full/path  [middleware chain]`.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * The legacy Abhigyan app consumes these endpoints and cannot be updated in
 * lockstep — installs in the field update slowly, and some never will. Diffing
 * this snapshot before and after a change answers "did we just break a client
 * we cannot fix" in one command.
 *
 * It also captures the AUTHORIZATION chain per route, so the diff catches a
 * second class of regression: a `requireRole` that quietly disappears during a
 * refactor is a security change that no test of happy-path behaviour would
 * notice.
 *
 * Static analysis, so it is exact about what the source declares and says
 * nothing about runtime behaviour. That is the right trade here — it needs no
 * running server and no database, so it can gate a pull request.
 *
 *   npx ts-node scripts/safety/api-contract-snapshot.ts
 *   npx ts-node scripts/safety/api-contract-snapshot.ts --out docs/baselines/api-2026-08-17.txt
 *   npx ts-node scripts/safety/api-contract-snapshot.ts --check docs/baselines/api-2026-08-17.txt
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

const ROUTES_DIR = join(process.cwd(), 'src', 'routes', 'api');
const APP_FILE = join(process.cwd(), 'src', 'app.ts');

interface Endpoint {
  method: string;
  path: string;
  guards: string[];
  source: string;
}

/**
 * Map router module -> mount prefix, from the `app.use('/api/x', xRoutes)` calls.
 * Several routers legitimately share a prefix (auth + passwordReset both mount
 * at /api/auth), so this is a multimap.
 */
function readMounts(): Map<string, string[]> {
  const source = readFileSync(APP_FILE, 'utf8');
  const importToFile = new Map<string, string>();

  for (const match of source.matchAll(
    /import\s+(\w+)\s+from\s+['"]\.\/routes\/api\/(\w+)['"]/g,
  )) {
    importToFile.set(match[1], match[2]);
  }
  // uploadRoutes is require()'d rather than imported — same shape, different syntax.
  for (const match of source.matchAll(
    /const\s+(\w+)\s*=\s*require\(['"]\.\/routes\/api\/(\w+)['"]\)/g,
  )) {
    importToFile.set(match[1], match[2]);
  }

  const mounts = new Map<string, string[]>();
  for (const match of source.matchAll(/app\.use\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\s*\)/g)) {
    const [, prefix, identifier] = match;
    const file = importToFile.get(identifier);
    if (!file) continue;
    const list = mounts.get(file) ?? [];
    list.push(prefix);
    mounts.set(file, list);
  }
  return mounts;
}

/** Collapse a middleware argument list into readable guard names. */
function extractGuards(args: string): string[] {
  const guards: string[] = [];
  for (const match of args.matchAll(/requireRole\(([^)]*)\)/g)) {
    const roles = match[1].replace(/['"\s]/g, '').split(',').filter(Boolean);
    guards.push(`requireRole(${roles.join('|')})`);
  }
  for (const name of ['authMiddleware', 'optionalAuthMiddleware', 'requireModule', 'requirePermission']) {
    if (new RegExp(`\\b${name}\\b`).test(args)) guards.push(name);
  }
  for (const match of args.matchAll(/\b(\w*[Ll]imiter)\b/g)) {
    guards.push(match[1]);
  }
  return [...new Set(guards)];
}

/**
 * Resolve `...spreadName` in a middleware list back to its declaration.
 *
 * `teacherRoutes.ts` declares `const aiGuards = [authMiddleware,
 * requireRole('teacher','admin'), aiLimiter]` and then spreads it into the AI
 * routes. Reading the route line alone reports `POST /api/teacher/ai/generate`
 * as PUBLIC — an unauthenticated, unmetered AI endpoint, which would be a
 * serious cost-abuse finding if it were true. It is not: the spread is fully
 * guarded. Resolving one level of indirection is the difference between a
 * baseline that can be trusted and one that cries wolf.
 *
 * One level only, and same-file only. Deeper indirection would need a real
 * parser, and if it ever appears the endpoint shows up as PUBLIC — which fails
 * loudly toward investigation rather than quietly toward false assurance.
 */
function expandSpreads(args: string, source: string): string {
  let expanded = args;
  for (const match of args.matchAll(/\.\.\.(\w+)/g)) {
    const name = match[1];
    const declaration = source.match(
      new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`),
    );
    if (declaration) expanded += ',' + declaration[1];
  }
  return expanded;
}

/**
 * Guards applied to EVERY route in a file via `router.use(...)`.
 *
 * Five route files authorize this way — adminRoutes, attendanceRuleRoutes,
 * examReviewRoutes, playlistRoutes and publicTestAdminRoutes all call
 * `router.use(authMiddleware, requireRole('admin'))` near the top. Reading only
 * the per-route arguments reports those endpoints as PUBLIC, which is both
 * alarming and wrong: it would have listed `POST /api/admin/settings` as
 * unauthenticated. A baseline that misreports authorization is worse than no
 * baseline, because the first real regression gets dismissed as another false
 * alarm.
 *
 * Only `router.use()` calls with no path argument are file-wide; a call like
 * `router.use('/sub', x)` is scoped and is deliberately ignored here.
 */
function extractRouterLevelGuards(source: string): string[] {
  const guards: string[] = [];
  for (const match of source.matchAll(/router\s*\.\s*use\s*\(\s*([^)]*(?:\([^)]*\))?[^)]*)\)\s*;/g)) {
    const args = match[1];
    if (/^\s*['"`]/.test(args)) continue; // path-scoped, not file-wide
    guards.push(...extractGuards(args));
  }
  return [...new Set(guards)];
}

function collect(): Endpoint[] {
  const mounts = readMounts();
  const endpoints: Endpoint[] = [];

  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts')).sort()) {
    const moduleName = file.replace(/\.ts$/, '');
    const prefixes = mounts.get(moduleName) ?? ['(unmounted)'];
    const source = readFileSync(join(ROUTES_DIR, file), 'utf8');
    const fileGuards = extractRouterLevelGuards(source);

    for (const match of source.matchAll(
      /router\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*(['"`])([^'"`]*)\2\s*([\s\S]*?)\)\s*;/g,
    )) {
      const [, method, , routePath, rest] = match;
      const guards = [...new Set([...fileGuards, ...extractGuards(expandSpreads(rest, source))])];
      for (const prefix of prefixes) {
        const full = `${prefix}${routePath}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
        endpoints.push({ method: method.toUpperCase(), path: full, guards, source: moduleName });
      }
    }
  }

  return endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function render(endpoints: Endpoint[]): string {
  const lines = endpoints.map((e) => {
    const guards = e.guards.length ? `  [${e.guards.join(' ')}]` : '  [PUBLIC]';
    return `${e.method.padEnd(6)} ${e.path.padEnd(58)}${guards}`;
  });
  return (
    `# API contract snapshot\n` +
    `# endpoints: ${endpoints.length}\n` +
    `# Generated by scripts/safety/api-contract-snapshot.ts — do not hand-edit.\n` +
    `# A diff here is a contract change. The legacy Abhigyan app cannot be\n` +
    `# updated in lockstep, so treat every removal or guard change as breaking\n` +
    `# until proven otherwise.\n\n` +
    lines.join('\n') +
    '\n'
  );
}

function main() {
  const endpoints = collect();
  const output = render(endpoints);

  const outIndex = process.argv.indexOf('--out');
  const checkIndex = process.argv.indexOf('--check');

  if (checkIndex > -1) {
    const expectedPath = process.argv[checkIndex + 1];
    const expected = readFileSync(expectedPath, 'utf8');
    if (expected.trim() === output.trim()) {
      console.log(`[api-contract] unchanged — ${endpoints.length} endpoints match ${expectedPath}`);
      return;
    }
    const expectedLines = new Set(expected.split('\n').filter((l) => l && !l.startsWith('#')));
    const actualLines = new Set(output.split('\n').filter((l) => l && !l.startsWith('#')));
    const removed = [...expectedLines].filter((l) => !actualLines.has(l));
    const added = [...actualLines].filter((l) => !expectedLines.has(l));

    console.error(`[api-contract] CHANGED vs ${expectedPath}`);
    removed.forEach((l) => console.error(`  - ${l}`));
    added.forEach((l) => console.error(`  + ${l}`));
    console.error(
      `\nRemoved or altered lines may break the legacy app. If intentional, re-snapshot with --out.`,
    );
    process.exit(1);
  }

  if (outIndex > -1) {
    const outPath = process.argv[outIndex + 1];
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, output, 'utf8');
    console.log(`[api-contract] ${endpoints.length} endpoints written to ${outPath}`);
    return;
  }

  process.stdout.write(output);
}

main();
