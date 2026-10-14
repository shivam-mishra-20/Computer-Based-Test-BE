/**
 * An organization's request to change its app's design — and everything that
 * happened to it.
 *
 * ── The lifecycle is not invented here ──────────────────────────────────────
 * Stages, actions and who may take them come from the shared design rules
 * (core/platform/design/lifecycle.ts, mirrored from platform-client-core). The
 * institute's administrators SAVE and SUBMIT a selection from the web Design
 * Studio; platform staff REQUEST CHANGES, APPROVE, REJECT and ACTIVATE it from
 * the console. Approval and activation are separate on purpose: "is this
 * acceptable" and "build the next app with it" are different decisions.
 *
 * ── What is stored is a reference, never tokens ─────────────────────────────
 * `selection` is the template id, the template version it was made against
 * and the organization's validated overrides. Colours are re-derived by every
 * client from the template it ships, so a legibility fix in a template reaches
 * every organization using it, and nothing stored here can carry a style, a
 * script or a colour the platform has not checked.
 *
 * ── `tenantScoped: false` ───────────────────────────────────────────────────
 * Like `AppBuildJob`, this is read by platform staff across every
 * organization, from requests that carry no organization context. Every query
 * names `orgId` explicitly: the institute's routes take it from the signed-in
 * principal (never from a parameter), the console's from the request it is
 * reviewing.
 *
 * ── One open request per organization ───────────────────────────────────────
 * A partial unique index refuses a second request in an OPEN stage (draft,
 * submitted, changes requested, approved). Two open requests would leave the
 * console guessing which one the institute means, and two "approved" designs
 * would leave a build guessing which one to compile. Closed requests — rejected,
 * active, superseded — accumulate as history.
 */

import mongoose, { Document, Schema } from 'mongoose';
import { DESIGN_STAGES, type DesignAction, type DesignActor, type DesignStage } from '../core/platform/design';

/** Stages in which a request is still being worked on. At most one per organization. */
export const OPEN_DESIGN_STAGES: DesignStage[] = ['draft', 'submitted', 'changes-requested', 'approved'];

export interface IDesignSelectionDoc {
  kind: 'org-app-design';
  schemaVersion: number;
  templateId: string;
  templateVersion: string;
  overrides: {
    primaryColor?: string;
    accentColor?: string;
    appearance?: 'light' | 'dark' | 'system';
    density?: 'compact' | 'regular' | 'airy';
  };
}

export interface IDesignHistoryEntry {
  action: DesignAction;
  from: DesignStage;
  to: DesignStage;
  actor: DesignActor;
  actorId?: string;
  actorEmail?: string;
  at: Date;
  note?: string;
  /** Present on a save: the template the selection named at that moment. */
  templateId?: string;
}

export interface IDesignBuildLink {
  buildId: mongoose.Types.ObjectId;
  buildNumber: number;
  artifactType: string;
  startedAt: Date;
}

export interface IAppDesignRequest extends Document {
  orgId: mongoose.Types.ObjectId;
  /** Denormalized for the console's queue, which lists across organizations. */
  organizationName: string;
  organizationSlug: string;

  stage: DesignStage;
  /** Increments on every saved change to the selection. */
  revision: number;
  selection: IDesignSelectionDoc;
  /** Denormalized from the catalogue at save time, for lists. */
  templateName: string;

  history: IDesignHistoryEntry[];

  submittedAt?: Date;
  submittedByEmail?: string;
  decidedAt?: Date;
  decidedByEmail?: string;
  /** The reviewer's words to the institute: why changes were asked for, or why it was refused. */
  decisionNote?: string;
  activatedAt?: Date;
  activatedByEmail?: string;
  supersededAt?: Date;
  /** The request whose activation replaced this one. */
  supersededBy?: mongoose.Types.ObjectId;

  /** Builds started from this request, so the console can follow them. */
  builds: IDesignBuildLink[];

  createdAt: Date;
  updatedAt: Date;
}

const historySchema = new Schema<IDesignHistoryEntry>(
  {
    action: { type: String, required: true },
    from: { type: String, enum: DESIGN_STAGES as unknown as string[], required: true },
    to: { type: String, enum: DESIGN_STAGES as unknown as string[], required: true },
    actor: { type: String, enum: ['org-admin', 'platform-admin', 'system'], required: true },
    actorId: { type: String },
    actorEmail: { type: String },
    at: { type: Date, required: true },
    note: { type: String, maxlength: 1000 },
    templateId: { type: String },
  },
  { _id: false },
);

const appDesignRequestSchema = new Schema<IAppDesignRequest>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    organizationName: { type: String, required: true },
    organizationSlug: { type: String, required: true },

    stage: { type: String, enum: DESIGN_STAGES as unknown as string[], required: true, default: 'draft' },
    revision: { type: Number, required: true, default: 1, min: 1 },
    selection: {
      type: {
        kind: { type: String, enum: ['org-app-design'], required: true },
        schemaVersion: { type: Number, required: true },
        templateId: { type: String, required: true },
        templateVersion: { type: String, required: true },
        overrides: {
          type: {
            primaryColor: String,
            accentColor: String,
            appearance: { type: String, enum: ['light', 'dark', 'system'] },
            density: { type: String, enum: ['compact', 'regular', 'airy'] },
          },
          _id: false,
          default: {},
        },
      },
      _id: false,
      required: true,
    },
    templateName: { type: String, required: true },

    history: { type: [historySchema], default: [] },

    submittedAt: Date,
    submittedByEmail: String,
    decidedAt: Date,
    decidedByEmail: String,
    decisionNote: { type: String, maxlength: 1000 },
    activatedAt: Date,
    activatedByEmail: String,
    supersededAt: Date,
    supersededBy: { type: Schema.Types.ObjectId, ref: 'AppDesignRequest' },

    builds: {
      type: [
        new Schema<IDesignBuildLink>(
          {
            buildId: { type: Schema.Types.ObjectId, ref: 'AppBuildJob', required: true },
            buildNumber: { type: Number, required: true },
            artifactType: { type: String, required: true },
            startedAt: { type: Date, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  // Platform-plane, like AppBuildJob. See the header.
  { timestamps: true, tenantScoped: false } as never,
);

/** An institute's own history, newest first. */
appDesignRequestSchema.index({ orgId: 1, createdAt: -1 });
/** The console's review queue. */
appDesignRequestSchema.index({ stage: 1, updatedAt: -1 });

/** At most one OPEN request per organization — see the header. */
appDesignRequestSchema.index(
  { orgId: 1 },
  {
    unique: true,
    partialFilterExpression: { stage: { $in: OPEN_DESIGN_STAGES } },
    name: 'one_open_design_request_per_org',
  },
);

const AppDesignRequest = mongoose.model<IAppDesignRequest>('AppDesignRequest', appDesignRequestSchema);
export default AppDesignRequest;
