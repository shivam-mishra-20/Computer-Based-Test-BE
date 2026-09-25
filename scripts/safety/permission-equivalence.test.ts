/**
 * Converting role guards to permission guards changed NOTHING for legacy users.
 *
 * ── What this proves ────────────────────────────────────────────────────────
 * Every route that carried a `requireRole(...)` guard before the conversion is
 * listed in `docs/baselines/route-guards-legacy-2026-09-24.json` (snapshotted
 * from git HEAD, before the change) with the roles it admitted. For each one,
 * this reads the route's CURRENT guards from source, evaluates them against the
 * legacy role → permission bridge, and asserts the same legacy roles are
 * admitted — no more, no fewer.
 *
 * That is the half of the change a live institute feels: Abhigyan's 158 users
 * carry no role documents, so they are authorized through the bridge, and for
 * them the permission guards must be indistinguishable from the role guards.
 * The other half — that a custom role now RESTRICTS — is proved against a real
 * database by `tenant-admin-isolation.e2e.test.ts`.
 *
 * A route whose guard can no longer be found also fails: silently dropping a
 * guard is the worst possible outcome of a conversion like this one.
 *
 *   npx ts-node --transpile-only scripts/safety/permission-equivalence.test.ts
 */

import fs from 'fs';
import path from 'path';
import { LEGACY_ROLE_PERMISSIONS } from '../../src/core/rbac/permissions';

interface BaselineRoute {
  file: string;
  method: string;
  path: string;
  roles: string[];
}

type Guard =
  | { kind: 'role'; roles: string[] }
  | { kind: 'all' | 'any'; staff: boolean; perms: string[] };

const ROUTES_DIR = path.resolve(__dirname, '../../src/routes/api');
const BASELINE = path.resolve(__dirname, '../../docs/baselines/route-guards-legacy-2026-09-24.json');
const LEGACY_ROLES = ['admin', 'teacher', 'student'];

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) return;
  failures++;
  console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
}

const quoted = (s: string) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);

/** Guard calls appearing literally in a snippet of source. */
function guardsIn(snippet: string): Guard[] {
  const found: Guard[] = [];
  const rx = /\b(requireRole|requireStaffPermission|requireStaffAnyPermission|requirePermission|requireAnyPermission)\(([^)]*)\)/g;
  for (const m of snippet.matchAll(rx)) {
    const args = quoted(m[2]);
    switch (m[1]) {
      case 'requireRole':
        found.push({ kind: 'role', roles: args });
        break;
      case 'requireStaffPermission':
        found.push({ kind: 'all', staff: true, perms: args });
        break;
      case 'requireStaffAnyPermission':
        found.push({ kind: 'any', staff: true, perms: args });
        break;
      case 'requirePermission':
        found.push({ kind: 'all', staff: false, perms: args });
        break;
      case 'requireAnyPermission':
        found.push({ kind: 'any', staff: false, perms: args });
        break;
    }
  }
  return found;
}

/** `const name = <guards>` declarations, so `...guards` and `grade` resolve. */
function declarationsIn(src: string): Map<string, Guard[]> {
  const out = new Map<string, Guard[]>();
  for (const m of src.matchAll(/const (\w+)\s*=\s*(\[[^\]]*\]|require\w+\([^)]*\))/g)) {
    const guards = guardsIn(m[2]);
    if (guards.length) out.set(m[1], guards);
  }
  return out;
}

function routeGuards(src: string, method: string, routePath: string): Guard[] | null {
  const escaped = routePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(`router\\.${method.toLowerCase()}\\(\\s*['\`]${escaped}['\`]`);
  const m = rx.exec(src);
  if (!m) return null;
  const rest = src.slice(m.index);
  const next = rest.slice(1).search(/router\.(get|post|put|patch|delete|use)\(/);
  const segment = next === -1 ? rest : rest.slice(0, next + 1);
  // Only the argument list before the handler body matters.
  const head = segment.slice(0, Math.max(segment.indexOf('=>'), 0) || segment.length);
  const guards = guardsIn(head);
  const declared = declarationsIn(src);
  for (const [name, list] of declared) {
    if (new RegExp(`(\\.\\.\\.|[,(]\\s*)${name}\\b`).test(head)) guards.push(...list);
  }
  // Router-level guards apply to every route declared after them.
  const before = src.slice(0, m.index);
  for (const use of before.matchAll(/router\.use\(([^;]*)\)\s*;/g)) guards.push(...guardsIn(use[1]));
  return guards;
}

function admits(role: string, guards: Guard[]): boolean {
  const perms = new Set<string>(LEGACY_ROLE_PERMISSIONS[role] ?? []);
  return guards.every((g) => {
    if (g.kind === 'role') return g.roles.includes(role);
    if (g.staff && role !== 'admin' && role !== 'teacher') return false;
    return g.kind === 'all' ? g.perms.every((p) => perms.has(p)) : g.perms.some((p) => perms.has(p));
  });
}

function main() {
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf-8')) as { routes: BaselineRoute[] };
  console.log(`\nPERMISSION EQUIVALENCE — ${baseline.routes.length} guarded routes from the pre-conversion baseline\n`);
  const sources = new Map<string, string>();
  let compared = 0;
  const converted: string[] = [];

  for (const route of baseline.routes) {
    if (route.roles.includes('parent')) continue; // parent routes are role-shaped by design
    const file = path.join(ROUTES_DIR, route.file);
    if (!sources.has(file)) sources.set(file, fs.readFileSync(file, 'utf-8'));
    const guards = routeGuards(sources.get(file)!, route.method, route.path);
    const label = `${route.method} ${route.file.replace('.ts', '')} ${route.path}`;
    if (!guards) {
      check(label, false, 'route no longer found');
      continue;
    }
    check(`${label} still carries a guard`, guards.length > 0, 'the guard was dropped');
    const was = LEGACY_ROLES.filter((r) => route.roles.includes(r));
    const now = LEGACY_ROLES.filter((r) => admits(r, guards));
    check(label, JSON.stringify(was) === JSON.stringify(now), `legacy roles admitted: before [${was}] now [${now}]`);
    if (guards.some((g) => g.kind !== 'role')) converted.push(label);
    compared++;
  }

  console.log(`  compared ${compared} routes; ${converted.length} now authorize by permission`);
  const stillRoleOnly = compared - converted.length;
  console.log(`  ${stillRoleOnly} remain role-shaped (a student's own attempts and practice)`);
  console.log(`\n  ${checks - failures}/${checks} checks passed.\n`);
  process.exit(failures ? 1 : 0);
}

main();
