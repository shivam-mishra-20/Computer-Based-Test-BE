/**
 * P1 step 2 — which endpoints do the CLIENTS actually depend on?
 *
 * The API exposes 463 endpoints. The question that governs migration risk is
 * narrower: which of them does a client we cannot update consume? An endpoint
 * the legacy mobile app calls is load-bearing — v1.0.3 is installed on real
 * phones, users update slowly, and some never will. An endpoint nothing calls
 * can be changed freely.
 *
 * This turns "463 endpoints, all equally scary" into a ranked blast radius.
 *
 * ── Method ──────────────────────────────────────────────────────────────────
 * Every client funnels HTTP through one helper — `apiFetch` in the mobile app,
 * `apiFetch` in the web app — so the call sites are greppable and the path is
 * almost always a literal or a template literal. Template interpolations
 * (`${courseId}`) are normalised to `:param`, matching how the route file
 * declares them.
 *
 * ── What this cannot see ────────────────────────────────────────────────────
 * Static analysis. A path assembled at runtime from a variable, or built by
 * string concatenation across several statements, is invisible here. Those are
 * reported separately as `DYNAMIC` so the gap is explicit rather than silently
 * counted as "not used" — the failure direction that would matter is believing
 * an endpoint is unused when a client actually calls it.
 *
 *   npx ts-node scripts/safety/legacy-client-surface.ts
 *   npx ts-node scripts/safety/legacy-client-surface.ts --out docs/baselines/legacy-surface.txt
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join, relative } from 'path';

interface ClientRepo {
  key: string;
  label: string;
  root: string;
  dirs: string[];
  /** Names of the fetch helpers this client routes requests through. */
  helpers: string[];
  /**
   * What to prepend to a helper's path argument to get the server route.
   *
   * The three clients do NOT agree on this, and assuming they did is how the
   * first version of this tool reported the web app as consuming 2 endpoints
   * when it consumes ~150:
   *
   *   mobile   API_BASE = "http://host:5000"      → call sites write "/api/auth/login"  → prefix ''
   *   web      API_BASE = "http://host:5000/api"  → call sites write "/auth/login"      → prefix '/api'
   *   marketing same as web                       → prefix '/api'
   *
   * Matching on the helper call and applying the client's own prefix is exact,
   * where grepping for "/api/" silently drops two clients entirely.
   */
  prefix: string;
  /** True when this client cannot be force-updated once released. */
  unupdatable: boolean;
}

const CLIENTS: ClientRepo[] = [
  {
    key: 'legacy-app',
    label: 'abhigyan-gurukul-app (LEGACY MOBILE — cannot be force-updated)',
    root: join(process.cwd(), '..', 'abhigyan-gurukul-app'),
    dirs: ['lib', 'app', 'components', 'hooks', 'pages'],
    helpers: ['apiFetch', 'authFetch', 'request'],
    prefix: '',
    unupdatable: true,
  },
  {
    key: 'web',
    label: 'cbt-exam (web — deployable, updates atomically)',
    root: join(process.cwd(), '..', 'cbt-exam'),
    dirs: ['src'],
    helpers: ['apiFetch'],
    prefix: '/api',
    unupdatable: false,
  },
  {
    key: 'marketing',
    label: 'abhigyan-gurukul-main (marketing + legacy Firestore admin)',
    root: join(process.cwd(), '..', 'abhigyan-gurukul-main'),
    dirs: ['src'],
    helpers: ['apiFetch', 'apiRequest'],
    prefix: '/api',
    unupdatable: false,
  },
];

const CODE_EXT = /\.(ts|tsx|js|jsx)$/;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist' || entry === '.expo') {
      continue;
    }
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, out);
    else if (CODE_EXT.test(entry)) out.push(full);
  }
  return out;
}

/**
 * `/api/courses/${courseId}/enroll` → `/api/courses/:param/enroll`
 *
 * The route file declares `/:courseId`, so both sides have to be reduced to a
 * common shape before they can be compared. Query strings are dropped for the
 * same reason: `?light=1` is not part of the route's identity.
 */
function normalise(path: string): string {
  return (
    path
      // An interpolation directly after `/` is a route parameter:
      //   `/api/courses/${courseId}` → `/api/courses/:param`
      .replace(/\/\$\{[^}]*\}/g, '/:param')
      // An interpolation appended to a word is a query-string builder, not a
      // path segment: `/api/doubts/teacher${qs}` is the route
      // `/api/doubts/teacher` with `?…` attached. Treating it as a parameter
      // invents a route that does not exist and reports the real one as
      // unconsumed — wrong in the dangerous direction.
      .replace(/\$\{[^}]*\}.*$/g, '')
      .replace(/\?.*$/, '')
      .replace(/\/+$/, '')
      .replace(/\/{2,}/g, '/')
  );
}

/** Route declarations reduced to the same shape: `/api/courses/:id` → `/api/courses/:param`. */
function normaliseRoute(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, ':param').replace(/\/+$/, '');
}

interface Call {
  method: string;
  path: string;
  file: string;
  line: number;
}

/**
 * Find the HTTP method for a call by reading the options object that follows
 * the path argument. `apiFetch("/x")` with no options is a GET — that is the
 * fetch default every one of these helpers inherits.
 */
function methodFor(tail: string): string {
  const match = tail.match(/method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/i);
  return match ? match[1].toUpperCase() : 'GET';
}

function extract(repo: ClientRepo): { calls: Call[]; dynamic: string[] } {
  const calls: Call[] = [];
  const dynamic: string[] = [];

  const files = repo.dirs.flatMap((d) => walk(join(repo.root, d)));

  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Cheap pre-filter. It MUST test for the helper names as well as the
    // literal "/api/": the web and marketing clients never write "/api/" in a
    // call site (their API_BASE already ends in it), so filtering on that
    // string alone skipped almost every file in two of the three clients and
    // under-reported the web surface as 35 endpoints instead of 133.
    if (!source.includes('/api/') && !repo.helpers.some((h) => source.includes(h))) continue;

    const rel = relative(repo.root, file).replace(/\\/g, '/');

    // 1. Calls through a known fetch helper. This is the accurate path: the
    //    client's own prefix is applied, so both path conventions are handled.
    for (const helper of repo.helpers) {
      const pattern = new RegExp(
        `\\b${helper}\\s*\\(\\s*(['"\`])([^'"\`\\n]*)\\1([\\s\\S]{0,220})`,
        'g',
      );
      for (const match of source.matchAll(pattern)) {
        const raw = match[2];
        if (!raw.startsWith('/')) continue; // absolute URLs and non-paths
        const path = normalise(repo.prefix + raw);
        if (!path.startsWith('/api/')) continue;
        const line = source.slice(0, match.index ?? 0).split('\n').length;
        calls.push({ method: methodFor(match[3]), path, file: rel, line });
      }
    }

    // 2. Raw literals that already spell out /api/ — catches direct fetch()
    //    calls that bypass the helper. Union with (1); duplicates collapse.
    for (const match of source.matchAll(/(['"`])(\/api\/[^'"`\n]*)\1([\s\S]{0,220})/g)) {
      const path = normalise(match[2]);
      if (!path.startsWith('/api/')) continue;
      const line = source.slice(0, match.index ?? 0).split('\n').length;
      calls.push({ method: methodFor(match[3]), path, file: rel, line });
    }

    // Paths assembled from a variable — visible as a template that STARTS with
    // an interpolation, or concatenation onto an /api prefix held elsewhere.
    for (const match of source.matchAll(/`\$\{[^}]*\}\/[a-z][^`\n]*`/gi)) {
      const line = source.slice(0, match.index ?? 0).split('\n').length;
      dynamic.push(`${rel}:${line}  ${match[0].slice(0, 80)}`);
    }
  }

  return { calls, dynamic };
}

function loadContract(): Map<string, Set<string>> {
  const baselineDir = join(process.cwd(), 'docs', 'baselines');
  const file = readdirSync(baselineDir)
    .filter((f) => f.startsWith('api-contract-') && f.endsWith('.txt'))
    .sort()
    .pop();
  if (!file) throw new Error('No API contract baseline found. Run: npm run safety:api-snapshot');

  const contract = new Map<string, Set<string>>();
  for (const line of readFileSync(join(baselineDir, file), 'utf8').split('\n')) {
    const match = line.match(/^(GET|POST|PUT|PATCH|DELETE|ALL)\s+(\S+)/);
    if (!match) continue;
    const path = normaliseRoute(match[2]);
    if (!contract.has(path)) contract.set(path, new Set());
    contract.get(path)!.add(match[1]);
  }
  return contract;
}

function main() {
  const contract = loadContract();
  const consumed = new Map<string, Set<string>>(); // normalised path -> client keys
  const sections: string[] = [];
  let grandTotal = 0;

  for (const repo of CLIENTS) {
    if (!existsSync(repo.root)) {
      sections.push(`## ${repo.label}\n\n  (repository not found at ${repo.root} — skipped)\n`);
      continue;
    }

    const { calls, dynamic } = extract(repo);
    const unique = new Map<string, Call>();
    for (const call of calls) {
      const key = `${call.method} ${call.path}`;
      if (!unique.has(key)) unique.set(key, call);
      if (!consumed.has(call.path)) consumed.set(call.path, new Set());
      consumed.get(call.path)!.add(repo.key);
    }

    grandTotal += unique.size;
    const rows = [...unique.entries()].sort(([a], [b]) => a.localeCompare(b));

    const lines = rows.map(([key, call]) => {
      const known = contract.has(call.path);
      const flag = known ? ' ' : '?';
      return `  ${flag} ${key.padEnd(62)} ${call.file}:${call.line}`;
    });

    const unmatched = rows.filter(([, c]) => !contract.has(c.path)).length;

    sections.push(
      `## ${repo.label}\n` +
        `   ${unique.size} distinct calls` +
        (unmatched ? `  ·  ${unmatched} not matched to a declared route (marked ?)` : '') +
        (repo.unupdatable ? `\n   ⚠  LOAD-BEARING — every path below must keep working` : '') +
        `\n\n` +
        lines.join('\n') +
        (dynamic.length
          ? `\n\n   DYNAMIC paths this tool cannot resolve (${dynamic.length}) — review by hand:\n` +
            dynamic.slice(0, 12).map((d) => `     ${d}`).join('\n')
          : '') +
        '\n',
    );
  }

  // Blast radius: declared routes nothing appears to call.
  const orphans = [...contract.keys()].filter((p) => !consumed.has(p)).sort();
  const legacyPaths = [...consumed.entries()]
    .filter(([, clients]) => clients.has('legacy-app'))
    .map(([p]) => p);

  const header =
    `# Legacy client API surface\n` +
    `# Generated by scripts/safety/legacy-client-surface.ts — do not hand-edit.\n` +
    `#\n` +
    `# Declared routes (contract):        ${contract.size}\n` +
    `# Consumed by the LEGACY MOBILE app: ${legacyPaths.length}   <- cannot be force-updated\n` +
    `# Consumed by any client:            ${consumed.size}\n` +
    `# Apparently unconsumed:             ${orphans.length}\n` +
    `#\n` +
    `# A change to a path in the legacy section risks breaking installs already\n` +
    `# in the field. A change to an unconsumed path is low risk — but "apparently\n` +
    `# unconsumed" is a static result, not proof: check the DYNAMIC lists first.\n\n`;

  const orphanSection =
    `## Apparently unconsumed by any client (${orphans.length})\n` +
    `   Lower migration risk. Verify against the DYNAMIC lists above before relying on this.\n\n` +
    orphans.map((p) => `    ${p}`).join('\n') +
    '\n';

  const output = header + sections.join('\n') + '\n' + orphanSection;

  const outIndex = process.argv.indexOf('--out');
  if (outIndex > -1) {
    const outPath = process.argv[outIndex + 1];
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, output, 'utf8');
    console.log(`[legacy-surface] written: ${outPath}`);
    console.log(`  declared routes                ${contract.size}`);
    console.log(`  consumed by LEGACY MOBILE app  ${legacyPaths.length}   <- load-bearing`);
    console.log(`  consumed by any client         ${consumed.size}`);
    console.log(`  apparently unconsumed          ${orphans.length}`);
    console.log(`  total distinct call sites      ${grandTotal}`);
    return;
  }

  process.stdout.write(output);
}

main();
