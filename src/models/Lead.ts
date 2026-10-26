import mongoose, { Document, Schema, Types } from 'mongoose';

// ── Lead ────────────────────────────────────────────────────────────────────
// One prospective family, however many times it reaches us.
//
// This is deliberately a GENERIC lead, not an "AGTS lead": the admissions
// pipeline is AGTS → Lead → Counselling → Admission, and a second isolated lead
// store per channel is exactly what the enquiry forms already suffer from.
// AGTS was the first channel that writes here (`channels: ['agts']`). Since the
// 2027-28 admissions season the website's enquiry forms (`enquiry`) and the
// personal application link (`application`) write to the same lead, so one
// family is one record from first contact to enrolment — see
// services/admissions.
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
  // An application form was submitted through the family's personal link.
  'applied',
  // A seat was offered and is held until `offer.holdUntil`.
  'offered',
  // Eligible, but no seat is free in the class asked for.
  'waitlisted',
  'follow_up',
  'enrolled',
  'lost',
  'nurture',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_CHANNELS = ['agts', 'enquiry', 'application'] as const;
export type LeadChannel = (typeof LEAD_CHANNELS)[number];

export const ADMISSION_STREAMS = ['Science', 'Commerce'] as const;
export const GUARDIAN_RELATIONS = ['Father', 'Mother', 'Guardian'] as const;
export const GUARDIAN_OCCUPATIONS = ['Service', 'Business', 'Self-employed', 'Govt. Employee', 'Homemaker', 'Other'] as const;
export const DOCUMENT_KINDS = ['report_card', 'photo', 'birth_certificate', 'transfer_certificate', 'id_proof', 'other'] as const;
export const PAYMENT_MODES = ['cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other'] as const;

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

export interface GuardianDetails {
  relation?: string;
  name?: string;
  phone?: string;
  email?: string;
  occupation?: string;
  organisation?: string;
  designation?: string;
}

export interface SubjectMark {
  obtained?: number | null;
  outOf?: number | null;
}

/** What the family entered on the application form, after validation. */
export interface ApplicationData {
  student: {
    name: string;
    dateOfBirth?: Date | null;
    currentClass?: number | null;
    school?: string;
    board?: string;
    previousPercentage?: number | null;
    marks?: { maths?: SubjectMark; science?: SubjectMark; socialScience?: SubjectMark; english?: SubjectMark };
  };
  primary: GuardianDetails;
  secondary?: GuardianDetails | null;
  address: { line?: string; city?: string; pincode?: string };
  query?: string;
}

export interface ApplicationDocument {
  _id?: Types.ObjectId;
  kind: string;
  storagePath: string;
  fileName: string;
  contentType: string;
  size: number;
  uploadedAt: Date;
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
  /**
   * The admission the family is asking about. Distinct from `student.classLevel`,
   * which AGTS records as the class the student is in NOW.
   */
  admission: { session?: string; classLevel?: number; stream?: string };
  /** The staff member who owns the follow-through. */
  owner: { id?: Types.ObjectId | null; name?: string };
  /** Website enquiries (every form on the public site). */
  enquiry: { count?: number; firstAt?: Date | null; lastAt?: Date | null; source?: string; message?: string };
  application: {
    /** sha256 of the personal link's token. The token itself is never stored. */
    tokenHash?: string;
    tokenIssuedAt?: Date | null;
    tokenExpiresAt?: Date | null;
    submittedAt?: Date | null;
    registrationId?: string;
    consentAt?: Date | null;
    consentVersion?: string;
    data?: ApplicationData | null;
    documents: ApplicationDocument[];
  };
  offer: {
    classLevel?: number;
    stream?: string;
    batch?: string;
    feeNote?: string;
    offeredAt?: Date | null;
    holdUntil?: Date | null;
    byName?: string;
  };
  enrolment: {
    paidAt?: Date | null;
    amount?: number | null;
    mode?: string;
    receiptNo?: string;
    recordedAt?: Date | null;
    byName?: string;
    studentUserId?: Types.ObjectId | null;
    empCode?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

// No defaults on the admission / enquiry paths below: the enquiry upsert writes
// them with `$inc` and `$setOnInsert`, and a schema default would be added to
// the same upsert by `setDefaultsOnInsert` and collide with those operators.

const guardianSchema = new Schema<GuardianDetails>(
  {
    relation: { type: String, enum: GUARDIAN_RELATIONS },
    name: { type: String, maxlength: 80 },
    phone: { type: String, maxlength: 10 },
    email: { type: String, maxlength: 120 },
    occupation: { type: String, enum: GUARDIAN_OCCUPATIONS },
    organisation: { type: String, maxlength: 120 },
    designation: { type: String, maxlength: 80 },
  },
  { _id: false },
);

const markSchema = new Schema<SubjectMark>(
  { obtained: { type: Number, min: 0, max: 1000 }, outOf: { type: Number, min: 1, max: 1000 } },
  { _id: false },
);

const applicationDataSchema = new Schema<ApplicationData>(
  {
    student: {
      name: { type: String, required: true, maxlength: 80 },
      dateOfBirth: { type: Date },
      currentClass: { type: Number, min: 1, max: 12 },
      school: { type: String, maxlength: 120 },
      board: { type: String, maxlength: 40 },
      previousPercentage: { type: Number, min: 0, max: 100 },
      marks: {
        maths: { type: markSchema, default: undefined },
        science: { type: markSchema, default: undefined },
        socialScience: { type: markSchema, default: undefined },
        english: { type: markSchema, default: undefined },
      },
    },
    primary: { type: guardianSchema, required: true },
    secondary: { type: guardianSchema, default: null },
    address: {
      line: { type: String, maxlength: 300 },
      city: { type: String, maxlength: 80 },
      pincode: { type: String, maxlength: 6 },
    },
    query: { type: String, maxlength: 1000 },
  },
  { _id: false },
);

const documentSchema = new Schema<ApplicationDocument>({
  kind: { type: String, enum: DOCUMENT_KINDS, required: true },
  storagePath: { type: String, required: true, maxlength: 400 },
  fileName: { type: String, required: true, maxlength: 160 },
  contentType: { type: String, required: true, maxlength: 80 },
  size: { type: Number, required: true },
  uploadedAt: { type: Date, required: true },
});

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
    admission: {
      session: { type: String, maxlength: 7 },
      classLevel: { type: Number, min: 1, max: 12 },
      stream: { type: String, enum: [...ADMISSION_STREAMS, ''] },
    },
    owner: {
      id: { type: Schema.Types.ObjectId, ref: 'User' },
      name: { type: String, maxlength: 80 },
    },
    enquiry: {
      count: { type: Number },
      firstAt: { type: Date },
      lastAt: { type: Date },
      source: { type: String, maxlength: 30 },
      message: { type: String, maxlength: 500 },
    },
    application: {
      tokenHash: { type: String, maxlength: 64 },
      tokenIssuedAt: { type: Date },
      tokenExpiresAt: { type: Date },
      submittedAt: { type: Date },
      registrationId: { type: String, maxlength: 24 },
      consentAt: { type: Date },
      consentVersion: { type: String, maxlength: 20 },
      data: { type: applicationDataSchema, default: null },
      documents: { type: [documentSchema], default: [] },
    },
    offer: {
      classLevel: { type: Number, min: 1, max: 12 },
      stream: { type: String, enum: [...ADMISSION_STREAMS, ''] },
      batch: { type: String, maxlength: 60 },
      feeNote: { type: String, maxlength: 300 },
      offeredAt: { type: Date },
      holdUntil: { type: Date },
      byName: { type: String, maxlength: 80 },
    },
    enrolment: {
      paidAt: { type: Date },
      amount: { type: Number, min: 0 },
      mode: { type: String, enum: PAYMENT_MODES },
      receiptNo: { type: String, maxlength: 60 },
      recordedAt: { type: Date },
      byName: { type: String, maxlength: 80 },
      studentUserId: { type: Schema.Types.ObjectId, ref: 'User' },
      empCode: { type: String, maxlength: 64 },
    },
  },
  { timestamps: true },
);

// One lead per phone number per organization. `orgId` is added by the tenant
// plugin; listing it here keeps the key tenant-local (safety:indexes).
leadSchema.index({ orgId: 1, phoneNormalized: 1 }, { unique: true });
leadSchema.index({ orgId: 1, status: 1, updatedAt: -1 });
leadSchema.index({ orgId: 1, 'agts.lastAttemptAt': -1 });
// The personal application link is looked up by the hash of its token.
leadSchema.index({ orgId: 1, 'application.tokenHash': 1 }, { partialFilterExpression: { 'application.tokenHash': { $type: 'string' } } });
// A registration ID names one application. Partial, so the many leads without
// one never collide on a missing value.
leadSchema.index(
  { orgId: 1, 'application.registrationId': 1 },
  { unique: true, partialFilterExpression: { 'application.registrationId': { $type: 'string' } } },
);
leadSchema.index({ orgId: 1, 'admission.session': 1, 'admission.classLevel': 1, status: 1 });

export default mongoose.model<ILead>('Lead', leadSchema);
