import mongoose, { Document, Schema, Types } from 'mongoose';

// ── Lead ────────────────────────────────────────────────────────────────────
// One prospective family, however many times it reaches us.
//
// This is deliberately a GENERIC lead, not an "AGTS lead": the admissions
// pipeline is AGTS → Lead → Counselling → Admission, and a second isolated lead
// store per channel is exactly what the enquiry forms already suffer from.
// AGTS is the first channel that writes here (`channels: ['agts']`); an
// admission enquiry or call-back form can join later without a new model.
//
// ── Identity ────────────────────────────────────────────────────────────────
// A lead is keyed by the contact's normalized 10-digit phone number within an
// organization. Repeating a test, or a sibling taking it on the same parent's
// number, updates the one lead instead of creating another. The unique index
// includes `orgId` (added by the tenant plugin) so two institutes can each
// hold the same family.
//
// ── What is never client-supplied ───────────────────────────────────────────
// status, statusHistory, notes, follow-up, contact log, AGTS results, orgId —
// all are written only by agtsService / leadService from server-side facts.

export const LEAD_STATUSES = [
  'new',
  'contacted',
  'qualified',
  'agts_completed',
  'counselling',
  'follow_up',
  'enrolled',
  'lost',
  'nurture',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_CHANNELS = ['agts'] as const;
export type LeadChannel = (typeof LEAD_CHANNELS)[number];

export const CONTACT_CHANNELS = ['call', 'whatsapp', 'email', 'in_person', 'other'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export interface Touch {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
  landingPage?: string;
  referrer?: string;
  capturedAt?: Date;
}

export interface AgtsResultSnapshot {
  attemptId: string;
  testName?: string;
  classLevel?: number;
  submittedAt?: Date;
  score: number;
  maxScore: number;
  percentage: number;
  accuracy: number;
  correct: number;
  incorrect: number;
  skipped: number;
  timeTakenSec: number;
  band?: string;
}

export interface ILead extends Document {
  orgId?: string;
  phone: string;
  phoneNormalized: string;
  email?: string;
  student: { name: string; classLevel?: number; school?: string; board?: string };
  /** Every distinct student name registered on this number (siblings). */
  studentNames: string[];
  guardian: { name?: string };
  channels: LeadChannel[];
  consent: { contact: boolean; version?: string; text?: string; grantedAt?: Date; channel?: string };
  attribution: { first?: Touch; last?: Touch };
  status: LeadStatus;
  statusHistory: Array<{ from?: string; to: string; at: Date; by?: Types.ObjectId; byName?: string; note?: string; automatic?: boolean }>;
  notes: Array<{ _id?: Types.ObjectId; text: string; at: Date; by?: Types.ObjectId; byName?: string }>;
  followUpAt?: Date | null;
  lastContactedAt?: Date | null;
  lastContactChannel?: string;
  contactLog: Array<{ channel: string; at: Date; by?: Types.ObjectId; byName?: string }>;
  agts: {
    attemptCount: number;
    completedCount: number;
    firstAttemptAt?: Date;
    lastAttemptAt?: Date;
    latest?: AgtsResultSnapshot | null;
  };
  guidance: {
    requested: boolean;
    requestedAt?: Date | null;
    preferredTime?: string;
    message?: string;
    count: number;
    attemptId?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const touchSchema = new Schema<Touch>(
  {
    source: { type: String, maxlength: 100 },
    medium: { type: String, maxlength: 100 },
    campaign: { type: String, maxlength: 100 },
    content: { type: String, maxlength: 100 },
    term: { type: String, maxlength: 100 },
    landingPage: { type: String, maxlength: 200 },
    referrer: { type: String, maxlength: 120 },
    capturedAt: { type: Date },
  },
  { _id: false },
);

const leadSchema = new Schema<ILead>(
  {
    phone: { type: String, required: true, maxlength: 20 },
    phoneNormalized: { type: String, required: true, maxlength: 10 },
    email: { type: String, maxlength: 120, default: '' },
    student: {
      name: { type: String, required: true, maxlength: 80 },
      classLevel: { type: Number, min: 1, max: 12 },
      school: { type: String, maxlength: 120, default: '' },
      board: { type: String, maxlength: 40, default: '' },
    },
    studentNames: { type: [String], default: [] },
    guardian: {
      name: { type: String, maxlength: 80, default: '' },
    },
    channels: { type: [String], enum: LEAD_CHANNELS, default: [] },
    consent: {
      contact: { type: Boolean, default: false },
      version: { type: String, maxlength: 20 },
      text: { type: String, maxlength: 400 },
      grantedAt: { type: Date },
      channel: { type: String, maxlength: 20 },
    },
    attribution: {
      first: { type: touchSchema, default: undefined },
      last: { type: touchSchema, default: undefined },
    },
    status: { type: String, enum: LEAD_STATUSES, default: 'new', index: true },
    statusHistory: [
      {
        _id: false,
        from: String,
        to: { type: String, required: true },
        at: { type: Date, required: true },
        by: { type: Schema.Types.ObjectId, ref: 'User' },
        byName: String,
        note: { type: String, maxlength: 500 },
        automatic: Boolean,
      },
    ],
    notes: [
      {
        text: { type: String, required: true, maxlength: 2000 },
        at: { type: Date, required: true },
        by: { type: Schema.Types.ObjectId, ref: 'User' },
        byName: String,
      },
    ],
    followUpAt: { type: Date, default: null, index: true },
    lastContactedAt: { type: Date, default: null },
    lastContactChannel: { type: String, default: '' },
    contactLog: [
      {
        _id: false,
        channel: { type: String, required: true },
        at: { type: Date, required: true },
        by: { type: Schema.Types.ObjectId, ref: 'User' },
        byName: String,
      },
    ],
    agts: {
      attemptCount: { type: Number, default: 0 },
      completedCount: { type: Number, default: 0 },
      firstAttemptAt: { type: Date },
      lastAttemptAt: { type: Date },
      latest: {
        type: new Schema<AgtsResultSnapshot>(
          {
            attemptId: String,
            testName: String,
            classLevel: Number,
            submittedAt: Date,
            score: Number,
            maxScore: Number,
            percentage: Number,
            accuracy: Number,
            correct: Number,
            incorrect: Number,
            skipped: Number,
            timeTakenSec: Number,
            band: String,
          },
          { _id: false },
        ),
        default: null,
      },
    },
    guidance: {
      requested: { type: Boolean, default: false },
      requestedAt: { type: Date, default: null },
      preferredTime: { type: String, maxlength: 60, default: '' },
      message: { type: String, maxlength: 500, default: '' },
      count: { type: Number, default: 0 },
      attemptId: { type: String, default: '' },
    },
  },
  { timestamps: true },
);

// One lead per phone number per organization. `orgId` is added by the tenant
// plugin; listing it here keeps the key tenant-local (safety:indexes).
leadSchema.index({ orgId: 1, phoneNormalized: 1 }, { unique: true });
leadSchema.index({ orgId: 1, status: 1, updatedAt: -1 });
leadSchema.index({ orgId: 1, 'agts.lastAttemptAt': -1 });

export default mongoose.model<ILead>('Lead', leadSchema);
