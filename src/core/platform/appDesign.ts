/**
 * App design requests — an organization choosing a design template for its
 * mobile app, and the platform approving it and building it in.
 *
 * ── Who does what ───────────────────────────────────────────────────────────
 *   institute administrator   save a draft, submit it, withdraw a submission
 *                             (web: App Management → Design Studio)
 *   platform staff            request changes, approve, reject, activate
 *                             (console: App designs)
 *
 * The moves themselves — which actor may take which action from which stage —
 * are the shared lifecycle (./design/lifecycle.ts, mirrored from
 * platform-client-core). This module applies them to stored records; it adds
 * no rule of its own beyond "one open request per organization".
 *
 * ── Selecting is not activating ─────────────────────────────────────────────
 * Nothing an institute does here changes its app. Activation — a platform
 * action, after approval — writes the design onto the organization
 * (`Org.appDesign.active`), and from then on `generateBuildConfig` compiles it
 * into every build. Students see it once a build carrying it is installed.
 *
 * ── Validated on the way in, re-validated on the way out ────────────────────
 * A selection is reduced to a template reference plus the four declared
 * overrides by the shared `selectionFor`/`normalizeDesignSelection`, and the
 * template version is ALWAYS the one this server ships, never the client's.
 */

import mongoose from 'mongoose';
import AppDesignRequest, {
  OPEN_DESIGN_STAGES,
  type IAppDesignRequest,
  type IDesignHistoryEntry,
} from '../../models/AppDesignRequest';
import { withoutTenantScope } from '../tenancy/context';
import {
  availableActions,
  CATEGORIES,
  normalizeDesignSelection,
  selectionFor,
  STAGE_COPY,
  templateById,
  TEMPLATES,
  transition,
  type DesignAction,
  type DesignActor,
  type DesignRecord,
  type DesignSelection,
  type DesignStage,
  type DesignTemplate,
} from './design';

export class DesignRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DesignRequestError';
  }
}

export interface DesignActorRef {
  /** A User id (institute) or PlatformUser id (staff). */
  id?: string;
}

/* ══════════════════════════════════════════════════════════════════════════
   Lookups
   ══════════════════════════════════════════════════════════════════════════ */

function orgModel() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../models/Org').default;
}

async function loadOrg(orgId: string): Promise<Record<string, any> | null> {
  if (!mongoose.Types.ObjectId.isValid(orgId)) return null;
  return withoutTenantScope('app-design:load-org', async () =>
    orgModel().findById(orgId).select('name slug status appDesign branding').lean(),
  );
}

/** An email for the history table; the record outlives the account. */
async function emailOf(actor: DesignActor, ref: DesignActorRef): Promise<string | undefined> {
  if (!ref.id || !mongoose.Types.ObjectId.isValid(ref.id)) return undefined;
  try {
    return await withoutTenantScope('app-design:actor-email', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Model = actor === 'platform-admin' ? require('../../models/PlatformUser').default : require('../../models/User').default;
      const doc = (await Model.findById(ref.id).select('email').lean()) as { email?: string } | null;
      return doc?.email || undefined;
    });
  } catch {
    return undefined;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Views
   ══════════════════════════════════════════════════════════════════════════ */

export interface TemplateSummary {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  description: string;
  version: string;
  appearance: string;
}

export function templateSummary(template: DesignTemplate | null): TemplateSummary | null {
  if (!template) return null;
  return {
    id: template.meta.id,
    name: template.meta.name,
    category: template.meta.category,
    categoryLabel: CATEGORIES.find((c) => c.id === template.meta.category)?.label ?? template.meta.category,
    description: template.meta.description,
    version: template.meta.version,
    appearance: template.appearance.strategy,
  };
}

export interface DesignRequestView {
  id: string;
  orgId: string;
  organizationName: string;
  organizationSlug: string;
  stage: DesignStage;
  stageLabel: string;
  stageDetail: string;
  revision: number;
  selection: DesignSelection;
  template: TemplateSummary | null;
  /** How the stored template version relates to the one this server ships. */
  compatibility: string;
  history: (Omit<IDesignHistoryEntry, 'at'> & { at: string })[];
  submittedAt: string | null;
  submittedByEmail: string | null;
  decidedAt: string | null;
  decidedByEmail: string | null;
  decisionNote: string | null;
  activatedAt: string | null;
  activatedByEmail: string | null;
  supersededAt: string | null;
  builds: { buildId: string; buildNumber: number; artifactType: string; startedAt: string }[];
  actions: { orgAdmin: DesignAction[]; platform: DesignAction[] };
  createdAt: string;
  updatedAt: string;
}

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);

function recordOf(doc: IAppDesignRequest): DesignRecord {
  return {
    stage: doc.stage,
    revision: doc.revision,
    selection: doc.selection as DesignSelection,
    history: (doc.history ?? []).map((h) => ({
      action: h.action,
      from: h.from,
      to: h.to,
      actor: h.actor,
      at: new Date(h.at).toISOString(),
      note: h.note,
    })),
  };
}

export function requestView(doc: IAppDesignRequest): DesignRequestView {
  const normalized = normalizeDesignSelection(doc.selection, TEMPLATES);
  const selection = normalized?.selection ?? (doc.selection as DesignSelection);
  const record = recordOf(doc);
  return {
    id: String(doc._id),
    orgId: String(doc.orgId),
    organizationName: doc.organizationName,
    organizationSlug: doc.organizationSlug,
    stage: doc.stage,
    stageLabel: STAGE_COPY[doc.stage].label,
    stageDetail: STAGE_COPY[doc.stage].detail,
    revision: doc.revision,
    selection,
    template: templateSummary(templateById(selection.templateId)),
    compatibility: normalized?.compatibility ?? 'unknown-template',
    history: (doc.history ?? []).map((h) => ({
      action: h.action,
      from: h.from,
      to: h.to,
      actor: h.actor,
      actorEmail: h.actorEmail,
      note: h.note,
      templateId: h.templateId,
      at: new Date(h.at).toISOString(),
    })),
    submittedAt: iso(doc.submittedAt),
    submittedByEmail: doc.submittedByEmail ?? null,
    decidedAt: iso(doc.decidedAt),
    decidedByEmail: doc.decidedByEmail ?? null,
    decisionNote: doc.decisionNote ?? null,
    activatedAt: iso(doc.activatedAt),
    activatedByEmail: doc.activatedByEmail ?? null,
    supersededAt: iso(doc.supersededAt),
    builds: (doc.builds ?? []).map((b) => ({
      buildId: String(b.buildId),
      buildNumber: b.buildNumber,
      artifactType: b.artifactType,
      startedAt: new Date(b.startedAt).toISOString(),
    })),
    actions: {
      orgAdmin: availableActions(record, 'org-admin'),
      platform: availableActions(record, 'platform-admin'),
    },
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   Applying a transition
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Run one lifecycle action against a stored request and save it.
 *
 * The shared `transition()` decides whether the move is allowed; this only
 * persists the answer and enriches the history line with who took it. Saved
 * with an optimistic guard on the stage it was read in, so two staff
 * approving and rejecting the same request at once cannot both succeed.
 */
async function apply(
  doc: IAppDesignRequest,
  action: DesignAction,
  actor: DesignActor,
  ref: DesignActorRef,
  change: { selection?: DesignSelection; note?: string } = {},
  extra: Partial<Record<keyof IAppDesignRequest, unknown>> = {},
): Promise<IAppDesignRequest> {
  const at = new Date();
  const result = transition(recordOf(doc), action, actor, at.toISOString(), change);
  // Narrowed by hand: this project compiles without strictNullChecks, where a
  // boolean discriminant does not narrow the union.
  if (result.ok === false) throw new DesignRequestError((result as { reason: string }).reason, 409, 'DESIGN_TRANSITION_REFUSED');

  const actorEmail = await emailOf(actor, ref);
  const entry: IDesignHistoryEntry = {
    action,
    from: doc.stage,
    to: result.record.stage,
    actor,
    actorId: ref.id,
    actorEmail,
    at,
    note: change.note?.slice(0, 1000) || undefined,
    templateId: action === 'save' ? result.record.selection.templateId : undefined,
  };

  const update: Record<string, unknown> = {
    stage: result.record.stage,
    revision: result.record.revision,
    selection: result.record.selection,
    ...extra,
  };
  if (action === 'save' && change.selection) {
    update.templateName = templateById(change.selection.templateId)?.meta.name ?? change.selection.templateId;
  }
  if (action === 'submit') Object.assign(update, { submittedAt: at, submittedByEmail: actorEmail });
  if (action === 'approve' || action === 'reject' || action === 'request-changes') {
    Object.assign(update, { decidedAt: at, decidedByEmail: actorEmail, decisionNote: change.note?.slice(0, 1000) || undefined });
  }
  if (action === 'activate') Object.assign(update, { activatedAt: at, activatedByEmail: actorEmail });
  if (action === 'supersede') Object.assign(update, { supersededAt: at });

  const saved = await withoutTenantScope('app-design:transition', async () =>
    AppDesignRequest.findOneAndUpdate(
      { _id: doc._id, stage: doc.stage, revision: doc.revision },
      { $set: update, $push: { history: entry } },
      { new: true },
    ),
  );
  if (!saved) {
    throw new DesignRequestError('This request changed while you were looking at it. Reload and try again.', 409, 'DESIGN_REQUEST_STALE');
  }
  return saved;
}

/* ══════════════════════════════════════════════════════════════════════════
   The institute's side
   ══════════════════════════════════════════════════════════════════════════ */

async function openRequestOf(orgId: string): Promise<IAppDesignRequest | null> {
  return withoutTenantScope('app-design:open', async () =>
    AppDesignRequest.findOne({ orgId, stage: { $in: OPEN_DESIGN_STAGES } }),
  );
}

export interface ActiveDesignView {
  requestId: string;
  selection: DesignSelection;
  template: TemplateSummary | null;
  compatibility: string;
  activatedAt: string | null;
  activatedByEmail: string | null;
}

function activeViewOf(org: Record<string, any> | null): ActiveDesignView | null {
  const active = org?.appDesign?.active;
  if (!active?.selection) return null;
  const normalized = normalizeDesignSelection(active.selection, TEMPLATES);
  if (!normalized) return null;
  return {
    requestId: String(active.requestId ?? ''),
    selection: normalized.selection,
    template: templateSummary(templateById(normalized.selection.templateId)),
    compatibility: normalized.compatibility,
    activatedAt: iso(active.activatedAt),
    activatedByEmail: active.activatedByEmail ?? null,
  };
}

export interface OrgDesignState {
  /** The request being worked on, if any — at most one. */
  current: DesignRequestView | null;
  /** What this organization's builds compile in now. */
  active: ActiveDesignView | null;
  /** Closed requests, newest first. */
  history: DesignRequestView[];
  /** The catalogue version this server validates against. */
  templates: { id: string; version: string }[];
}

export async function orgDesignState(orgId: string): Promise<OrgDesignState> {
  const [org, current, closed] = await Promise.all([
    loadOrg(orgId),
    openRequestOf(orgId),
    withoutTenantScope('app-design:history', async () =>
      AppDesignRequest.find({ orgId, stage: { $nin: OPEN_DESIGN_STAGES } }).sort({ updatedAt: -1 }).limit(10),
    ),
  ]);
  if (!org) throw new DesignRequestError('Organization not found.', 404, 'ORG_NOT_FOUND');
  return {
    current: current ? requestView(current) : null,
    active: activeViewOf(org),
    history: closed.map(requestView),
    templates: TEMPLATES.map((t) => ({ id: t.meta.id, version: t.meta.version })),
  };
}

/**
 * The selection an institute sent, as the server will store it.
 *
 * Only `templateId` and `overrides` are read. The version is this server's,
 * the kind and schema are fixed, and anything else in the body — tokens,
 * styles, scripts — never reaches the record.
 */
export function selectionFromInput(input: unknown): DesignSelection {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const template = templateById(typeof body.templateId === 'string' ? body.templateId : '');
  if (!template) throw new DesignRequestError('Choose one of the available templates.', 400, 'DESIGN_TEMPLATE_UNKNOWN');
  return selectionFor(template, body.overrides);
}

export async function saveDesignDraft(orgId: string, ref: DesignActorRef, input: unknown): Promise<DesignRequestView> {
  const selection = selectionFromInput(input);
  const org = await loadOrg(orgId);
  if (!org) throw new DesignRequestError('Organization not found.', 404, 'ORG_NOT_FOUND');

  const open = await openRequestOf(orgId);
  if (open) {
    if (open.stage === 'submitted') {
      throw new DesignRequestError('This design is waiting for review. Withdraw it first to make changes.', 409, 'DESIGN_SUBMITTED');
    }
    if (open.stage === 'approved') {
      throw new DesignRequestError(
        'An approved design is waiting to be activated by the platform team. Ask them to activate it before choosing again.',
        409,
        'DESIGN_APPROVED_PENDING',
      );
    }
    return requestView(await apply(open, 'save', 'org-admin', ref, { selection }));
  }

  const at = new Date();
  const actorEmail = await emailOf('org-admin', ref);
  try {
    const created = await withoutTenantScope('app-design:create', async () =>
      AppDesignRequest.create({
        orgId: new mongoose.Types.ObjectId(orgId),
        organizationName: String(org.branding?.appName || org.name || ''),
        organizationSlug: String(org.slug ?? ''),
        stage: 'draft',
        revision: 1,
        selection,
        templateName: templateById(selection.templateId)?.meta.name ?? selection.templateId,
        history: [
          { action: 'save', from: 'draft', to: 'draft', actor: 'org-admin', actorId: ref.id, actorEmail, at, templateId: selection.templateId },
        ],
        builds: [],
      }),
    );
    return requestView(created);
  } catch (err) {
    // The partial unique index fired: another tab created the draft first.
    // Save into that one rather than failing a person who did nothing wrong.
    if ((err as { code?: number }).code === 11000) {
      const winner = await openRequestOf(orgId);
      if (winner && (winner.stage === 'draft' || winner.stage === 'changes-requested')) {
        return requestView(await apply(winner, 'save', 'org-admin', ref, { selection }));
      }
    }
    throw err;
  }
}

export async function submitDesign(orgId: string, ref: DesignActorRef, note?: string): Promise<DesignRequestView> {
  const open = await openRequestOf(orgId);
  if (!open) throw new DesignRequestError('Save a design before submitting it.', 409, 'DESIGN_NO_DRAFT');
  if (!templateById(open.selection.templateId)) {
    throw new DesignRequestError('That template is no longer available. Choose another before submitting.', 409, 'DESIGN_TEMPLATE_UNKNOWN');
  }
  return requestView(await apply(open, 'submit', 'org-admin', ref, { note: typeof note === 'string' ? note.trim() : undefined }));
}

export async function withdrawDesign(orgId: string, ref: DesignActorRef): Promise<DesignRequestView> {
  const open = await openRequestOf(orgId);
  if (!open) throw new DesignRequestError('There is no submitted design to withdraw.', 409, 'DESIGN_NO_REQUEST');
  return requestView(await apply(open, 'withdraw', 'org-admin', ref));
}

/* ══════════════════════════════════════════════════════════════════════════
   The platform's side
   ══════════════════════════════════════════════════════════════════════════ */

/** Drafts are an institute's work in progress; the review queue starts at submission. */
const REVIEWABLE: DesignStage[] = ['submitted', 'changes-requested', 'approved', 'rejected', 'active', 'superseded'];

export async function listDesignRequests(
  filter: { stage?: string; orgId?: string; limit?: number } = {},
): Promise<{ items: DesignRequestView[]; counts: Record<string, number> }> {
  const query: Record<string, unknown> = { stage: { $in: REVIEWABLE } };
  if (filter.stage && (REVIEWABLE as string[]).includes(filter.stage)) query.stage = filter.stage;
  if (filter.orgId && mongoose.Types.ObjectId.isValid(filter.orgId)) query.orgId = filter.orgId;
  const limit = Math.min(200, Math.max(1, Number(filter.limit) || 100));

  const [docs, grouped] = await Promise.all([
    withoutTenantScope('app-design:list', async () => AppDesignRequest.find(query).sort({ updatedAt: -1 }).limit(limit)),
    withoutTenantScope('app-design:counts', async () =>
      AppDesignRequest.aggregate([{ $match: { stage: { $in: REVIEWABLE } } }, { $group: { _id: '$stage', n: { $sum: 1 } } }]),
    ),
  ]);
  const counts: Record<string, number> = {};
  for (const row of grouped as { _id: string; n: number }[]) counts[row._id] = row.n;
  return { items: docs.map(requestView), counts };
}

async function loadRequest(id: string): Promise<IAppDesignRequest> {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new DesignRequestError('Design request not found.', 404, 'DESIGN_REQUEST_NOT_FOUND');
  const doc = await withoutTenantScope('app-design:load', async () => AppDesignRequest.findById(id));
  if (!doc || doc.stage === 'draft') {
    // A draft is the institute's private work: the console does not see it
    // until it is submitted, even by id.
    throw new DesignRequestError('Design request not found.', 404, 'DESIGN_REQUEST_NOT_FOUND');
  }
  return doc;
}

export async function getDesignRequest(id: string): Promise<DesignRequestView & { orgActive: ActiveDesignView | null }> {
  const doc = await loadRequest(id);
  const org = await loadOrg(String(doc.orgId));
  return { ...requestView(doc), orgActive: activeViewOf(org) };
}

export type ReviewAction = 'request-changes' | 'approve' | 'reject';

export async function reviewDesign(id: string, action: ReviewAction, ref: DesignActorRef, note?: string): Promise<DesignRequestView> {
  const text = typeof note === 'string' ? note.trim() : '';
  if ((action === 'request-changes' || action === 'reject') && !text) {
    throw new DesignRequestError(
      action === 'reject' ? 'Say why the design is not approved — the institute reads this.' : 'Say what should change — the institute reads this.',
      400,
      'DESIGN_NOTE_REQUIRED',
    );
  }
  const doc = await loadRequest(id);
  return requestView(await apply(doc, action, 'platform-admin', ref, { note: text || undefined }));
}

/**
 * Activate an approved design: it becomes what this organization's builds
 * compile in. The previously active request, if any, is superseded.
 */
export async function activateDesign(id: string, ref: DesignActorRef, note?: string): Promise<DesignRequestView> {
  const doc = await loadRequest(id);
  if (!templateById(doc.selection.templateId)) {
    throw new DesignRequestError('That template is no longer in this platform version, so it cannot be built.', 409, 'DESIGN_TEMPLATE_UNKNOWN');
  }
  const activated = await apply(doc, 'activate', 'platform-admin', ref, { note: typeof note === 'string' ? note.trim() || undefined : undefined });

  // The design that was active steps aside — recorded, not erased.
  const previous = await withoutTenantScope('app-design:previous-active', async () =>
    AppDesignRequest.find({ orgId: doc.orgId, stage: 'active', _id: { $ne: activated._id } }),
  );
  for (const old of previous) {
    try {
      await apply(old, 'supersede', 'system', {}, {}, { supersededBy: activated._id });
    } catch (err) {
      console.error('[app-design] could not supersede', String(old._id), (err as Error)?.message);
    }
  }

  const normalized = normalizeDesignSelection(activated.selection, TEMPLATES);
  await withoutTenantScope('app-design:set-active', async () =>
    orgModel().updateOne(
      { _id: activated.orgId },
      {
        $set: {
          'appDesign.active': {
            requestId: activated._id,
            selection: normalized?.selection ?? activated.selection,
            templateName: activated.templateName,
            activatedAt: activated.activatedAt,
            activatedByEmail: activated.activatedByEmail,
          },
        },
      },
    ),
  );
  return requestView(activated);
}

/** Remember a build started from this request, so the console can follow it. */
export async function linkBuildToRequest(
  id: string,
  build: { _id: unknown; buildNumber: number; artifactType: string },
): Promise<void> {
  await withoutTenantScope('app-design:link-build', async () =>
    AppDesignRequest.updateOne(
      { _id: id },
      {
        $push: {
          builds: {
            buildId: build._id,
            buildNumber: build.buildNumber,
            artifactType: build.artifactType,
            startedAt: new Date(),
          },
        },
      },
    ),
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Builds
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The design an organization's next build compiles in, or null for the
 * product default. Re-validated on read: a template retired since activation
 * yields null here and a readiness problem in `designBuildProblem`.
 */
export function activeSelectionOf(org: Record<string, any> | null): DesignSelection | null {
  const active = org?.appDesign?.active;
  if (!active?.selection) return null;
  const normalized = normalizeDesignSelection(active.selection, TEMPLATES);
  if (!normalized || normalized.compatibility === 'unknown-template') return null;
  return normalized.selection;
}

/** A sentence for build readiness when the active design cannot be built. */
export function designBuildProblem(org: Record<string, any> | null): string | null {
  const active = org?.appDesign?.active;
  if (!active?.selection) return null;
  const normalized = normalizeDesignSelection(active.selection, TEMPLATES);
  if (!normalized) return 'The activated app design is not a valid selection. Re-activate a design from App designs.';
  if (normalized.compatibility === 'unknown-template') {
    return `The activated app design "${active.templateName ?? normalized.selection.templateId}" is not in this platform version. Activate another design from App designs.`;
  }
  return null;
}

/** What the console shows about the design a build will carry. */
export function designForBuildView(org: Record<string, any> | null): { templateId: string; templateName: string; templateVersion: string; requestId: string } | null {
  const selection = activeSelectionOf(org);
  if (!selection) return null;
  return {
    templateId: selection.templateId,
    templateName: templateById(selection.templateId)?.meta.name ?? selection.templateId,
    templateVersion: selection.templateVersion,
    requestId: String(org?.appDesign?.active?.requestId ?? ''),
  };
}
