/**
 * Subjects available to a teacher's picker, per organization.
 *
 * ── Read path reuses the existing registry, write path is new ──────────────
 * `Subject` (models/Subject.ts) and `getOrgConfiguration()` (core/config/orgConfig)
 * already existed — a per-org `Subject` collection with a legacy-list fallback
 * for any org that has never configured its own. What was missing was any way
 * to ADD to that collection outside the platform console's all-or-nothing
 * `setOrganizationConfig` (which deletes and replaces the whole list). This
 * file is that additive path: list what a teacher can pick from, and let one
 * be created without touching the admin bulk-replace flow at all.
 *
 * ── Why not just call getOrgConfiguration() here ────────────────────────────
 * That helper returns bare names (`string[]`) with no id, which is enough for
 * a read-only picker but not for a create flow that needs to hand back "here is
 * the row you just made". It also, deliberately, never seeds the database — an
 * org with zero rows keeps reading the constant forever. The moment a teacher
 * adds ONE custom subject that can no longer be true: `Subject.find()` would
 * return only that one row and the other fourteen legacy subjects would vanish
 * from every picker in the org. `ensureSeeded()` below exists to make "add a
 * subject" additive from the teacher's point of view even though the
 * underlying storage flips from constant-backed to database-backed.
 *
 * ── The pre-tenancy bucket ───────────────────────────────────────────────────
 * Production runs today with no TENANT_MODE / ORG_ID configured at all — see
 * core/tenancy/config.ts. `currentOrgId()` is null for every request. Subjects
 * created in that state have no `orgId` field at all (never set to null;
 * genuinely absent, matching every other document written before tenancy
 * existed — same convention `batchConfigService.orgScope()` uses for `Batch`).
 * They form one shared bucket, which is correct: today there is exactly one
 * institute using this deployment. When `api-legacy` is later pinned to a real
 * ORG_ID, those rows become a backfill candidate like every other
 * pre-tenancy collection — not a new problem this feature introduces.
 */

import Subject from '../models/Subject';
import { currentOrgId } from '../core/tenancy/context';
import { CURRICULUM_SUBJECTS } from '../config/subjects';

export class SubjectValidationError extends Error {}

export class SubjectConflictError extends Error {
  constructor(public readonly existingName: string) {
    super(`A subject named "${existingName}" already exists.`);
    this.name = 'SubjectConflictError';
  }
}

export interface SubjectDTO {
  id: string;
  name: string;
}

const MAX_NAME_LENGTH = 60;

/** Collapse internal whitespace runs and trim ends. Does not touch casing. */
function normalizeName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

/** Same convention as `batchConfigService.orgScope()`: scope when there is a
 *  tenant, and match the single pre-tenancy bucket (no `orgId` field on any
 *  document) when there is not. */
function orgScope(): Record<string, unknown> {
  const orgId = currentOrgId();
  return orgId ? { orgId } : {};
}

export async function listSubjects(): Promise<{ subjects: SubjectDTO[]; usingDefaults: boolean }> {
  const rows = await Subject.find({ ...orgScope(), isActive: true })
    .sort({ order: 1, name: 1 })
    .lean();

  if (!rows.length) {
    return {
      subjects: CURRICULUM_SUBJECTS.map((name) => ({ id: `legacy:${name}`, name })),
      usingDefaults: true,
    };
  }

  return {
    subjects: rows.map((row) => ({ id: String(row._id), name: row.name })),
    usingDefaults: false,
  };
}

/**
 * If this org (or the pre-tenancy bucket) has never stored a subject, seed it
 * with today's constant list first — so the org's very first custom subject
 * doesn't silently delete the other fourteen from every picker.
 *
 * Idempotent and race-safe: `insertMany(..., { ordered: false })` lets
 * independent rows insert even when some collide with a concurrent seed
 * attempt (or with rows another request just inserted), and duplicate-key
 * failures on those specific rows are swallowed — the row existing at all is
 * the only thing this needed. Anything that is NOT a duplicate-key failure is
 * rethrown; a seed that failed for a real reason must not look like success.
 */
async function ensureSeeded(): Promise<void> {
  const scope = orgScope();
  const alreadySeeded = await Subject.exists(scope);
  if (alreadySeeded) return;

  const orgId = currentOrgId();
  const docs = CURRICULUM_SUBJECTS.map((name, index) => ({
    ...(orgId ? { orgId } : {}),
    name,
    order: index,
    isActive: true,
  }));

  try {
    await Subject.insertMany(docs, { ordered: false });
  } catch (error) {
    const writeErrors: Array<{ code?: number; err?: { code?: number } }> =
      (error as { writeErrors?: unknown[] })?.writeErrors as never[] | undefined ??
      (error as { errors?: unknown[] })?.errors as never[] | undefined ??
      [];
    const topLevelCode = (error as { code?: number })?.code;
    const allDuplicates =
      writeErrors.length > 0
        ? writeErrors.every((e) => (e.code ?? e.err?.code) === 11000)
        : topLevelCode === 11000;

    if (!allDuplicates) throw error;
  }
}

/**
 * Create a subject for the current organization (or the shared pre-tenancy
 * bucket). Validates, seeds the legacy list on first use, and rejects a
 * case-insensitive duplicate — including one lost to a concurrent request,
 * via the `{ orgId, nameLower }` unique index on the model, which is the part
 * an app-level `findOne` check alone cannot guarantee under a race.
 */
export async function createSubject(
  rawName: unknown,
): Promise<{ subject: SubjectDTO; subjects: SubjectDTO[] }> {
  const name = normalizeName(rawName);

  if (!name) {
    throw new SubjectValidationError('Subject name cannot be empty.');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new SubjectValidationError(`Subject name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }

  await ensureSeeded();

  const scope = orgScope();
  const nameLower = name.toLowerCase();

  const existing = await Subject.findOne({ ...scope, nameLower }).lean();
  if (existing) {
    throw new SubjectConflictError(existing.name);
  }

  const orgId = currentOrgId();
  const last = await Subject.findOne(scope).sort({ order: -1 }).select('order').lean();
  const nextOrder = (last?.order ?? -1) + 1;

  let created;
  try {
    created = await Subject.create({
      ...(orgId ? { orgId } : {}),
      name,
      order: nextOrder,
      isActive: true,
    });
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) {
      // Lost a race to a concurrent create for the same name between our check
      // and our insert. The winner's row is what the caller should see.
      const clash = await Subject.findOne({ ...scope, nameLower }).lean();
      throw new SubjectConflictError(clash?.name ?? name);
    }
    throw error;
  }

  const { subjects } = await listSubjects();
  return { subject: { id: String(created._id), name: created.name }, subjects };
}
