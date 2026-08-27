/**
 * What `/api/public/*` actually returns, and to whom.
 *
 * ── The question this answers ───────────────────────────────────────────────
 * `client-platform-app`'s guest mode is restricted to `/api/public/` by a
 * client-side guard, and that guard is verified. But a guard that correctly
 * restricts a guest to a set of endpoints proves nothing about what those
 * endpoints RETURN. The remaining question is the one the client cannot
 * answer: is the public surface tenant-scoped, and can a document belonging to
 * one organization reach a visitor exploring another?
 *
 * ── How it is answered ──────────────────────────────────────────────────────
 * Not by reading the handlers — they were read, and they look fine, which is
 * exactly the state in which this kind of bug survives. Two organizations get
 * public content seeded under them, then every public endpoint is called three
 * ways: with no identification at all, with `X-Org-Id` naming Org 001, and
 * with `X-Org-Id` naming Org 002. The responses are compared.
 *
 * If the three answers are identical, the surface is platform-global and every
 * institute's public content is visible to every visitor. That may be correct
 * — it is what "public" means for a shared catalogue — but it must be a
 * DECISION, and it must be true of nothing that is not intended to be public.
 *
 * ── What it also checks ─────────────────────────────────────────────────────
 * Every field of every returned document, against an allowlist. A public
 * endpoint that starts returning `uploadedBy`, `createdBy` or an `orgId` is
 * leaking who and where, even if the content itself was meant to be shared.
 *
 * Read-only. Seeds nothing it does not clean up, and refuses production.
 *
 *   API=http://127.0.0.1:5000 P6_MONGO_URI=<scratch> \
 *     node -r ./scripts/safety/dns-preload.js -r ts-node/register/transpile-only \
 *          scripts/safety/public-contract-audit.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
// Before any model import: without it the schemas have no `orgId` path and
// every ownership question this file asks would be answered about a field that
// does not exist. See core/tenancy/bootstrap.
import { registerTenancy } from '../../src/core/tenancy/bootstrap';

registerTenancy();

const API = process.env.API || 'http://127.0.0.1:5000';
const uri = process.env.P6_MONGO_URI || '';

let failures = 0;
let checks = 0;
const findings: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function note(text: string): void {
  findings.push(text);
  console.log(`  · ${text}`);
}

/** Fields a public document may carry. Anything else is a finding. */
const ALLOWED_FIELDS = new Set([
  '_id', 'title', 'description', 'type', 'kind', 'subject', 'classLevel', 'chapter',
  'board', 'exam', 'examType', 'difficulty', 'durationMins', 'duration', 'questionCount',
  'totalMarks', 'markingScheme', 'status', 'schedule', 'seriesId', 'orderInSeries',
  'thumbnailUrl', 'youtubeVideoId', 'pageCount', 'fileSize', 'viewCount', 'downloadCount',
  'isFeatured', 'contentCategory', 'resourceUrl', 'createdAt', 'updatedAt',
  // Decorated client-side by the controller for a signed-in learner. Null for a guest.
  'startable', 'myAttempt',
  // Aggregates computed by /public/subjects. Counts, not stored fields.
  'total', 'lectures', 'materials', 'chapterCount',
]);

/** Fields whose presence on a public document is a leak, named for the report. */
const FORBIDDEN_FIELDS = ['orgId', 'organizationId', 'uploadedBy', 'createdBy', 'updatedBy', 'tenantId', '__v'];

interface Probe {
  path: string;
  /** Where the documents live in the response. */
  pick: (body: any) => any[];
}

const PROBES: Probe[] = [
  { path: '/api/public/home', pick: (b) => [...(b?.featured ?? []), ...(b?.recent ?? [])] },
  { path: '/api/public/subjects', pick: (b) => (Array.isArray(b) ? b : []) },
  { path: '/api/public/tests', pick: (b) => b?.items ?? [] },
  { path: '/api/public/tests/filters', pick: () => [] },
  { path: '/api/public/series', pick: (b) => b?.items ?? (Array.isArray(b) ? b : []) },
  { path: '/api/public/search?q=phy', pick: (b) => b?.items ?? (Array.isArray(b) ? b : []) },
  { path: '/api/public/subject-content?subject=Physics', pick: (b) => b?.items ?? [] },
];

async function get(path: string, orgId?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (orgId) headers['X-Org-Id'] = orgId;
  const response = await fetch(`${API}${path}`, { headers });
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    /* not JSON */
  }
  return { status: response.status, body };
}

/** A stable signature of a response, for comparing two callers' answers. */
function signature(docs: any[]): string {
  return docs
    .map((d) => String(d?._id ?? d?.subject ?? JSON.stringify(d)))
    .sort()
    .join('|');
}

async function main(): Promise<void> {
  if (!uri) {
    console.error('P6_MONGO_URI is required.');
    process.exit(2);
  }
  const target = (uri.split('/').pop() || '').split('?')[0];
  const production = ((process.env.MONGO_URI || '').split('/').pop() || '').split('?')[0];
  if (!target || target === production) {
    console.error(`Refusing to run against "${target}".`);
    process.exit(2);
  }

  await mongoose.connect(uri);
  const { default: Organization } = await import('../../src/models/Org');
  const { default: StudyResource } = await import('../../src/models/StudyResource');
  const { default: PublicTest } = await import('../../src/models/PublicTest');

  const orgs = await Organization.find({}).select('_id name slug').lean();
  console.log(`\nPUBLIC CONTRACT AUDIT — ${API}, database ${target}\n`);
  console.log(`  organizations in this fixture: ${orgs.map((o: any) => o.name).join(', ')}\n`);

  if (orgs.length < 2) {
    console.error('Need two organizations to test cross-tenant visibility.');
    process.exit(2);
  }
  const [orgA, orgB] = orgs as any[];

  // ── What orgId did the seeded public documents get? ──────────────────────
  console.log('  ownership of public documents');
  const resources = await StudyResource.find({ isPublic: true, status: 'published' })
    .select('_id title orgId')
    .lean();
  const tests = await PublicTest.find({ status: 'published' }).select('_id title orgId').lean();

  const resourceOrgs = new Set(resources.map((r: any) => String(r.orgId ?? 'none')));
  const testOrgs = new Set(tests.map((t: any) => String(t.orgId ?? 'none')));
  note(`${resources.length} public resources, orgId values: ${[...resourceOrgs].join(', ')}`);
  note(`${tests.length} public tests, orgId values: ${[...testOrgs].join(', ')}`);

  // ── Does the answer depend on who is asking? ─────────────────────────────
  console.log('\n  cross-tenant visibility');
  for (const probe of PROBES) {
    const anon = await get(probe.path);
    if (anon.status === 404) {
      note(`${probe.path} — 404, endpoint not mounted; skipped`);
      continue;
    }
    const asA = await get(probe.path, String(orgA._id));
    const asB = await get(probe.path, String(orgB._id));

    check(`${probe.path} answers a guest at all`, anon.status === 200, `HTTP ${anon.status}`);
    if (anon.status !== 200) continue;

    const sigAnon = signature(probe.pick(anon.body));
    const sigA = signature(probe.pick(asA.body));
    const sigB = signature(probe.pick(asB.body));

    const identical = sigAnon === sigA && sigA === sigB;
    if (identical) {
      note(`${probe.path} — same answer for no-org, Org A and Org B (platform-global)`);
    } else {
      note(`${probe.path} — DIFFERENT answers per org (tenant-scoped)`);
    }

    // ── Field-level leakage ────────────────────────────────────────────────
    const docs = probe.pick(anon.body);
    const leaked = new Set<string>();
    const unknown = new Set<string>();
    for (const doc of docs) {
      if (!doc || typeof doc !== 'object') continue;
      for (const key of Object.keys(doc)) {
        if (FORBIDDEN_FIELDS.includes(key)) leaked.add(key);
        else if (!ALLOWED_FIELDS.has(key)) unknown.add(key);
      }
    }
    check(
      `${probe.path} returns no ownership or tenant fields`,
      leaked.size === 0,
      [...leaked].join(', '),
    );
    if (unknown.size) note(`${probe.path} — fields not on the allowlist: ${[...unknown].join(', ')}`);
  }

  // ── Write attempts must be refused ───────────────────────────────────────
  console.log('\n  the surface is read-only');
  for (const [method, path] of [
    ['POST', '/api/public/tests'],
    ['PUT', '/api/public/tests/000000000000000000000001'],
    ['DELETE', '/api/public/tests/000000000000000000000001'],
    ['POST', '/api/public/home'],
  ] as [string, string][]) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'DELETE' ? undefined : JSON.stringify({ title: 'audit' }),
    });
    check(
      `${method} ${path} is refused`,
      response.status === 401 || response.status === 403 || response.status === 404 || response.status === 405,
      `HTTP ${response.status}`,
    );
  }

  // ── The decisive one: does OWNERSHIP scope the public surface? ───────────
  //
  // Every endpoint above answered identically to Org A, Org B and to nobody.
  // That is only evidence of platform-global behaviour if the documents were
  // OWNED — an unowned document being visible to everyone would produce the
  // same result and mean much less. So one is created belonging to Org A and
  // asked for by Org B.
  console.log('\n  ownership scoping');

  // -- Why this write bypasses Mongoose --------------------------------------
  // The global tenancy plugin resolves the organization from the REQUEST
  // context. A script has none, so a document created through the model gets
  // no `orgId` even when one is supplied explicitly — the first version of
  // this probe did exactly that and unknowingly tested an unowned document.
  //
  // The raw driver bypasses the plugin, which is the only way to place a
  // document that genuinely belongs to Org A. That the bypass is required is
  // recorded as a finding rather than worked around silently.
  const rawResources = mongoose.connection.collection('studyresources');
  const ownedId = new mongoose.Types.ObjectId();
  const ownedTitle = `AUDIT owned-by-A ${Date.now()}`;
  await rawResources.insertOne({
    _id: ownedId,
    orgId: orgA._id,
    title: ownedTitle,
    subject: 'Physics',
    classLevel: '11',
    type: 'pdf',
    category: 'notes',
    resourceUrl: 'https://example.invalid/owned.pdf',
    uploadedBy: new mongoose.Types.ObjectId(),
    status: 'published',
    isPublic: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any);

  try {
    const stored = await rawResources.findOne({ _id: ownedId }, { projection: { orgId: 1 } });
    const storedOrg = String((stored as any)?.orgId ?? 'none');
    check(
      'the probe document really belongs to Org A',
      storedOrg === String(orgA._id),
      `stored orgId = ${storedOrg}`,
    );
    note(`probe document orgId = ${storedOrg} (Org A is ${String(orgA._id)})`);

    const anonSees = JSON.stringify((await get('/api/public/home')).body).includes(ownedTitle);
    const aSees = JSON.stringify((await get('/api/public/home', String(orgA._id))).body).includes(ownedTitle);
    const bSees = JSON.stringify((await get('/api/public/home', String(orgB._id))).body).includes(ownedTitle);

    note(`a resource OWNED BY Org A is visible to: ${[
      anonSees ? 'an anonymous visitor' : null,
      aSees ? 'Org A' : null,
      bSees ? 'Org B' : null,
    ].filter(Boolean).join(', ') || 'nobody'}`);

    if (bSees) {
      note(
        'PLATFORM-GLOBAL CONFIRMED: a document owned by one organization is ' +
          'returned to a visitor identifying as another. The public surface ' +
          'has no tenant dimension.',
      );
    } else {
      note('TENANT-SCOPED: the public surface filters by organization.');
    }

    // Whatever the scoping, the owner must never be disclosed.
    check(
      'the owning organization is never disclosed in the payload',
      !JSON.stringify((await get('/api/public/home')).body).includes(String(orgA._id)),
    );
  } finally {
    await rawResources.deleteOne({ _id: ownedId });
  }

  // ── A private document must not surface ──────────────────────────────────
  console.log('\n  the visibility floor holds');
  // Full documents, not partials: `StudyResource` requires `uploadedBy`,
  // `category` and `resourceUrl`, and a probe that fails validation proves
  // nothing about visibility.
  const base = {
    subject: 'Physics',
    classLevel: '11',
    type: 'pdf',
    category: 'notes',
    resourceUrl: 'https://example.invalid/audit.pdf',
    uploadedBy: new mongoose.Types.ObjectId(),
    orgId: orgA._id,
  };
  const probeTitle = `AUDIT private resource ${Date.now()}`;
  await StudyResource.create({
    ...base,
    title: probeTitle,
    status: 'published',
    isPublic: false, // the flag under test
  } as any);
  const draftTitle = `AUDIT draft resource ${Date.now()}`;
  await StudyResource.create({
    ...base,
    title: draftTitle,
    status: 'draft',
    isPublic: true, // the status under test
  } as any);

  try {
    const home = await get('/api/public/home');
    const search = await get('/api/public/search?q=AUDIT');
    const subjectContent = await get('/api/public/subject-content?subject=Physics');
    const seen = JSON.stringify([home.body, search.body, subjectContent.body]);

    check('a published-but-not-public resource stays hidden', !seen.includes(probeTitle));
    check('a public-but-draft resource stays hidden', !seen.includes(draftTitle));
  } finally {
    await StudyResource.deleteMany({ title: { $in: [probeTitle, draftTitle] } });
  }

  await mongoose.disconnect();

  console.log('\n  findings');
  for (const f of findings) console.log(`   - ${f}`);

  console.log('');
  if (failures) {
    console.error(`PUBLIC CONTRACT AUDIT — ${failures} of ${checks} checks failed.`);
    process.exit(1);
  }
  console.log(`All ${checks} public contract checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
