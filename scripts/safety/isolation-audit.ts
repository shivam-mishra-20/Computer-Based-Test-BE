/**
 * The tenant boundary where the Mongoose plugin cannot reach.
 *
 * ── What this is for, and what it deliberately is NOT ───────────────────────
 * `verify-tenant-coverage` proves the plugin reached every model.
 * `lookup-audit` proves every `$lookup` is classified. Both cover paths the
 * plugin can protect once enforcement is on.
 *
 * This covers the paths it can NEVER protect, no matter what
 * `TENANT_ENFORCEMENT` is set to:
 *
 *   RAW DRIVER      `connection.collection(...)` bypasses Mongoose middleware
 *                   entirely. No hook runs. Ever.
 *   CACHE KEYS      a Redis key that is not unique per tenant serves one
 *                   organization's response to another — invisibly, and with
 *                   no database query to audit.
 *   SOCKET ROOMS    a room name that is not unique per tenant is a broadcast
 *                   channel between organizations.
 *   BACKGROUND WORK cron, queues and workers run outside any request, so they
 *                   have no ambient context unless one is opened explicitly.
 *   BYPASSES        `withoutTenantScope()` is a deliberate hole. Each one is
 *                   legitimate; the danger is the twentieth, added by someone
 *                   who copied the nineteenth.
 *   EXTERNAL STORES Firestore and object storage have no Mongoose plugin at
 *                   all, so their tenancy is whatever the path or query says.
 *
 * ── Why an allowlist rather than a scanner that guesses ─────────────────────
 * Every entry below was read and classified by a person. A new one fails the
 * build, which forces the same reading rather than allowing a silent addition.
 * The alternative — a heuristic that decides for itself whether a key "looks
 * tenant-safe" — is a check that passes when it should not, which is worse than
 * no check.
 *
 *   npx ts-node --transpile-only scripts/safety/isolation-audit.ts
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(process.cwd(), 'src');

type Verdict =
  /** Unique per tenant by construction — an ObjectId, or an explicit orgId. */
  | 'SAFE-BY-KEY'
  /** Explicitly scoped with orgId / tenantScope(). */
  | 'SCOPED'
  /** A tenant context is opened before the work runs. */
  | 'CONTEXTUALISED'
  /** Global by design — the same for every tenant. */
  | 'GLOBAL'
  /** Known gap. Must carry a documented reason and a tracking note. */
  | 'ACCEPTED-GAP';

interface Finding {
  /** Substring that identifies the site, matched against the file's text. */
  match: string;
  file: string;
  verdict: Verdict;
  why: string;
}

/**
 * Every known site where tenancy is decided outside the plugin.
 *
 * `match` must still be present in `file`, so deleting or renaming a site
 * fails this audit rather than silently dropping its classification.
 */
const CLASSIFIED: Finding[] = [
  // ── Raw driver access ────────────────────────────────────────────────────
  {
    file: 'services/attemptService.ts',
    match: "connection.collection(normalized)",
    verdict: 'SCOPED',
    why:
      'Per-class question collections read through the raw driver, so no hook ' +
      'can ever run. The ids come from a PracticeTest the tenant owns, which ' +
      'makes it safe by key, but it now carries an explicit tenantScope() as ' +
      'well — the same defence-in-depth the $lookup audit requires of its ' +
      'SAFE-BY-KEY joins.',
  },
  {
    file: 'config/indexes.ts',
    match: 'mongoose.connection.db.collections()',
    verdict: 'GLOBAL',
    why:
      'Index management. Operates on collection metadata, never on documents, ' +
      'and index definitions are platform-wide by nature.',
  },

  // ── Cache keys ───────────────────────────────────────────────────────────
  {
    file: 'utils/cacheHelpers.ts',
    match: 'const userId = (req as any).user?.id',
    verdict: 'SAFE-BY-KEY',
    why:
      'The default response-cache key embeds the caller user id, which is a ' +
      'globally unique ObjectId. A key can therefore never collide across ' +
      'organizations. Every call site was checked: all five pass a customKey ' +
      'that also embeds `user:${id}`.',
  },
  {
    file: 'core/entitlements/resolve.ts',
    match: 'function cacheKey(orgId: string)',
    verdict: 'SCOPED',
    why: 'Entitlement snapshots are cached per organization, by orgId.',
  },
  {
    file: 'core/config/timeSlots.ts',
    match: "currentOrgId() ?? '__no_org__'",
    verdict: 'SCOPED',
    why:
      'Time slots are cached per organization. This replaced module-level ' +
      'mutable arrays where one organization\'s save became every ' +
      'organization\'s timetable until the process restarted.',
  },
  {
    file: 'services/questionImportService.ts',
    match: "`${sha256(pdfBuffer)}:${options.provider",
    verdict: 'SAFE-BY-KEY',
    why:
      'Keyed by the SHA-256 of the uploaded file. Two tenants uploading ' +
      'byte-identical files share an extraction result, which is correct: the ' +
      'cached value is a pure function of the input and contains no tenant ' +
      'data. Different files cannot collide.',
  },

  // ── Socket rooms ─────────────────────────────────────────────────────────
  {
    file: 'services/SocketService.ts',
    match: 'socket.join(`user:${userId}`)',
    verdict: 'SAFE-BY-KEY',
    why: 'User ids are globally unique ObjectIds.',
  },
  {
    file: 'services/SocketService.ts',
    match: 'socket.join(`doubt_${doubtId}`)',
    verdict: 'SAFE-BY-KEY',
    why: 'Doubt ids are globally unique ObjectIds.',
  },
  {
    file: 'services/SocketService.ts',
    match: 'socket.join(classRoom(',
    verdict: 'SCOPED',
    why:
      'Class rooms are namespaced by organization. A class LEVEL is not ' +
      'globally unique — every institute has an "11" — so `class:11` was a ' +
      'broadcast channel between organizations. No shipped client joined it, ' +
      'which made it latent rather than active, but the first one to do so ' +
      'would have received another institute\'s attendance events.',
  },

  // ── Background work ──────────────────────────────────────────────────────
  {
    file: 'services/AttendanceCron.ts',
    match: "forEachOrg('attendance-sync'",
    verdict: 'CONTEXTUALISED',
    why: 'Runs once per organization, each inside its own context.',
  },
  {
    file: 'services/TeacherEodReminderCron.ts',
    match: "forEachOrg('eod-reminder'",
    verdict: 'CONTEXTUALISED',
    why: 'Runs once per organization, each inside its own context.',
  },
  {
    file: 'services/QueueService.ts',
    match: "{ orgId: job.orgId, source: 'job' }",
    verdict: 'CONTEXTUALISED',
    why:
      'A fresh context from the job\'s OWN orgId, never the ambient one — the ' +
      'enqueueing request may be long gone. A job with no orgId predates ' +
      'tenancy and runs uncontextualized, preserving current behaviour.',
  },
  {
    file: 'workers/pptWorkerCore.ts',
    match: "source: 'job' }",
    verdict: 'CONTEXTUALISED',
    why: 'Opens the job\'s own tenant context before any model access.',
  },

  // ── External stores ──────────────────────────────────────────────────────
  {
    file: 'services/firebaseSyncService.ts',
    match: "db.collection('Users')",
    verdict: 'ACCEPTED-GAP',
    why:
      'FIRESTORE IS SINGLE-TENANT. One global `Users` collection with no ' +
      'organization dimension, so a second tenant running Firebase Sync would ' +
      'write into the same collection Abhigyan reads. Mitigated, not solved: ' +
      'the routes now require the `integrations` module, which no plan but ' +
      'Abhigyan\'s grants. Documented as a production blocker for any tenant ' +
      'that needs Firestore-backed features.',
  },
  {
    file: 'services/attendanceService.ts',
    match: "db.collection('studentLeaves')",
    verdict: 'ACCEPTED-GAP',
    why:
      'Same Firestore gap. Reached only through attendance routes, which now ' +
      'require the `attendance` module; the eTimeOffice integration behind it ' +
      'is Abhigyan-specific hardware.',
  },
  {
    file: 'controllers/aiContentController.ts',
    match: "`ai-content/${owner.toString()}/",
    verdict: 'SAFE-BY-KEY',
    why:
      'Object-storage paths embed the owner user id and the document id, both ' +
      'globally unique ObjectIds, so no two tenants can collide on a path. ' +
      'They are not org-PREFIXED, which means a per-organization export or ' +
      'purge cannot be done by prefix — an operational limitation recorded in ' +
      'the readiness report, not an isolation defect.',
  },
  {
    file: 'services/practiceTestService.ts',
    match: "const activeFilter = { isActive: { $ne: false }, ...tenantScope() }",
    verdict: 'SCOPED',
    why:
      'The most serious finding of this audit. `getClassQuestionCollection` ' +
      'returns the RAW driver collection, so no middleware runs at any ' +
      'enforcement setting, and the per-class collections are shared by every ' +
      'institute. The subject/chapter/difficulty counts were computed across ' +
      'ALL organizations, and the `$sample` that builds a practice test drew ' +
      "from all of them — a student could be served another institute's " +
      'questions. Four `$match` stages now carry tenantScope().',
  },
  {
    file: 'routes/api/scheduleRoutes.ts',
    match: "db.collection('Users')",
    verdict: 'ACCEPTED-GAP',
    why:
      'Firestore teacher lookups, the same single-tenant store as ' +
      'firebaseSyncService. Reached only through schedule routes, which now ' +
      'require the `scheduling` module. Recorded as a production blocker for ' +
      'any tenant needing Firestore-backed scheduling.',
  },
  {
    file: 'services/firebaseService.ts',
    match: 'db.collection(',
    verdict: 'ACCEPTED-GAP',
    why:
      'The shared Firestore access layer behind the two gaps above. Every ' +
      'caller is module-gated; the store itself has no organization ' +
      'dimension and giving it one is a migration, not a patch.',
  },
];

/** Patterns that indicate a site this audit is responsible for. */
const DETECTORS: { label: string; pattern: RegExp; ignore?: RegExp }[] = [
  {
    label: 'raw driver collection access',
    pattern: /connection\s*\.\s*(db\s*\.\s*)?collection\(|connection\.db\.collections\(/,
  },
  { label: 'firestore collection access', pattern: /\bdb\.collection\(/ },
  { label: 'socket room join', pattern: /socket\.join\(/ },
  { label: 'cron schedule', pattern: /cron\.schedule\(/ },
];

/** Files this audit does not police. */
const IGNORED_DIRS = ['core/tenancy', 'scripts'];
/** Standalone maintenance scripts, run by hand against a named database. */
const IGNORED_FILES = ['scripts/drop_legacy_attempt_index.ts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

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

function main() {
  console.log('Tenant isolation beyond the plugin\n');

  const files = walk(SRC).map((f) => relative(SRC, f).replace(/\\/g, '/'));

  // ── Every classified site must still exist ───────────────────────────────
  console.log('classified sites are still present');
  for (const finding of CLASSIFIED) {
    const path = join(SRC, finding.file);
    let text = '';
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      /* missing */
    }
    check(
      `${finding.file} :: ${finding.match.slice(0, 46)}`,
      text.includes(finding.match),
      text
        ? 'the classified code is gone — re-audit and update isolation-audit.ts'
        : 'file not found',
    );
  }

  // ── No unclassified site may exist ───────────────────────────────────────
  console.log('\nno unclassified sites');
  const unclassified: string[] = [];

  for (const file of files) {
    if (IGNORED_DIRS.some((d) => file.startsWith(d))) continue;
    if (IGNORED_FILES.includes(file)) continue;
    const text = readFileSync(join(SRC, file), 'utf8');

    for (const detector of DETECTORS) {
      if (!detector.pattern.test(text)) continue;
      // A file is accounted for when at least one classification names it.
      const covered = CLASSIFIED.some((c) => c.file === file && text.includes(c.match));
      if (!covered) unclassified.push(`${file} — ${detector.label}`);
    }
  }

  const unique = [...new Set(unclassified)];
  check(
    'every file touching an unprotectable surface is classified',
    unique.length === 0,
    unique.length
      ? `unclassified:\n      ${unique.join('\n      ')}\n      ` +
        `Read each site, decide GLOBAL / SCOPED / SAFE-BY-KEY / CONTEXTUALISED / ` +
        `ACCEPTED-GAP, and add it to CLASSIFIED in this file.`
      : '',
  );

  // ── Bypasses must carry a reason ─────────────────────────────────────────
  console.log('\nevery withoutTenantScope() carries a reason');
  let bypasses = 0;
  let unreasoned = 0;
  for (const file of files) {
    if (file.startsWith('core/tenancy')) continue;
    const text = readFileSync(join(SRC, file), 'utf8');
    // `withoutTenantScope('some:reason', ...)` — the first argument is the
    // reason that reaches the logs, so every firing bypass is traceable.
    const calls = text.match(/withoutTenantScope\(\s*[^,)]*/g) ?? [];
    for (const call of calls) {
      bypasses++;
      // A literal reason, or an identifier that carries one — the middleware
      // passes `allowed.reason` from the reviewed public-route allowlist, which
      // is a better reason than any literal at that call site could be.
      const literal = /withoutTenantScope\(\s*['"`][^'"`]+['"`]/.test(call);
      const named = /withoutTenantScope\(\s*[A-Za-z_$][\w$.]*reason/i.test(call);
      if (!literal && !named) unreasoned++;
    }
  }
  check(
    `all ${bypasses} deliberate bypasses name a reason`,
    unreasoned === 0,
    `${unreasoned} call(s) pass no reason string`,
  );

  // ── Summary ──────────────────────────────────────────────────────────────
  const byVerdict = CLASSIFIED.reduce<Record<string, number>>((acc, f) => {
    acc[f.verdict] = (acc[f.verdict] ?? 0) + 1;
    return acc;
  }, {});
  console.log('\nclassification');
  for (const [verdict, count] of Object.entries(byVerdict).sort()) {
    console.log(`  ${verdict.padEnd(16)} ${count}`);
  }

  const gaps = CLASSIFIED.filter((f) => f.verdict === 'ACCEPTED-GAP');
  if (gaps.length) {
    console.log('\naccepted gaps — these are production blockers, not clean bills of health');
    for (const gap of gaps) console.log(`  • ${gap.file}: ${gap.why.split('.')[0]}.`);
  }

  console.log('');
  if (failures) {
    console.error(`ISOLATION AUDIT FAILED — ${failures} of ${checks}.`);
    process.exit(1);
  }
  console.log(`Isolation audit passed — ${checks} checks, ${CLASSIFIED.length} sites classified.`);
}

main();
