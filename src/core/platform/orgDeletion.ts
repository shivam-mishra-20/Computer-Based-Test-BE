/**
 * Deleting an organization and everything it owns — planned by the server,
 * run in resumable chunks, verified before it is called done.
 *
 * ── Where the inventory comes from ──────────────────────────────────────────
 * Not a hand-written list. A list would be right on the day it was written and
 * wrong the first time someone added a model, and the thing it would miss is
 * exactly the thing that makes a deletion incomplete. Instead the plan is built
 * from the DATABASE: every collection is asked how many documents it holds for
 * this organization (`orgId`, as a string or an ObjectId — every model on the
 * platform attributes ownership through that one field, whether stamped by the
 * tenancy plugin or declared by hand). Whatever answers non-zero is in the plan,
 * including collections no model describes.
 *
 * Only documents whose `orgId` matches are ever deleted. A shared collection
 * such as `users` loses this organization's rows and nothing else; no
 * collection is dropped except the organization's own registration collection,
 * whose name the SERVER assigned and re-checks here. A record written before
 * organizations were tagged carries no `orgId`, cannot be attributed, and is
 * not deleted — that is the correct answer, and the plan says so.
 *
 * Two collections are never touched: `orgs`, which holds this organization's
 * own record and is removed as the very last step, and `platformaudits`, the
 * platform's record of what happened — including this deletion.
 *
 * ── Why it runs in the background, and why that is safe ─────────────────────
 * An organization can own hundreds of thousands of documents and thousands of
 * files; one HTTP request cannot hold that. The request validates, records the
 * plan ON the organization (`Org.deletion`) and returns; the runner works
 * through the steps in batches, saving progress after each. The organization
 * record is deleted LAST, so while any data remains the organization is still
 * visible as "deleting", with the step it reached. A run that fails, or a
 * process that dies, leaves that record behind — detectable, and resumable from
 * where it stopped. Every step is idempotent: re-deleting what is already gone
 * deletes nothing.
 *
 * ── What "done" means ───────────────────────────────────────────────────────
 * After the steps, the database and storage are scanned AGAIN from scratch.
 * Anything found (say, a row written while the run was going) becomes another
 * step and the run goes round again, a bounded number of times. Only when a
 * scan comes back empty is the organization removed and the summary written to
 * the platform audit log; otherwise the deletion is marked failed with what
 * remains — never quietly declared complete.
 *
 * ── External resources ──────────────────────────────────────────────────────
 * An organization's EAS project lives in Expo's systems. The platform asks
 * Expo to delete it (`eas project:delete`, with the server-side token), but
 * only when it is provably this organization's own: named after it, and
 * referenced by no other organization. Expo may refuse — it can demand the
 * owner's password ("sudo mode") for deletions. Then the deletion ends
 * INCOMPLETE: every row and file is gone and verified, and the organization
 * remains as a stripped record naming the project that still exists, until
 * someone deletes it in Expo and retries, or explicitly finishes without it.
 * Neither path ever reports the project as deleted when it is not.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';
import Org, { IOrgDeletionStep } from '../../models/Org';
import AppBuildJob, { LIVE_BUILD_STATUSES } from '../../models/AppBuildJob';
import PlatformAudit from '../../models/PlatformAudit';
import { withoutTenantScope } from '../tenancy/context';
import { clearHostResolutionCache } from '../tenancy/hostResolution';
import { clearOrgStateCache } from '../tenancy/orgState';
import { pinnedOrgId } from '../tenancy/config';
import { countStoragePrefix, deleteStoragePrefix } from '../storage/storageService';
import { isValidRegistrationCollection } from '../registration/registrationStore';
import { deleteEasProject, isEasConfigured } from './easClient';

/** An organization must be taken out of service before it can be deleted. */
export const DELETABLE_STATUSES = ['suspended', 'cancelled', 'terminated'];
/** The platform's record of what happened. Never deleted from. */
const RETAINED = new Set(['platformaudits']);
/** The organization registry. Its one document is the LAST thing removed. */
const REGISTRY = 'orgs';
/** Documents per delete. Small enough to keep each round trip short. */
const BATCH = 500;
/** A running deletion with no progress for this long is treated as stalled. */
export const STALL_MS = 2 * 60 * 1000;
/** How long a preview's confirmation token is good for. */
const PLAN_TOKEN_TTL_MS = 15 * 60 * 1000;
/** Rounds of delete → rescan before giving up on data that keeps appearing. */
const MAX_PASSES = 3;

const FRIENDLY: Record<string, string> = {
  users: 'Users',
  organizationregistrations: 'Onboarding applications',
  appbuildjobs: 'App build records',
  entitlements: 'Entitlements',
  subscriptions: 'Subscriptions',
  usagerecords: 'Usage records',
  roles: 'Roles',
  auditlogs: 'Organization audit log',
  guardianlinks: 'Parent ↔ student links',
  exams: 'Exams',
  attempts: 'Exam attempts',
  questions: 'Questions',
  notifications: 'Notifications',
  classlevels: 'Classes',
  subjects: 'Subjects',
  batches: 'Batches',
  orgrooms: 'Rooms',
  orgpolicies: 'Policies',
  schedules: 'Timetable',
  homeworks: 'Homework',
  materials: 'Study material',
  doubts: 'Doubts',
  testresults: 'Offline test results',
  roomallocations: 'Room allocations',
};

export class DeletionRefused extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = 'DeletionRefused';
  }
}

export type DeletionStep = IOrgDeletionStep;

export interface DeletionPlan {
  orgId: string;
  slug: string;
  name: string;
  status: string;
  /** Reasons the deletion cannot start. Empty means it can. */
  blockers: string[];
  steps: DeletionStep[];
  totals: { documents: number; collections: number; storageObjects: number; external: number };
  notes: string[];
}

export interface Staff {
  id: string;
  email?: string;
  role?: string;
  ip?: string;
}

/** Test seam: fail the named step once, to prove failure and resume. Never set in production. */
export const __deletionTestHooks: { failAtStep: string | null } = { failAtStep: null };

function db() {
  const database = mongoose.connection.db;
  if (!database) throw new Error('No database connection.');
  return database;
}

/** `orgId` is a string on tenant-scoped models and an ObjectId on a few platform ones. */
function ownedBy(orgId: string): Record<string, unknown> {
  return { orgId: { $in: [orgId, new mongoose.Types.ObjectId(orgId)] } };
}

async function loadOrg(orgId: string) {
  if (!mongoose.isValidObjectId(orgId)) return null;
  return withoutTenantScope('org-delete:load', async () => Org.findById(orgId).lean());
}

function ownCollectionOf(org: { registrationStore?: { collection?: string } }): string | null {
  const name = org.registrationStore?.collection;
  return isValidRegistrationCollection(name) ? (name as string) : null;
}

function isStalled(deletion: { status?: string; heartbeatAt?: Date } | undefined): boolean {
  return (
    deletion?.status === 'running' && Date.now() - new Date(deletion.heartbeatAt ?? 0).getTime() >= STALL_MS
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   The plan
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Every collection holding this organization's rows, as steps. Used for the
 * plan AND, after the run, as the verification scan — one definition of
 * "what this organization still owns".
 */
async function documentSteps(orgId: string, ownCollection: string | null): Promise<DeletionStep[]> {
  const names = (await db().listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.') && !RETAINED.has(n) && n !== REGISTRY)
    .sort();
  const steps: DeletionStep[] = [];
  for (const name of names) {
    if (name.startsWith('reg_')) {
      // Another organization's registration collection is never touched,
      // however its documents happen to be tagged. This organization's own is
      // dropped even when empty — an existing collection is itself a leftover.
      if (name !== ownCollection) continue;
      const count = await db().collection(name).countDocuments({});
      steps.push({
        key: `collection:${name}`,
        kind: 'collection',
        label: 'Public registrations (this app’s own collection)',
        planned: count,
        removed: 0,
        done: false,
      });
      continue;
    }
    const count = await db().collection(name).countDocuments(ownedBy(orgId));
    if (count > 0) {
      steps.push({ key: `documents:${name}`, kind: 'documents', label: FRIENDLY[name] ?? name, planned: count, removed: 0, done: false });
    }
  }
  return steps;
}

/** Storage prefixes this organization owns: its own, and its onboarding applications'. */
async function storagePrefixes(orgId: string): Promise<string[]> {
  const registrations = await db()
    .collection('organizationregistrations')
    .find(ownedBy(orgId), { projection: { _id: 1 } })
    .toArray();
  return [`organizations/${orgId}/`, ...registrations.map((r) => `applications/${String(r._id)}/`)];
}

async function storageSteps(prefixes: string[]): Promise<DeletionStep[]> {
  const steps: DeletionStep[] = [];
  for (const prefix of [...new Set(prefixes)]) {
    const count = await countStoragePrefix(prefix);
    if (count > 0) {
      steps.push({
        key: `storage:${prefix}`,
        kind: 'storage',
        label: prefix.startsWith('organizations/') ? 'Files and media' : 'Onboarding uploads',
        planned: count,
        removed: 0,
        done: false,
      });
    }
  }
  return steps;
}

/**
 * The Expo project, if the organization has one.
 *
 * The name it is EXPECTED to have is derived from the organization's slug —
 * the per-organization naming this platform provisions — and not from the
 * slug recorded at provisioning, which for early organizations can be the
 * generic app's. Deleting by the recorded name could take out a project other
 * apps build from.
 */
function externalSteps(org: { slug: string; mobile?: { easProjectId?: string; easOwner?: string } }): DeletionStep[] {
  const id = String(org.mobile?.easProjectId ?? '').trim();
  if (!id) return [];
  const owner = String(org.mobile?.easOwner || process.env.EXPO_ACCOUNT || '').trim();
  return [
    {
      key: `external:expo:${id}`,
      kind: 'external',
      label: 'Expo (EAS) project',
      planned: 1,
      removed: 0,
      done: false,
      resource: { provider: 'expo', id, fullName: owner ? `@${owner}/${org.slug}` : '' },
    },
  ];
}

export async function buildDeletionPlan(orgId: string): Promise<DeletionPlan> {
  const org = await loadOrg(orgId);
  if (!org) throw new DeletionRefused(404, 'Organization not found.');

  const blockers: string[] = [];
  if (org.isPlatformOwned) blockers.push('This organization is owned by the platform and cannot be deleted.');
  const pinned = pinnedOrgId();
  if (pinned && (pinned === orgId || pinned === org.slug)) {
    blockers.push('This server is pinned to this organization (ORG_ID). It cannot delete the organization it serves.');
  }
  if (!DELETABLE_STATUSES.includes(String(org.status))) {
    blockers.push(
      `Suspend the organization first. It is currently ${org.status}, and deleting a live organization would cut its users off mid-session.`,
    );
  }
  const liveBuilds = await withoutTenantScope('org-delete:live-builds', async () =>
    AppBuildJob.countDocuments({ orgId: new mongoose.Types.ObjectId(orgId), status: { $in: LIVE_BUILD_STATUSES } }),
  );
  if (liveBuilds > 0) blockers.push('An app build is still running. Cancel it or wait for it to finish.');
  if (org.deletion?.status === 'running' && !isStalled(org.deletion)) {
    blockers.push('A deletion is already running for this organization.');
  }
  if (org.deletion?.status === 'incomplete') {
    blockers.push('This organization’s data is already deleted. Only an external resource remains — retry or finish it below.');
  }

  const documents = await documentSteps(orgId, ownCollectionOf(org));
  let storage: DeletionStep[] = [];
  try {
    storage = await storageSteps(await storagePrefixes(orgId));
  } catch (err) {
    blockers.push(
      `File storage could not be reached, so its files could not be counted (${(err as Error).message}). Nothing is deleted until it can be.`,
    );
  }
  const external = externalSteps(org);

  const notes = [
    'Only records tagged with this organization are deleted. Records created before organizations were tagged cannot be attributed and are left in place.',
    'Attendance kept in Firestore by the original attendance service is not tagged by organization and is not touched.',
    'The platform audit log keeps its record of this organization, including this deletion.',
  ];
  if (external.length) {
    notes.push(
      isEasConfigured()
        ? 'The Expo project is deleted through Expo, which may insist the owner confirms with a password. If it does, the deletion ends incomplete and tells you exactly what to remove.'
        : 'This server has no Expo token, so the Expo project cannot be deleted from here; the deletion will end incomplete until it is removed in the Expo dashboard.',
    );
  }

  return {
    orgId,
    slug: org.slug,
    name: org.name,
    status: org.status,
    blockers,
    // Files first: their prefixes are read from the application records, which
    // the document steps delete.
    steps: [...storage, ...documents, ...external],
    totals: {
      documents: documents.filter((d) => d.kind === 'documents').reduce((n, d) => n + d.planned, 0),
      collections: documents.filter((d) => d.kind === 'collection').length,
      storageObjects: storage.reduce((n, s) => n + s.planned, 0),
      external: external.length,
    },
    notes,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   Confirmation
   ══════════════════════════════════════════════════════════════════════════ */

function tokenKey(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return `org-delete.${secret}`;
}

function sign(orgId: string, staffId: string, exp: number): string {
  return crypto.createHmac('sha256', tokenKey()).update(`${orgId}.${staffId}.${exp}`).digest('hex');
}

/** A short-lived token binding a preview to this organization and this staff member. */
export function issuePlanToken(orgId: string, staffId: string, now = Date.now()): string {
  const exp = now + PLAN_TOKEN_TTL_MS;
  return `${exp}.${sign(orgId, staffId, exp)}`;
}

export function planTokenValid(token: unknown, orgId: string, staffId: string, now = Date.now()): boolean {
  if (typeof token !== 'string') return false;
  const [expText, sig] = token.split('.');
  const exp = Number(expText);
  if (!Number.isFinite(exp) || exp < now || !sig) return false;
  const expected = sign(orgId, staffId, exp);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

interface Confirmation {
  confirmSlug?: unknown;
  acknowledge?: unknown;
}

function confirmationProblems(slug: string, c: Confirmation): string[] {
  const problems: string[] = [];
  if (typeof c.confirmSlug !== 'string' || c.confirmSlug !== slug) {
    problems.push('The organization slug you typed does not match.');
  }
  if (c.acknowledge !== true) problems.push('Confirm that you understand this cannot be undone.');
  return problems;
}

/* ══════════════════════════════════════════════════════════════════════════
   Start, resume, finish, status
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Validate, record the plan on the organization, and hand it to the runner.
 *
 * The confirmation is checked HERE, against the server's copy of the slug:
 * the typed slug must match exactly, the operator must have acknowledged, and
 * the preview token must be this operator's, for this organization, and fresh.
 * The plan that runs is rebuilt now rather than taken from the request — a
 * client never supplies what gets deleted.
 */
export async function startDeletion(
  orgId: string,
  staff: Staff,
  confirmation: Confirmation & { planToken?: unknown },
): Promise<DeletionPlan> {
  const plan = await buildDeletionPlan(orgId);
  if (plan.blockers.length) throw new DeletionRefused(409, 'This organization cannot be deleted yet.', plan.blockers);

  const problems = confirmationProblems(plan.slug, confirmation);
  if (!planTokenValid(confirmation.planToken, orgId, staff.id)) {
    problems.push('Preview the deletion again — the preview has expired or belongs to someone else.');
  }
  if (problems.length) throw new DeletionRefused(400, 'The confirmation is not valid.', problems);

  const now = new Date();
  const claimed = await withoutTenantScope('org-delete:claim', async () =>
    Org.updateOne(
      {
        _id: orgId,
        $or: [
          { deletion: { $exists: false } },
          { deletion: null },
          { 'deletion.status': 'failed' },
          { 'deletion.status': 'running', 'deletion.heartbeatAt': { $lt: new Date(Date.now() - STALL_MS) } },
        ],
      },
      {
        $set: {
          deletion: {
            status: 'running',
            requestedBy: staff.id,
            requestedByEmail: staff.email,
            startedAt: now,
            heartbeatAt: now,
            attempts: 1,
            steps: plan.steps,
          },
        },
      },
    ),
  );
  if (!claimed.modifiedCount) throw new DeletionRefused(409, 'A deletion is already running for this organization.');
  // Its users are refused from this moment — not after the cache expires.
  clearOrgStateCache(orgId);

  await auditEvent('org.delete.started', orgId, staff, {
    slug: plan.slug,
    totals: plan.totals,
    steps: plan.steps.map((s) => ({ key: s.key, planned: s.planned })),
  });
  kick(orgId);
  return plan;
}

/**
 * Pick a deletion up where it stopped: a failed one, a stalled one (the
 * process died), or an incomplete one (retry the external resource — for
 * instance after deleting it in the Expo dashboard, which the retry confirms).
 */
export async function resumeDeletion(orgId: string, staff: Staff): Promise<void> {
  const org = await loadOrg(orgId);
  if (!org?.deletion) throw new DeletionRefused(404, 'There is no deletion to resume for this organization.');
  const status = org.deletion.status;
  if (status !== 'failed' && status !== 'incomplete' && !isStalled(org.deletion)) {
    throw new DeletionRefused(409, 'This deletion is still running.');
  }
  const updated = await withoutTenantScope('org-delete:resume', async () =>
    Org.updateOne(
      { _id: orgId, 'deletion.status': status, 'deletion.heartbeatAt': org.deletion?.heartbeatAt },
      {
        $set: { 'deletion.status': 'running', 'deletion.heartbeatAt': new Date() },
        $inc: { 'deletion.attempts': 1 },
        $unset: { 'deletion.error': '', 'deletion.failedStep': '' },
      },
    ),
  );
  if (!updated.modifiedCount) throw new DeletionRefused(409, 'The deletion changed while you were looking. Refresh and try again.');
  await auditEvent('org.delete.resumed', orgId, staff, { from: status });
  kick(orgId);
}

/**
 * Finish an INCOMPLETE deletion without the external resource still standing.
 *
 * An explicit operator decision — typed slug, acknowledgement — recorded as
 * such. The resource is marked `retained`, not deleted, and the completion
 * record says it still exists.
 */
export async function finishWithoutExternal(orgId: string, staff: Staff, confirmation: Confirmation): Promise<void> {
  const org = await loadOrg(orgId);
  if (!org?.deletion || org.deletion.status !== 'incomplete') {
    throw new DeletionRefused(409, 'Only a deletion that is waiting on an external resource can be finished this way.');
  }
  const problems = confirmationProblems(org.slug, confirmation);
  if (problems.length) throw new DeletionRefused(400, 'The confirmation is not valid.', problems);

  const decided = new Date();
  const steps = (org.deletion.steps ?? []).map((s) =>
    s.kind === 'external' && s.outcome === 'orphaned'
      ? {
          ...s,
          outcome: 'retained' as const,
          done: true,
          reason: `${s.reason ?? ''} Left in place by ${staff.email || staff.id} on ${decided.toISOString()}.`.trim(),
        }
      : s,
  );
  const updated = await withoutTenantScope('org-delete:finish', async () =>
    Org.updateOne(
      { _id: orgId, 'deletion.status': 'incomplete' },
      { $set: { 'deletion.status': 'running', 'deletion.heartbeatAt': decided, 'deletion.steps': steps } },
    ),
  );
  if (!updated.modifiedCount) throw new DeletionRefused(409, 'The deletion changed while you were looking. Refresh and try again.');
  await auditEvent('org.delete.external-retained', orgId, staff, {
    external: steps.filter((s) => s.outcome === 'retained').map((s) => s.resource),
  });
  kick(orgId);
}

export async function deletionStatus(orgId: string) {
  if (!mongoose.isValidObjectId(orgId)) return { state: 'not-found' as const };
  const org = await loadOrg(orgId);
  if (org) {
    if (!org.deletion) return { state: 'none' as const };
    return { state: isStalled(org.deletion) ? ('stalled' as const) : org.deletion.status, deletion: org.deletion };
  }
  const done = await withoutTenantScope('org-delete:completed', async () =>
    PlatformAudit.findOne({ orgId, action: 'org.delete.completed' }).sort({ createdAt: -1 }).lean(),
  );
  if (done) return { state: 'completed' as const, summary: done.metadata };
  return { state: 'not-found' as const };
}

/* ══════════════════════════════════════════════════════════════════════════
   The runner
   ══════════════════════════════════════════════════════════════════════════ */

const running = new Set<string>();
/** Settles when the current run for an organization ends. Tests await it. */
const inFlight = new Map<string, Promise<void>>();

function kick(orgId: string): void {
  const run = new Promise<void>((resolve) => {
    setImmediate(() => {
      runDeletion(orgId)
        .catch((err) => console.error(`[org-delete] ${orgId} runner crashed:`, (err as Error).message))
        .finally(resolve);
    });
  });
  inFlight.set(orgId, run);
}

/** Wait for the background run of this organization, if any. */
export async function settled(orgId: string): Promise<void> {
  await inFlight.get(orgId);
}

async function auditEvent(
  action: string,
  orgId: string,
  staff: Staff | null,
  metadata: Record<string, unknown>,
  { required = false } = {},
): Promise<void> {
  const write = withoutTenantScope('org-delete:audit', async () =>
    PlatformAudit.create({
      actorId: staff?.id && mongoose.isValidObjectId(staff.id) ? staff.id : undefined,
      actorEmail: staff?.email,
      actorRole: staff?.role,
      ip: staff?.ip,
      action,
      orgId,
      entity: 'Org',
      entityId: orgId,
      metadata,
    }),
  );
  if (required) {
    await write;
    return;
  }
  await write.catch((err) => console.error(`[org-delete] audit ${action} failed:`, (err as Error).message));
}

/** A failure message safe to store and show: no stack, no secrets, bounded. */
function safeMessage(err: unknown): string {
  const text = String((err as Error)?.message || 'Unknown error').split('\n')[0];
  return text.slice(0, 300);
}

async function runDataStep(orgId: string, ownCollection: string | null, step: DeletionStep, save: (removed: number) => Promise<unknown>) {
  const target = step.key.slice(step.key.indexOf(':') + 1);

  if (step.kind === 'documents') {
    // The name came from the server's own scan; re-checked anyway.
    if (RETAINED.has(target) || target === REGISTRY || target.startsWith('system.') || target.startsWith('reg_')) {
      throw new Error(`Refusing to delete from "${target}".`);
    }
    const collection = db().collection(target);
    for (;;) {
      const batch = await collection.find(ownedBy(orgId), { projection: { _id: 1 } }).limit(BATCH).toArray();
      if (!batch.length) break;
      const result = await collection.deleteMany({ _id: { $in: batch.map((d) => d._id) }, ...ownedBy(orgId) });
      step.removed += result.deletedCount ?? 0;
      await save(step.removed);
    }
    return;
  }

  if (step.kind === 'collection') {
    if (!isValidRegistrationCollection(target) || target !== ownCollection) {
      throw new Error(`Refusing to drop "${target}": it is not this organization's registration collection.`);
    }
    const exists = (await db().listCollections({ name: target }, { nameOnly: true }).toArray()).length > 0;
    if (exists) {
      const count = await db().collection(target).countDocuments({});
      await db().dropCollection(target);
      step.removed += count;
    }
    return;
  }

  if (step.kind === 'storage') {
    step.removed += await deleteStoragePrefix(target);
  }
}

/**
 * Ask Expo to delete the organization's project — if it is provably this
 * organization's alone. Returns the outcome; never throws.
 */
async function removeExternal(orgId: string, step: DeletionStep): Promise<Pick<DeletionStep, 'outcome' | 'reason' | 'done' | 'removed'>> {
  const resource = step.resource;
  if (!resource?.id) return { outcome: 'orphaned', reason: 'The project id was not recorded.', done: false, removed: 0 };

  const sharedWith = await withoutTenantScope('org-delete:eas-shared', async () =>
    Org.countDocuments({ _id: { $ne: new mongoose.Types.ObjectId(orgId) }, 'mobile.easProjectId': resource.id }),
  );
  if (sharedWith > 0) {
    return {
      outcome: 'shared',
      reason: 'Another organization uses the same Expo project, so it is not this organization’s to delete. Only this organization’s reference to it was removed.',
      done: true,
      removed: 0,
    };
  }
  if (!resource.fullName) {
    return { outcome: 'orphaned', reason: 'The Expo account that owns this project is not recorded, so the platform cannot confirm which project to delete.', done: false, removed: 0 };
  }
  if (!isEasConfigured()) {
    return { outcome: 'orphaned', reason: 'This server has no Expo token, so it cannot delete the project.', done: false, removed: 0 };
  }

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eas-delete-'));
  try {
    const result = await deleteEasProject({ id: resource.id, fullName: resource.fullName, cwd });
    if (result.deleted) {
      return {
        outcome: 'deleted',
        reason: result.alreadyGone ? 'Expo reports the project no longer exists.' : 'Deleted through Expo.',
        done: true,
        removed: 1,
      };
    }
    return { outcome: 'orphaned', reason: 'reason' in result ? result.reason : 'Expo did not delete the project.', done: false, removed: 0 };
  } catch (err) {
    return { outcome: 'orphaned', reason: `Expo could not be asked to delete it: ${safeMessage(err)}`, done: false, removed: 0 };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/** Anything this organization still owns, as steps — the verification scan. */
async function leftovers(orgId: string, ownCollection: string | null, steps: DeletionStep[]): Promise<DeletionStep[]> {
  const found = await documentSteps(orgId, ownCollection);
  const recordedPrefixes = steps.filter((s) => s.kind === 'storage').map((s) => s.key.slice('storage:'.length));
  found.push(...(await storageSteps([...recordedPrefixes, ...(await storagePrefixes(orgId))])));
  return found;
}

function summaryOf(org: { slug: string; name: string }, deletion: { startedAt: Date; attempts: number }, steps: DeletionStep[]) {
  return {
    slug: org.slug,
    name: org.name,
    startedAt: deletion.startedAt,
    finishedAt: new Date(),
    attempts: deletion.attempts,
    steps: steps
      .filter((s) => s.kind !== 'external')
      .map((s) => ({ key: s.key, label: s.label, kind: s.kind, removed: s.removed })),
    external: steps
      .filter((s) => s.kind === 'external')
      .map((s) => ({ ...s.resource, outcome: s.outcome, reason: s.reason })),
  };
}

/**
 * Work through the recorded steps. Safe to call twice: a second call for an
 * organization this process is already running returns immediately, and every
 * step is idempotent across processes.
 */
export async function runDeletion(orgId: string): Promise<void> {
  if (running.has(orgId)) return;
  running.add(orgId);
  try {
    const org = await loadOrg(orgId);
    if (!org?.deletion || org.deletion.status !== 'running') return;
    const deletion = org.deletion;
    const staff: Staff = { id: deletion.requestedBy, email: deletion.requestedByEmail };
    const steps: DeletionStep[] = deletion.steps ?? [];
    const ownCollection = ownCollectionOf(org);

    const heartbeat = (patch: Record<string, unknown>) =>
      withoutTenantScope('org-delete:progress', async () =>
        Org.updateOne({ _id: orgId }, { $set: { ...patch, 'deletion.heartbeatAt': new Date() } }),
      );
    const fail = async (stepKey: string, message: string, extra: Record<string, unknown> = {}) => {
      await heartbeat({ 'deletion.status': 'failed', 'deletion.error': message, 'deletion.failedStep': stepKey, 'deletion.steps': steps });
      await auditEvent('org.delete.failed', orgId, staff, { step: stepKey, error: message, ...extra });
    };

    // ── Data: delete, rescan, repeat until a scan finds nothing ───────────────
    for (let pass = 1; ; pass++) {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (step.done || step.kind === 'external') continue;
        try {
          if (__deletionTestHooks.failAtStep === step.key) {
            __deletionTestHooks.failAtStep = null;
            throw new Error('Injected failure (test).');
          }
          await runDataStep(orgId, ownCollection, step, (removed) => heartbeat({ [`deletion.steps.${i}.removed`]: removed }));
          step.done = true;
          await heartbeat({ [`deletion.steps.${i}`]: step });
        } catch (err) {
          await fail(step.key, safeMessage(err));
          return;
        }
      }

      let remaining: DeletionStep[];
      try {
        remaining = await leftovers(orgId, ownCollection, steps);
      } catch (err) {
        await fail('verify', `The result could not be verified: ${safeMessage(err)}`);
        return;
      }
      if (!remaining.length) break;
      if (pass >= MAX_PASSES) {
        const detail = remaining.map((r) => `${r.key.slice(r.key.indexOf(':') + 1)}: ${r.planned}`).join(', ');
        await fail('verify', `Verification found data remaining — ${detail}`, { remaining: detail });
        return;
      }
      for (const extra of remaining) {
        const existing = steps.find((s) => s.key === extra.key);
        if (existing) {
          existing.done = false;
          existing.planned = existing.removed + extra.planned;
        } else {
          steps.push(extra);
        }
      }
      await heartbeat({ 'deletion.steps': steps });
    }

    // ── External resources ────────────────────────────────────────────────────
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.kind !== 'external' || step.done) continue;
      Object.assign(step, await removeExternal(orgId, step));
      await heartbeat({ [`deletion.steps.${i}`]: step });
    }

    const summary = summaryOf(org, deletion, steps);
    const orphaned = steps.filter((s) => s.kind === 'external' && s.outcome === 'orphaned');
    if (orphaned.length) {
      // Every row and file is gone. What stays is a stripped record that says
      // which external resource still exists — never a claim that it does not.
      await withoutTenantScope('org-delete:incomplete', async () =>
        Org.updateOne(
          { _id: orgId },
          {
            $set: { 'deletion.status': 'incomplete', 'deletion.heartbeatAt': new Date(), 'deletion.steps': steps },
            $unset: { mobile: '', appExperience: '', registrationStore: '', domains: '' },
          },
        ),
      );
      clearHostResolutionCache();
      clearOrgStateCache(orgId);
      await auditEvent('org.delete.incomplete', orgId, staff, summary);
      return;
    }

    // ── Complete: the record moves to the audit log, then the organization goes
    const retained = steps.filter((s) => s.kind === 'external' && s.outcome !== 'deleted');
    try {
      await auditEvent(
        'org.delete.completed',
        orgId,
        staff,
        { ...summary, result: retained.length ? 'completed-with-external-retained' : 'completed' },
        { required: true },
      );
      await withoutTenantScope('org-delete:final', async () => Org.deleteOne({ _id: orgId }));
    } catch (err) {
      await fail('finalize', `The deletion could not be recorded as complete: ${safeMessage(err)}`);
      return;
    }
    clearHostResolutionCache();
      clearOrgStateCache(orgId);
  } finally {
    running.delete(orgId);
  }
}

/**
 * Deletions a process was running when it stopped. Called once at start-up;
 * each is stalled by then, and resumes on its own rather than waiting for an
 * operator to notice.
 */
export async function resumeStalledDeletions(): Promise<number> {
  const stalled = await withoutTenantScope('org-delete:boot', async () =>
    Org.find(
      { 'deletion.status': 'running', 'deletion.heartbeatAt': { $lt: new Date(Date.now() - STALL_MS) } },
      { _id: 1 },
    ).lean(),
  );
  let resumed = 0;
  for (const org of stalled) {
    // Claim it first: another process booting at the same moment must not run it too.
    const claimed = await withoutTenantScope('org-delete:boot-claim', async () =>
      Org.updateOne(
        { _id: org._id, 'deletion.status': 'running', 'deletion.heartbeatAt': { $lt: new Date(Date.now() - STALL_MS) } },
        { $set: { 'deletion.heartbeatAt': new Date() } },
      ),
    );
    if (claimed.modifiedCount) {
      kick(String(org._id));
      resumed++;
    }
  }
  return resumed;
}
