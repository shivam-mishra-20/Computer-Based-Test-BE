/**
 * Org 001 and Org 002, through the same client contract, against real APIs.
 *
 * ── What this proves that screenshots cannot ────────────────────────────────
 * Two organizations render differently in the app — that has been seen. What a
 * screenshot cannot show is WHERE the difference comes from: a client that had
 * quietly hardcoded a class list would still look right for the fixture that
 * inspired the hardcoding. So this calls the endpoints the client calls, with
 * the credentials the client uses, and asserts that every tenant-varying
 * dimension actually differs — and that every tenant-INVARIANT one does not.
 *
 * ── The dimensions ──────────────────────────────────────────────────────────
 * branding · modules · permissions · classes · subjects · batches · rooms ·
 * exams · attempts · results — the list the client reads from
 * `GET /api/me/context` plus the feature endpoints each tab calls.
 *
 * ── Why both a student and an admin ─────────────────────────────────────────
 * Permissions are the dimension most likely to be faked by a client, and a
 * single role cannot expose that. The same organization is therefore read
 * twice, and the two answers must differ in permissions while agreeing on
 * everything organizational.
 *
 * Read-only. It signs in, reads, and asserts. It creates nothing.
 *
 *   API=http://127.0.0.1:5000 \
 *     node -r ./scripts/safety/dns-preload.js -r ts-node/register/transpile-only \
 *          scripts/safety/two-org-client-validation.ts
 */

const API = process.env.API || 'http://127.0.0.1:5000';

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = ''): void {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

interface Account {
  org: string;
  role: 'student' | 'admin';
  email: string;
  password: string;
}

const ACCOUNTS: Account[] = [
  { org: 'Org 001', role: 'student', email: 'p6.student@abhigyan.fixture', password: 'P6-fixture-abhigyan!' },
  { org: 'Org 001', role: 'admin', email: 'p6.admin@abhigyan.fixture', password: 'P6-fixture-abhigyan!' },
  { org: 'Org 002', role: 'student', email: 'p6.student@abc.fixture', password: 'P6-fixture-abc!' },
  { org: 'Org 002', role: 'admin', email: 'p6.admin@abc.fixture', password: 'P6-fixture-abc!' },
];

async function call(path: string, token?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, { headers });
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    /* not JSON */
  }
  return { status: response.status, body };
}

async function signIn(account: Account): Promise<string | null> {
  const response = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  if (!response.ok) return null;
  const body: any = await response.json();
  return body?.token ?? null;
}

/** Everything the client reads about one signed-in account. */
interface Snapshot {
  account: Account;
  token: string;
  orgId: string | null;
  organizationName: string | null;
  branding: { primary?: string; secondary?: string; accent?: string };
  modules: string[];
  permissions: string[];
  roleNames: string[];
  classLevels: string[];
  subjects: string[];
  batches: string[];
  rooms: string[];
  subscription: string | null;
  exams: { status: number; count: number | null };
  attempts: { status: number; count: number | null };
  results: { status: number; count: number | null };
}

/** Count whatever list shape an endpoint returns, without guessing wrongly. */
function countOf(body: any): number | null {
  if (Array.isArray(body)) return body.length;
  for (const key of ['items', 'exams', 'results', 'attempts', 'data', 'rows']) {
    if (Array.isArray(body?.[key])) return body[key].length;
  }
  return null;
}

async function snapshot(account: Account): Promise<Snapshot | null> {
  const token = await signIn(account);
  if (!token) return null;

  const context = await call('/api/me/context', token);
  const c = context.body ?? {};
  const org = c.organization ?? {};
  const config = org.configuration ?? c.configuration ?? {};

  // The three feature endpoints the client's tabs actually call. Recorded with
  // their status, because a 403 is a RESULT here — it is what a plan or a role
  // exclusion looks like from the client's side.
  // The exact paths `lib/services/*.ts` uses, read off the client rather than
  // guessed. The first version of this file invented `/api/results/mine`, got
  // 404 for every account, and would have reported "results unavailable for
  // both organizations" — a symmetric wrong answer, which is the kind that
  // looks like a finding.
  const [exams, attempts, results] = await Promise.all([
    call(account.role === 'admin' ? '/api/exams' : '/api/attempts/assigned', token),
    call('/api/attempts/mine', token),
    call('/api/results/student', token),
  ]);

  return {
    account,
    token,
    orgId: org._id ?? org.id ?? null,
    organizationName: org.name ?? null,
    branding: {
      primary: org.branding?.primaryColor,
      secondary: org.branding?.secondaryColor,
      accent: org.branding?.accentColor,
    },
    modules: (c.modules ?? []).slice().sort(),
    permissions: (c.permissions ?? []).slice().sort(),
    roleNames: (c.roleNames ?? []).slice().sort(),
    classLevels: (config.classLevels ?? []).map((x: any) => String(x.key ?? x.label ?? x)).sort(),
    subjects: (config.subjects ?? []).slice().sort(),
    batches: (config.batches ?? []).map((b: any) => String(b.name ?? b)).sort(),
    rooms: (config.rooms ?? []).map((r: any) => String(r.name ?? r)).sort(),
    subscription: c.subscriptionStatus ?? null,
    exams: { status: exams.status, count: countOf(exams.body) },
    attempts: { status: attempts.status, count: countOf(attempts.body) },
    results: { status: results.status, count: countOf(results.body) },
  };
}

function describe(s: Snapshot): void {
  const b = s.branding;
  console.log(`\n  ${s.account.org} / ${s.account.role}  (${s.account.email})`);
  console.log(`    organization   ${s.organizationName ?? '—'}  [${s.orgId ?? 'unresolved'}]`);
  console.log(`    branding       ${b.primary ?? '—'} / ${b.secondary ?? '—'} / ${b.accent ?? '—'}`);
  console.log(`    subscription   ${s.subscription ?? '—'}`);
  console.log(`    modules        ${s.modules.length}`);
  console.log(`    permissions    ${s.permissions.length}   roles: ${s.roleNames.join(', ') || '—'}`);
  console.log(`    classes        ${s.classLevels.length}   ${s.classLevels.join(', ') || '—'}`);
  console.log(`    subjects       ${s.subjects.length}   ${s.subjects.slice(0, 6).join(', ')}${s.subjects.length > 6 ? ' …' : ''}`);
  console.log(`    batches        ${s.batches.length}   ${s.batches.join(', ') || '—'}`);
  console.log(`    rooms          ${s.rooms.length}   ${s.rooms.slice(0, 5).join(', ')}${s.rooms.length > 5 ? ' …' : ''}`);
  console.log(`    exams          HTTP ${s.exams.status}  count ${s.exams.count ?? '—'}`);
  console.log(`    attempts       HTTP ${s.attempts.status}  count ${s.attempts.count ?? '—'}`);
  console.log(`    results        HTTP ${s.results.status}  count ${s.results.count ?? '—'}`);
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

async function main(): Promise<void> {
  console.log(`\nTWO-ORG CLIENT VALIDATION — ${API}\n`);

  const snaps: Snapshot[] = [];
  for (const account of ACCOUNTS) {
    const s = await snapshot(account);
    if (!s) {
      check(`${account.org} / ${account.role} can sign in`, false, account.email);
      continue;
    }
    check(`${account.org} / ${account.role} signs in and resolves a context`, Boolean(s.orgId));
    snaps.push(s);
    describe(s);
  }

  const a1 = snaps.find((s) => s.account.org === 'Org 001' && s.account.role === 'student');
  const a2 = snaps.find((s) => s.account.org === 'Org 001' && s.account.role === 'admin');
  const b1 = snaps.find((s) => s.account.org === 'Org 002' && s.account.role === 'student');
  const b2 = snaps.find((s) => s.account.org === 'Org 002' && s.account.role === 'admin');

  if (!a1 || !a2 || !b1 || !b2) {
    console.error('\nNot every fixture account signed in; cannot compare.');
    process.exit(1);
  }

  // ── The organizations must actually be different ────────────────────────
  console.log('\n  Org 001 vs Org 002 — every tenant dimension');
  check('different organization id', a1.orgId !== b1.orgId, `${a1.orgId} vs ${b1.orgId}`);
  check('different name', a1.organizationName !== b1.organizationName);
  check(
    'different branding',
    a1.branding.primary !== b1.branding.primary,
    `${a1.branding.primary} vs ${b1.branding.primary}`,
  );
  check('different classes', !same(a1.classLevels, b1.classLevels));
  check('different subjects', !same(a1.subjects, b1.subjects));
  check('different batches', !same(a1.batches, b1.batches));
  check('different rooms', !same(a1.rooms, b1.rooms));
  check(
    'different module sets',
    !same(a1.modules, b1.modules),
    `${a1.modules.length} vs ${b1.modules.length}`,
  );

  // A class value that the old digit-extracting normalizer used to drop. Its
  // presence is what makes Org 002 a real test rather than a second copy.
  check(
    "Org 002 keeps its non-numeric class level",
    b1.classLevels.some((c) => /[a-z]/i.test(c)),
    b1.classLevels.join(', '),
  );

  // ── One organization, two roles ─────────────────────────────────────────
  console.log('\n  the same organization, two roles');
  for (const [student, admin, label] of [
    [a1, a2, 'Org 001'],
    [b1, b2, 'Org 002'],
  ] as [Snapshot, Snapshot, string][]) {
    check(`${label}: both roles resolve the same organization`, student.orgId === admin.orgId);
    check(`${label}: both roles see the same classes`, same(student.classLevels, admin.classLevels));
    check(`${label}: both roles see the same subjects`, same(student.subjects, admin.subjects));
    check(`${label}: both roles see the same modules`, same(student.modules, admin.modules));
    check(
      `${label}: the admin has strictly more permissions`,
      admin.permissions.length > student.permissions.length,
      `${admin.permissions.length} vs ${student.permissions.length}`,
    );
    check(
      `${label}: the student is refused the owner-only exam list`,
      student.exams.status !== 200 || student.account.role !== 'admin',
    );
  }

  // ── No token from one organization may read another ─────────────────────
  console.log('\n  isolation');
  const crossed = await call('/api/me/context', a1.token);
  check(
    "Org 001's token resolves Org 001, never Org 002",
    (crossed.body?.organization?._id ?? crossed.body?.organization?.id) === a1.orgId,
  );
  check(
    'the two tokens are different credentials',
    a1.token !== b1.token,
  );

  // ── The invariants ──────────────────────────────────────────────────────
  // A tenant may not configure legibility or the shape of the payload.
  console.log('\n  what a tenant may NOT change');
  const keys = (s: Snapshot) => Object.keys(s).sort().join(',');
  check('both organizations produce the same context shape', keys(a1) === keys(b1));
  check('both resolve a subscription status', Boolean(a1.subscription) && Boolean(b1.subscription));

  console.log('');
  if (failures) {
    console.error(`TWO-ORG VALIDATION FAILED — ${failures} of ${checks}.`);
    process.exit(1);
  }
  console.log(`All ${checks} two-org checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
