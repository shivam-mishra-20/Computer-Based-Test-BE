/**
 * MIRROR of platform-client-core/src/design/lifecycle.ts — edit THAT file, then copy.
 *
 * The design-template rules are shared by the mobile app, the web Design
 * Studio and the platform console through @platform/client-core. This server
 * needs the same answers — which templates exist, what a valid selection is,
 * which lifecycle moves are allowed and by whom — but it cannot import a
 * sibling repository (see the header of ../mobileBuildRules.ts for why).
 *
 * So everything from the "Mirrored body" marker down is a byte-for-byte copy,
 * and `npm run safety:design-rules` fails on any difference.
 */

import type { DesignSelection } from './validate';

/* ══ Mirrored body ═══════════════════════════════════════════════════════════
 * Everything from this line down is copied byte for byte into central-be
 * (src/core/platform/design/). Edit it here, then copy it across;
 * `npm run safety:design-rules` in central-be fails on any difference.
 * ══════════════════════════════════════════════════════════════════════════ */

export const DESIGN_STAGES = [
  'draft',
  'submitted',
  'changes-requested',
  'approved',
  'rejected',
  'active',
  'superseded',
] as const;
export type DesignStage = (typeof DESIGN_STAGES)[number];

export type DesignActor = 'org-admin' | 'platform-admin' | 'system';

export const DESIGN_ACTIONS = [
  'save',
  'submit',
  'withdraw',
  'request-changes',
  'approve',
  'reject',
  'activate',
  'supersede',
] as const;
export type DesignAction = (typeof DESIGN_ACTIONS)[number];

/** Who may take each action, from which stages, to which stage. */
export const TRANSITIONS: Record<DesignAction, { actor: DesignActor; from: DesignStage[]; to: DesignStage }> = {
  // The organization edits its own draft (or answers a change request).
  save: { actor: 'org-admin', from: ['draft', 'changes-requested'], to: 'draft' },
  submit: { actor: 'org-admin', from: ['draft'], to: 'submitted' },
  withdraw: { actor: 'org-admin', from: ['submitted'], to: 'draft' },
  // The platform reviews.
  'request-changes': { actor: 'platform-admin', from: ['submitted'], to: 'changes-requested' },
  approve: { actor: 'platform-admin', from: ['submitted'], to: 'approved' },
  reject: { actor: 'platform-admin', from: ['submitted'], to: 'rejected' },
  // Turning it on is its own decision.
  activate: { actor: 'platform-admin', from: ['approved'], to: 'active' },
  // When another design is activated, the old one steps aside.
  supersede: { actor: 'system', from: ['active'], to: 'superseded' },
};

export interface DesignHistoryEntry {
  action: DesignAction;
  from: DesignStage;
  to: DesignStage;
  actor: DesignActor;
  at: string;
  note?: string;
}

export interface DesignRecord {
  stage: DesignStage;
  /** Increments on every saved change to the selection. */
  revision: number;
  selection: DesignSelection;
  history: DesignHistoryEntry[];
}

export type TransitionResult =
  | { ok: true; record: DesignRecord }
  | { ok: false; reason: string };

/** A new draft from a gallery selection. Never anything but a draft. */
export function startDraft(selection: DesignSelection, at: string): DesignRecord {
  return {
    stage: 'draft',
    revision: 1,
    selection,
    history: [{ action: 'save', from: 'draft', to: 'draft', actor: 'org-admin', at }],
  };
}

/**
 * Apply an action. Refuses — with a sentence — anything the table does not
 * allow, including the right action by the wrong actor.
 */
export function transition(
  record: DesignRecord,
  action: DesignAction,
  actor: DesignActor,
  at: string,
  change?: { selection?: DesignSelection; note?: string },
): TransitionResult {
  const rule = TRANSITIONS[action];
  if (!rule) return { ok: false, reason: `Unknown action "${action}".` };
  if (rule.actor !== actor) return { ok: false, reason: `Only the ${rule.actor} can ${action} a design.` };
  if (!rule.from.includes(record.stage)) {
    return { ok: false, reason: `A ${record.stage} design cannot be ${action === 'save' ? 'edited' : `${action}ed`}.` };
  }
  if (action === 'save' && !change?.selection) return { ok: false, reason: 'Saving needs the changed selection.' };

  return {
    ok: true,
    record: {
      stage: rule.to,
      revision: action === 'save' ? record.revision + 1 : record.revision,
      selection: action === 'save' && change?.selection ? change.selection : record.selection,
      history: [...record.history, { action, from: record.stage, to: rule.to, actor, at, note: change?.note }],
    },
  };
}

/** The ONE question a device asks of a record: does this change my app? */
export function isLive(record: DesignRecord | null | undefined): boolean {
  return record?.stage === 'active';
}

/** The actions available to an actor right now — what a screen offers. */
export function availableActions(record: DesignRecord, actor: DesignActor): DesignAction[] {
  return (Object.keys(TRANSITIONS) as DesignAction[]).filter(
    (action) => TRANSITIONS[action].actor === actor && TRANSITIONS[action].from.includes(record.stage),
  );
}

/** Plain-language status for an administrator. */
export const STAGE_COPY: Record<DesignStage, { label: string; detail: string }> = {
  draft: { label: 'Draft', detail: 'Saved for your organization. Not visible to students.' },
  submitted: { label: 'Submitted', detail: 'Waiting for the platform team to review it.' },
  'changes-requested': { label: 'Changes requested', detail: 'The platform team asked for changes before approval.' },
  approved: { label: 'Approved', detail: 'Approved. It goes live when the platform team activates it.' },
  rejected: { label: 'Not approved', detail: 'Choose again or adjust it and submit a new revision.' },
  active: { label: 'Activated', detail: 'Every new build of your app uses this design. Students see it once that build is installed.' },
  superseded: { label: 'Replaced', detail: 'A newer design was activated in its place.' },
};
