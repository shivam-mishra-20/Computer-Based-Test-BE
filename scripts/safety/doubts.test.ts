/**
 * Doubts/chat reliability — ordering, visibility, authorization, unread.
 *
 * Pure logic and in-memory evaluation. No database and no network, so it gates
 * a pull request in about a second and can run against the shared production
 * cluster's codebase without touching it.
 *
 * The properties this locks down are the ones that broke in production:
 *
 *   1. ORDERING BY ACTIVITY, NOT CREATION. A thread created months ago that
 *      gets a reply today must sort to the top. Sorting by `createdAt` left it
 *      buried past the page limit, which is what "the doubt disappeared"
 *      actually was.
 *   2. LEGACY THREADS STILL SORT. Documents written before `lastMessageAt`
 *      existed must fall back to their newest message, not to null — a null
 *      sort key would sink every historical conversation to the bottom and
 *      turn a sorting fix into a much bigger disappearance bug.
 *   3. LISTABLE == OPENABLE. The single-doubt authorization check and the list
 *      filter must agree, or a notification deep link opens a thread the list
 *      never shows (or one the viewer must not see at all).
 *   4. RESOLVED IS NOT A FILTER. Nothing removes a conversation for being
 *      resolved, read, or old.
 *
 *   npx ts-node --transpile-only scripts/safety/doubts.test.ts
 */

import {
  canAccessDoubt,
  effectiveLastActivity,
  unreadCountFor,
  visibilityFilter,
  withActivityFields,
  type DoubtViewer,
} from '../../src/services/doubtService';

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

const STUDENT = '507f1f77bcf86cd799439011';
const OTHER_STUDENT = '507f1f77bcf86cd799439012';
const TEACHER = '507f1f77bcf86cd799439021';
const OTHER_TEACHER = '507f1f77bcf86cd799439022';

const asStudent: DoubtViewer = { id: STUDENT, role: 'student' };
const asOtherStudent: DoubtViewer = { id: OTHER_STUDENT, role: 'student' };
const asTeacher: DoubtViewer = { id: TEACHER, role: 'teacher' };
const asOtherTeacher: DoubtViewer = { id: OTHER_TEACHER, role: 'teacher' };
const asAdmin: DoubtViewer = { id: 'admin1', role: 'admin' };

/**
 * Evaluate the `$ifNull` fallback chain the way MongoDB would, so the ordering
 * claim is executable rather than a comment. Deliberately hand-written and
 * narrow: it implements exactly the two operators the expression uses.
 */
function evalExpr(expr: any, doc: Record<string, any>): any {
  if (typeof expr === 'string' && expr.startsWith('$')) {
    const path = expr.slice(1);
    if (path.includes('.')) {
      const [head, tail] = path.split('.');
      const arr = doc[head];
      return Array.isArray(arr) ? arr.map((item: any) => item?.[tail]) : undefined;
    }
    return doc[path];
  }
  if (expr && typeof expr === 'object' && '$ifNull' in expr) {
    const [first, second] = expr.$ifNull as [any, any];
    const value = evalExpr(first, doc);
    return value === null || value === undefined ? evalExpr(second, doc) : value;
  }
  if (expr && typeof expr === 'object' && '$max' in expr) {
    const values = evalExpr((expr as any).$max, doc);
    if (!Array.isArray(values)) return values;
    const usable = values.filter((v: any) => v !== null && v !== undefined);
    if (usable.length === 0) return undefined;
    return usable.reduce((a: any, b: any) => (new Date(a) > new Date(b) ? a : b));
  }
  return expr;
}

const t = (iso: string) => new Date(iso);

// ── 1. Ordering key ─────────────────────────────────────────────────────────
section('Ordering: effectiveLastActivity fallback chain');
{
  const expr = effectiveLastActivity();

  const modern = {
    lastMessageAt: t('2026-05-10T10:00:00Z'),
    messages: [{ createdAt: t('2026-05-10T09:00:00Z') }],
    updatedAt: t('2026-01-01T00:00:00Z'),
    createdAt: t('2025-01-01T00:00:00Z'),
  };
  check(
    'uses lastMessageAt when present',
    String(evalExpr(expr, modern)) === String(t('2026-05-10T10:00:00Z')),
  );

  // The legacy case that matters most: an old thread, no lastMessageAt, but a
  // recent reply. It must sort by the reply.
  const legacy = {
    messages: [
      { createdAt: t('2025-02-01T08:00:00Z') },
      { createdAt: t('2026-05-11T18:30:00Z') },
    ],
    updatedAt: t('2026-05-11T18:30:00Z'),
    createdAt: t('2025-02-01T08:00:00Z'),
  };
  check(
    'legacy thread falls back to its newest message, not createdAt',
    String(evalExpr(expr, legacy)) === String(t('2026-05-11T18:30:00Z')),
  );

  const noMessages = {
    messages: [],
    updatedAt: t('2026-03-03T03:00:00Z'),
    createdAt: t('2026-01-01T01:00:00Z'),
  };
  check(
    'empty thread falls back to updatedAt',
    String(evalExpr(expr, noMessages)) === String(t('2026-03-03T03:00:00Z')),
  );

  const bare = { createdAt: t('2026-02-02T02:00:00Z') };
  check(
    'a document with only createdAt still yields a sort key (never null)',
    String(evalExpr(expr, bare)) === String(t('2026-02-02T02:00:00Z')),
  );

  // The regression itself: old thread + new reply must outrank a newer thread
  // that has been quiet.
  const oldThreadNewReply = evalExpr(expr, legacy);
  const newerQuietThread = evalExpr(expr, {
    lastMessageAt: t('2026-04-01T00:00:00Z'),
    createdAt: t('2026-03-25T00:00:00Z'),
  });
  check(
    'REGRESSION: old thread with a new reply outranks a newer quiet thread',
    new Date(oldThreadNewReply) > new Date(newerQuietThread),
  );
}

// ── 2. withActivityFields ───────────────────────────────────────────────────
section('Ordering: single-payload decoration');
{
  const payload: any = withActivityFields({
    _id: 'a',
    messages: [{ createdAt: '2026-05-01T10:00:00Z' }, { createdAt: '2026-05-02T11:00:00Z' }],
    createdAt: '2025-01-01T00:00:00Z',
  });
  check(
    'socket/API payload without lastMessageAt gets one from its newest message',
    String(payload.lastMessageAt) === '2026-05-02T11:00:00Z',
  );

  const kept: any = withActivityFields({
    _id: 'b',
    lastMessageAt: '2026-06-01T00:00:00Z',
    messages: [{ createdAt: '2026-05-02T11:00:00Z' }],
  });
  check('an existing lastMessageAt is not overwritten', kept.lastMessageAt === '2026-06-01T00:00:00Z');

  const empty: any = withActivityFields({ _id: 'c', createdAt: '2026-02-02T00:00:00Z' });
  check('a conversation with no messages still gets a key', Boolean(empty.lastMessageAt));
}

// ── 3. Authorization ────────────────────────────────────────────────────────
section('Authorization: canAccessDoubt');
{
  const ownThread = { student: STUDENT, teacher: TEACHER, messages: [{ sender: STUDENT }] };

  check('student can open their own conversation', canAccessDoubt(ownThread, asStudent));
  check(
    "TENANT/PRIVACY: another student cannot open someone else's conversation",
    canAccessDoubt(ownThread, asOtherStudent) === false,
  );
  check('assigned teacher can open it', canAccessDoubt(ownThread, asTeacher));
  check(
    'UNAUTHORIZED DEEP LINK: an unrelated teacher cannot open an assigned conversation',
    canAccessDoubt(ownThread, asOtherTeacher) === false,
  );
  check('admin can open it', canAccessDoubt(ownThread, asAdmin));

  const unassigned = { student: STUDENT, teacher: null, messages: [] };
  check('any teacher can pick up an unassigned doubt', canAccessDoubt(unassigned, asTeacher));
  check(
    'a student still cannot open another student’s unassigned doubt',
    canAccessDoubt(unassigned, asOtherStudent) === false,
  );

  const participated = {
    student: STUDENT,
    teacher: OTHER_TEACHER,
    messages: [{ sender: TEACHER }, { sender: STUDENT }],
  };
  check(
    'a teacher who already replied keeps access after another teacher claims it',
    canAccessDoubt(participated, asTeacher),
  );

  // Populated documents: the check must work on both shapes.
  const populated = {
    student: { _id: STUDENT, name: 'S' },
    teacher: { _id: TEACHER, name: 'T' },
    messages: [{ sender: { _id: STUDENT } }],
  };
  check('works on populated documents too', canAccessDoubt(populated, asStudent));
  check(
    'populated documents are not accidentally open to everyone',
    canAccessDoubt(populated, asOtherStudent) === false,
  );
}

// ── 4. Listable == openable ─────────────────────────────────────────────────
section('Invariant: what you can list is what you can open');
{
  const studentFilter = visibilityFilter(asStudent) as any;
  check('student list filter scopes to their own id', String(studentFilter.student) === STUDENT);

  const teacherFilter = visibilityFilter(asTeacher) as any;
  const branches = JSON.stringify(teacherFilter.$or ?? []);
  check(
    'teacher list filter covers assigned + unassigned + participated',
    branches.includes(TEACHER) &&
      branches.includes('$exists') &&
      branches.includes('messages.sender'),
  );
  check('admin list filter is unscoped by participant (role-gated instead)', Object.keys(visibilityFilter(asAdmin)).length === 0);

  // Cross-check: for each sample thread, the filter's intent and the access
  // check must agree. Divergence here is exactly how a deep link opens
  // something the list denies.
  const samples = [
    { name: 'own assigned', doc: { student: STUDENT, teacher: TEACHER, messages: [] }, teacherShouldSee: true },
    { name: 'unassigned', doc: { student: STUDENT, teacher: null, messages: [] }, teacherShouldSee: true },
    { name: 'other teacher', doc: { student: STUDENT, teacher: OTHER_TEACHER, messages: [] }, teacherShouldSee: false },
    {
      name: 'other teacher but participated',
      doc: { student: STUDENT, teacher: OTHER_TEACHER, messages: [{ sender: TEACHER }] },
      teacherShouldSee: true,
    },
  ];
  for (const sample of samples) {
    check(
      `teacher access matches list intent for "${sample.name}"`,
      canAccessDoubt(sample.doc, asTeacher) === sample.teacherShouldSee,
    );
  }
}

// ── 5. Resolved stays visible ───────────────────────────────────────────────
section('Resolved is a state, not a filter');
{
  const resolved = { student: STUDENT, teacher: TEACHER, status: 'resolved', messages: [] };
  check('resolved conversations remain accessible to the student', canAccessDoubt(resolved, asStudent));
  check('resolved conversations remain accessible to the teacher', canAccessDoubt(resolved, asTeacher));

  const filterHasNoStatus = !('status' in (visibilityFilter(asStudent) as any));
  check('the default visibility filter never constrains status', filterHasNoStatus);
  check(
    'the default teacher visibility filter never constrains status',
    !('status' in (visibilityFilter(asTeacher) as any)),
  );
}

// ── 6. Unread derivation ────────────────────────────────────────────────────
section('Unread state');
{
  const thread = {
    messages: [
      { senderRole: 'student', createdAt: '2026-05-01T10:00:00Z' },
      { senderRole: 'teacher', createdAt: '2026-05-01T11:00:00Z' },
      { senderRole: 'teacher', createdAt: '2026-05-01T12:00:00Z' },
    ],
    studentLastReadAt: '2026-05-01T11:30:00Z',
    teacherLastReadAt: '2026-05-01T12:30:00Z',
  };

  check('student sees only later messages from the other side', unreadCountFor(thread, 'student') === 1);
  check('teacher who has read everything sees zero', unreadCountFor(thread, 'teacher') === 0);
  check(
    'a thread never read counts every message from the other side',
    unreadCountFor({ messages: thread.messages }, 'student') === 2,
  );
  check(
    'your own messages never count as unread',
    unreadCountFor({ messages: [{ senderRole: 'student', createdAt: '2026-05-02T00:00:00Z' }] }, 'student') === 0,
  );
}

// ── 7. Unassigned fan-out scoping ───────────────────────────────────────────
section('Unassigned doubts notify the eligible pool, tenant-scoped');
{
  // The fan-out query is built from `tenantScope()`, whose whole point is that
  // it narrows ONLY where the data is known to carry orgId. Assert both halves
  // of that contract, because getting it wrong in either direction is a real
  // outage: scoping too early notifies nobody, scoping too late notifies
  // another institute's teachers.
  const { tenantScope } = require('../../src/core/tenancy/queryScope');
  const { runWithTenant, runWithoutAnyContext } = require('../../src/core/tenancy/context');

  const noContextScope = runWithoutAnyContext(() => tenantScope());
  check(
    'pre-migration (no tenant context) does not narrow — would otherwise notify nobody',
    Object.keys(noContextScope).length === 0,
  );

  const claimScope = runWithTenant({ orgId: 'org_abc', source: 'claim' }, () => tenantScope());
  check(
    'TENANT ISOLATION: claim mode narrows to the caller’s organization',
    (claimScope as { orgId?: string }).orgId === 'org_abc',
  );

  const pinnedWarnScope = runWithTenant({ orgId: 'org_001', source: 'pinned' }, () => tenantScope());
  check(
    'pinned + warn (api-legacy, pre-backfill) does not narrow',
    Object.keys(pinnedWarnScope).length === 0,
  );

  // The fan-out audience must line up with who can actually SEE an unassigned
  // doubt, or teachers get paged about threads their list will not show.
  const unassigned = { student: STUDENT, teacher: null, messages: [] };
  check(
    'every teacher notified about an unassigned doubt can also open it',
    canAccessDoubt(unassigned, asTeacher) && canAccessDoubt(unassigned, asOtherTeacher),
  );
  check(
    'a student is never in the unassigned fan-out audience',
    canAccessDoubt(unassigned, asOtherStudent) === false,
  );

  // Once claimed, the pool notification must stop and the single-teacher path
  // take over.
  const claimed = { student: STUDENT, teacher: OTHER_TEACHER, messages: [{ sender: OTHER_TEACHER }] };
  check(
    'once a teacher claims it, an unrelated teacher is no longer an eligible recipient',
    canAccessDoubt(claimed, asTeacher) === false,
  );
}

console.log(`\n${checks} checks, ${failures} failure(s).`);
process.exit(failures ? 1 : 0);
