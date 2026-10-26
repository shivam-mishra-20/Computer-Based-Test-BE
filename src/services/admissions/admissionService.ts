/**
 * Admissions — one pipeline from first enquiry to a student account.
 *
 *   enquiry (any website form) ─┐
 *   AGTS registration ──────────┼─► Lead (one per phone) ─► application link ─►
 *   walk-in / call (staff) ─────┘     applied ─► offered (seat held) / waitlisted ─►
 *                                     enrolled (payment recorded, login created)
 *
 * Every family is the `Lead` AGTS already writes (models/Lead), keyed by phone,
 * so a parent who enquires, takes AGTS and applies is one record with one
 * history. Status moves made here on the family's behalf are facts (an
 * application WAS submitted); offers, waitlisting and enrolment are a staff
 * member's decision and carry their name.
 *
 * Seats: `AdmissionSeat` holds the capacity an admin entered for each class
 * (and stream) in a session. Seats left = capacity − enrolled − offers still
 * inside their hold window. An offer that would overfill a class is refused
 * unless the admin explicitly overrides it.
 */

import { Types } from 'mongoose';
import Lead, { type ILead, type LeadStatus } from '../../models/Lead';
import AdmissionSeat from '../../models/AdmissionSeat';
import User from '../../models/User';
import { currentTenantOrgId, requireTenantScope } from '../../core/tenancy';
import { deleteTenantFile, putTenantFile, signedUrlForTenantPath } from '../../core/storage/storageService';
import { seatOf, withCapacity, type SeatResource } from '../../core/subscriptions/usage';
import { resolveStudentClassAndBatch, takenAnywhere } from '../../controllers/userController';
import { logAudit } from '../../utils/logger';
import { findScopedLead, staffLeadView, upsertLeadByPhone, type Actor } from '../agts/leadService';
import { enquirySourceLabel, notifyAdmissionsStaff } from './admissionAlerts';
import {
  APPLICATION_CONSENT_VERSION,
  ENQUIRY_CONSENT_TEXT,
  ENQUIRY_CONSENT_VERSION,
  currentAdmissionSession,
  generatePassword,
  generateRegistrationId,
  hashToken,
  needsStream,
  newApplicationToken,
  seatKey,
  seatsLeft,
  type AccountInput,
  type ApplicationInput,
  type EnquiryInput,
  type EnrolmentInput,
  type OfferInput,
  type SeatRow,
} from './admissionValidation';

export class AdmissionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly errors?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AdmissionError';
  }
}

const DAY = 24 * 3600 * 1000;
const APPLICATION_LINK_DAYS = 60;
const MAX_DOCUMENTS = 12;
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

const actorId = (actor?: Actor) => (actor?.id && Types.ObjectId.isValid(actor.id) ? new Types.ObjectId(actor.id) : undefined);
const actorName = (actor?: Actor) => String(actor?.name || '').slice(0, 80);

/** Statuses an application, once submitted, may move a lead forward from. */
const PRE_APPLIED: LeadStatus[] = ['new', 'contacted', 'qualified', 'agts_completed', 'counselling', 'follow_up', 'nurture'];
/** A family past these points has already been decided on; the form is closed. */
const APPLICATION_CLOSED: LeadStatus[] = ['offered', 'enrolled', 'lost'];
/** A website enquiry does not rewrite a family already in the application stage. */
const IN_APPLICATION: LeadStatus[] = ['applied', 'offered', 'waitlisted', 'enrolled'];

function pushHistory(lead: ILead, to: LeadStatus, at: Date, note: string, actor?: Actor) {
  const from = lead.status;
  lead.status = to;
  lead.statusHistory.push({ from, to, at, note: note.slice(0, 500), ...(actor ? { by: actorId(actor), byName: actorName(actor) } : { automatic: true }) });
}

function pushNote(lead: ILead, text: string, at: Date, actor?: Actor) {
  lead.notes.push({ text: text.slice(0, 2000), at, by: actorId(actor), byName: actor ? actorName(actor) : 'System' });
  if (lead.notes.length > 500) lead.notes.splice(0, lead.notes.length - 500);
}

const classLabel = (classLevel?: number, stream?: string) =>
  classLevel ? `Class ${classLevel}${stream ? ` ${stream}` : ''}` : 'class not chosen';

// ── Public: the enquiry every website form sends ────────────────────────────

/**
 * Record a website enquiry against the family's lead. The answer never says
 * whether the number was already known — that would tell anyone who types a
 * phone number whether that family has been in touch.
 */
export async function submitEnquiry(input: EnquiryInput, now = new Date()): Promise<{ received: true }> {
  const session = currentAdmissionSession();
  const existing = await Lead.findOne({ ...requireTenantScope('admissions:enquiry'), phoneNormalized: input.phoneNormalized })
    .select('status')
    .lean();
  const keepTarget = Boolean(existing && IN_APPLICATION.includes(existing.status as LeadStatus));

  const touch = input.attribution ? { ...input.attribution, capturedAt: now } : null;
  const set: Record<string, unknown> = {
    phone: input.phone,
    consent: { contact: true, version: ENQUIRY_CONSENT_VERSION, text: ENQUIRY_CONSENT_TEXT, grantedAt: now, channel: 'enquiry' },
    'enquiry.lastAt': now,
    'enquiry.source': input.source,
  };
  if (!keepTarget) {
    Object.assign(set, {
      'student.name': input.studentName,
      'guardian.name': input.guardianName,
      'admission.session': session,
      'admission.classLevel': input.classLevel,
      'admission.stream': input.stream,
    });
    if (input.school) set['student.school'] = input.school;
    if (input.board) set['student.board'] = input.board;
  }
  if (input.message) set['enquiry.message'] = input.message;
  if (input.email) set.email = input.email;
  if (touch) set['attribution.last'] = touch;

  const setOnInsert: Record<string, unknown> = {
    status: 'new',
    statusHistory: [{ to: 'new', at: now, automatic: true, note: `Admission enquiry (${enquirySourceLabel(input.source)})` }],
    'enquiry.firstAt': now,
  };
  if (touch) setOnInsert['attribution.first'] = touch;

  const update: Record<string, unknown> = {
    $set: set,
    $setOnInsert: setOnInsert,
    $inc: { 'enquiry.count': 1 },
    $addToSet: { channels: 'enquiry', studentNames: input.studentName },
  };
  // A family already applying keeps its application's student and class; the
  // new enquiry (often a sibling) is written down for staff instead.
  if (keepTarget) {
    update.$push = {
      notes: {
        text: `Website enquiry (${enquirySourceLabel(input.source)}) for ${input.studentName}, ${classLabel(input.classLevel, input.stream)}${input.message ? `: “${input.message}”` : ''}`,
        at: now,
        byName: 'System',
      },
    };
  }

  const { lead } = await upsertLeadByPhone(input.phoneNormalized, update);
  void notifyAdmissionsStaff(
    'enquiry',
    { _id: lead._id, student: { name: input.studentName }, admission: { classLevel: input.classLevel, stream: input.stream }, owner: lead.owner },
    enquirySourceLabel(input.source),
  );
  return { received: true };
}

// ── Staff: the personal application link ────────────────────────────────────

/**
 * A new link for this family. Issuing one replaces the previous link, so a link
 * sent to the wrong number can be killed by sending a new one.
 */
export async function issueApplicationLink(leadId: string, actor: Actor, now = new Date()) {
  const lead = await findScopedLead(leadId);
  if (lead.status === 'enrolled' || lead.status === 'lost') {
    throw new AdmissionError(409, 'APPLICATION_CLOSED', `This family is ${lead.status === 'enrolled' ? 'already admitted' : 'marked as lost'}.`);
  }
  const token = newApplicationToken();
  const expiresAt = new Date(now.getTime() + APPLICATION_LINK_DAYS * DAY);
  lead.application.tokenHash = hashToken(token);
  lead.application.tokenIssuedAt = now;
  lead.application.tokenExpiresAt = expiresAt;
  if (!lead.admission?.session) lead.set('admission.session', currentAdmissionSession());
  pushNote(lead, `Application link created (valid until ${expiresAt.toISOString().slice(0, 10)})`, now, actor);
  await lead.save();
  await logAudit(actor.id, 'admissions.application.link', String(lead._id));
  return { token, expiresAt };
}

// ── Public: the application form behind the link ────────────────────────────

async function findLeadByToken(token: string, now = new Date()): Promise<ILead> {
  if (!token) throw linkInvalid();
  const lead = await Lead.findOne({ ...requireTenantScope('admissions:application'), 'application.tokenHash': hashToken(token) });
  const expires = lead?.application?.tokenExpiresAt ? new Date(lead.application.tokenExpiresAt).getTime() : 0;
  if (!lead || expires < now.getTime()) throw linkInvalid();
  return lead;
}

const linkInvalid = () =>
  new AdmissionError(404, 'APPLICATION_LINK_INVALID', 'This application link has expired or is no longer valid. Please ask the admissions team for a new one.');

/** What the family sees: their own form and where their admission stands. */
function publicStatus(status: LeadStatus): 'open' | 'submitted' | 'waitlisted' | 'offered' | 'enrolled' | 'closed' {
  if (status === 'enrolled') return 'enrolled';
  if (status === 'offered') return 'offered';
  if (status === 'waitlisted') return 'waitlisted';
  if (status === 'lost') return 'closed';
  if (status === 'applied') return 'submitted';
  return 'open';
}

export function applicationView(lead: ILead) {
  const app = lead.application || ({} as ILead['application']);
  const status = publicStatus(lead.status);
  const offered = status === 'offered' || status === 'enrolled';
  return {
    session: lead.admission?.session || currentAdmissionSession(),
    classLevel: lead.admission?.classLevel ?? null,
    stream: lead.admission?.stream || '',
    status: status === 'open' && app.submittedAt ? 'submitted' : status,
    editable: !APPLICATION_CLOSED.includes(lead.status),
    submittedAt: app.submittedAt || null,
    registrationId: app.registrationId || '',
    prefill: {
      student: { name: lead.student?.name || '', school: lead.student?.school || '', board: lead.student?.board || '', currentClass: lead.student?.classLevel ?? null },
      primary: { name: lead.guardian?.name || '', phone: lead.phone, email: lead.email || '' },
    },
    application: app.data || null,
    documents: (app.documents || []).map((d) => ({ id: String(d._id), kind: d.kind, fileName: d.fileName, size: d.size, uploadedAt: d.uploadedAt })),
    offer: offered && lead.offer?.offeredAt
      ? { classLevel: lead.offer.classLevel, stream: lead.offer.stream || '', batch: lead.offer.batch || '', feeNote: lead.offer.feeNote || '', holdUntil: lead.offer.holdUntil || null }
      : null,
  };
}

export async function getApplication(token: string, now = new Date()) {
  return applicationView(await findLeadByToken(token, now));
}

async function uniqueRegistrationId(session: string, classLevel: number): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const id = generateRegistrationId(session, classLevel);
    if (!(await Lead.exists({ ...requireTenantScope('admissions:registration-id'), 'application.registrationId': id }))) return id;
  }
  throw new AdmissionError(500, 'REGISTRATION_ID_FAILED', 'Could not issue a registration ID. Please try again.');
}

export async function submitApplication(token: string, input: ApplicationInput, now = new Date()) {
  const lead = await findLeadByToken(token, now);
  if (APPLICATION_CLOSED.includes(lead.status)) {
    throw new AdmissionError(409, 'APPLICATION_LOCKED', 'This application can no longer be changed. Please contact the admissions team.');
  }
  const first = !lead.application.submittedAt;
  const session = lead.admission?.session || currentAdmissionSession();
  const { data } = input;

  lead.application.data = data;
  lead.application.submittedAt = now;
  lead.application.consentAt = now;
  lead.application.consentVersion = APPLICATION_CONSENT_VERSION;
  if (!lead.application.registrationId) lead.application.registrationId = await uniqueRegistrationId(session, input.classLevel);
  lead.set('admission', { session, classLevel: input.classLevel, stream: input.stream });
  lead.set('student.name', data.student.name);
  if (data.student.school) lead.set('student.school', data.student.school);
  if (data.student.board) lead.set('student.board', data.student.board);
  if (!lead.studentNames.includes(data.student.name)) lead.studentNames.push(data.student.name);
  if (data.primary.name) lead.set('guardian.name', data.primary.name);
  if (data.primary.email && !lead.email) lead.email = data.primary.email;
  if (!lead.channels.includes('application')) lead.channels.push('application');

  if (PRE_APPLIED.includes(lead.status)) pushHistory(lead, 'applied', now, 'Application submitted');
  pushNote(lead, first ? `Application submitted — ${classLabel(input.classLevel, input.stream)}` : 'Application updated by the family', now);

  try {
    await lead.save();
  } catch (err: any) {
    // Two submissions racing for the same new ID: issue another and retry once.
    if (err?.code !== 11000 || !first) throw err;
    lead.application.registrationId = await uniqueRegistrationId(session, input.classLevel);
    await lead.save();
  }
  if (first) void notifyAdmissionsStaff('application', lead);
  return applicationView(lead);
}

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export async function addApplicationDocument(token: string, file: UploadedFile | undefined, kind: string, now = new Date()) {
  const lead = await findLeadByToken(token, now);
  if (lead.status === 'enrolled' || lead.status === 'lost') {
    throw new AdmissionError(409, 'APPLICATION_LOCKED', 'Documents can no longer be added here. Please bring them to the centre.');
  }
  if (!file || !file.buffer?.length) throw new AdmissionError(400, 'FILE_REQUIRED', 'Choose a file to upload.', { file: 'Choose a file' });
  if (file.size > MAX_DOCUMENT_BYTES) throw new AdmissionError(413, 'FILE_TOO_LARGE', 'Files must be 5 MB or smaller.', { file: 'Files must be 5 MB or smaller' });
  if ((lead.application.documents || []).length >= MAX_DOCUMENTS) {
    throw new AdmissionError(409, 'TOO_MANY_DOCUMENTS', `At most ${MAX_DOCUMENTS} documents can be uploaded. Remove one first.`);
  }
  const stored = await putTenantFile({
    buffer: file.buffer,
    fileName: file.originalname || 'document',
    contentType: file.mimetype,
    module: 'admissions',
    entityId: String(lead._id),
  });
  lead.application.documents.push({
    kind,
    storagePath: stored.storagePath,
    fileName: String(file.originalname || 'document').slice(0, 160),
    contentType: file.mimetype,
    size: file.size,
    uploadedAt: now,
  });
  await lead.save();
  return applicationView(lead).documents;
}

export async function removeApplicationDocument(token: string, documentId: string, now = new Date()) {
  const lead = await findLeadByToken(token, now);
  if (APPLICATION_CLOSED.includes(lead.status)) {
    throw new AdmissionError(409, 'APPLICATION_LOCKED', 'Documents can no longer be changed here. Please contact the admissions team.');
  }
  const doc = Types.ObjectId.isValid(documentId) ? (lead.application.documents as any).id(documentId) : null;
  if (!doc) throw new AdmissionError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
  const path = doc.storagePath;
  doc.deleteOne();
  await lead.save();
  await deleteTenantFile(path).catch((err) => console.error('[admissions] could not delete document:', (err as Error)?.message));
  return applicationView(lead).documents;
}

/** The public fee-structure lookup: enough to show the class's fees, nothing personal. */
export async function lookupRegistration(registrationId: string) {
  const lead = registrationId
    ? await Lead.findOne({ ...requireTenantScope('admissions:registration-lookup'), 'application.registrationId': registrationId })
        .select('student.name admission status application.registrationId offer')
        .lean()
    : null;
  if (!lead) throw new AdmissionError(404, 'REGISTRATION_NOT_FOUND', 'Registration ID not found. Please check it and try again.');
  const status = publicStatus(lead.status as LeadStatus);
  return {
    registrationId,
    studentName: lead.student?.name || '',
    session: lead.admission?.session || '',
    classLevel: lead.offer?.classLevel || lead.admission?.classLevel || null,
    stream: lead.offer?.stream || lead.admission?.stream || '',
    status: status === 'open' ? 'submitted' : status,
  };
}

// ── Staff: the decisions ────────────────────────────────────────────────────

export async function assignOwner(leadId: string, owner: 'me' | 'none' | string, actor: Actor, now = new Date()) {
  const lead = await findScopedLead(leadId);
  if (owner === 'none') {
    lead.set('owner', { id: null, name: '' });
    pushNote(lead, 'Owner cleared', now, actor);
  } else {
    const id = owner === 'me' ? actor.id : owner;
    const user = id && Types.ObjectId.isValid(id)
      ? await User.findOne({ _id: new Types.ObjectId(id), ...requireTenantScope('admissions:owner'), role: { $nin: ['student', 'parent'] } }).select('name').lean()
      : null;
    if (!user) throw new AdmissionError(400, 'OWNER_INVALID', 'Choose a staff member of this institute.', { owner: 'Not a staff member' });
    lead.set('owner', { id: user._id, name: String((user as any).name || '').slice(0, 80) });
    pushNote(lead, `Owner set to ${(user as any).name || 'staff member'}`, now, actor);
  }
  await lead.save();
  await logAudit(actor.id, 'admissions.lead.owner', String(lead._id), { owner: lead.owner?.id ? String(lead.owner.id) : null });
  return staffLeadView(lead);
}

/** Seats taken in a session: confirmed admissions, and offers still on hold. */
async function seatUsage(session: string, now: Date, excludeLeadId?: unknown) {
  const rows = await Lead.find({
    ...requireTenantScope('admissions:seat-usage'),
    'admission.session': session,
    status: { $in: ['enrolled', 'offered'] },
    ...(excludeLeadId ? { _id: { $ne: excludeLeadId } } : {}),
  })
    .select('status admission offer')
    .lean();
  const enrolled = new Map<string, number>();
  const held = new Map<string, number>();
  for (const lead of rows as any[]) {
    const classLevel = lead.offer?.classLevel || lead.admission?.classLevel;
    if (!classLevel) continue;
    const key = seatKey(classLevel, lead.offer?.stream || lead.admission?.stream);
    if (lead.status === 'enrolled') enrolled.set(key, (enrolled.get(key) || 0) + 1);
    else if (lead.offer?.holdUntil && new Date(lead.offer.holdUntil).getTime() >= now.getTime()) held.set(key, (held.get(key) || 0) + 1);
  }
  return { enrolled, held };
}

export async function makeOffer(leadId: string, input: OfferInput, actor: Actor, now = new Date()) {
  const lead = await findScopedLead(leadId);
  if (lead.status === 'enrolled') throw new AdmissionError(409, 'ALREADY_ENROLLED', 'This student is already admitted.');
  const session = lead.admission?.session || currentAdmissionSession();

  const seat = await AdmissionSeat.findOne({
    ...requireTenantScope('admissions:seat'),
    session,
    classLevel: input.classLevel,
    stream: input.stream,
  }).lean();
  if (seat && !input.overrideCapacity) {
    const usage = await seatUsage(session, now, lead._id);
    const key = seatKey(input.classLevel, input.stream);
    if (seatsLeft(seat.capacity, usage.enrolled.get(key) || 0, usage.held.get(key) || 0) <= 0) {
      throw new AdmissionError(
        409,
        'SEATS_FULL',
        `${classLabel(input.classLevel, input.stream)} is full for ${session}. Put the family on the waitlist, or offer the seat anyway.`,
      );
    }
  }

  const holdUntil = new Date(now.getTime() + input.holdDays * DAY);
  holdUntil.setHours(23, 59, 59, 999);
  lead.set('offer', {
    classLevel: input.classLevel,
    stream: input.stream,
    batch: input.batch,
    feeNote: input.feeNote,
    offeredAt: now,
    holdUntil,
    byName: actorName(actor),
  });
  lead.set('admission', { session, classLevel: input.classLevel, stream: input.stream });
  // The family follows the offer through the same link, so it outlives the hold.
  if (lead.application?.tokenHash) {
    const keepUntil = holdUntil.getTime() + 14 * DAY;
    const current = lead.application.tokenExpiresAt ? new Date(lead.application.tokenExpiresAt).getTime() : 0;
    if (current < keepUntil) lead.application.tokenExpiresAt = new Date(keepUntil);
  }
  const summary = `Seat offered: ${classLabel(input.classLevel, input.stream)}${input.batch ? `, ${input.batch}` : ''}, held until ${holdUntil.toISOString().slice(0, 10)}${input.overrideCapacity ? ' (over capacity)' : ''}`;
  pushHistory(lead, 'offered', now, input.note || summary, actor);
  pushNote(lead, input.note ? `${summary}. ${input.note}` : summary, now, actor);
  await lead.save();
  await logAudit(actor.id, 'admissions.lead.offer', String(lead._id), { classLevel: input.classLevel, stream: input.stream, override: input.overrideCapacity });
  return staffLeadView(lead);
}

export async function waitlistLead(leadId: string, note: string, actor: Actor, now = new Date()) {
  const lead = await findScopedLead(leadId);
  if (lead.status === 'enrolled') throw new AdmissionError(409, 'ALREADY_ENROLLED', 'This student is already admitted.');
  if (lead.offer?.holdUntil) {
    lead.set('offer.holdUntil', null);
    pushNote(lead, 'Seat hold released', now, actor);
  }
  pushHistory(lead, 'waitlisted', now, note || 'Waitlisted', actor);
  if (note) pushNote(lead, `Waitlisted: ${note}`, now, actor);
  await lead.save();
  await logAudit(actor.id, 'admissions.lead.waitlist', String(lead._id));
  return staffLeadView(lead);
}

export interface CreatedAccount {
  id: string;
  email: string;
  empCode: string;
  classLevel: string;
  batch: string;
  /** Present only when the system generated it — shown once, never stored in clear. */
  password?: string;
}

async function createStudentAccount(lead: ILead, classLevel: number, account: AccountInput, actor: Actor): Promise<CreatedAccount> {
  let resolved: { classLevel: string; batch: string };
  try {
    resolved = await resolveStudentClassAndBatch(String(classLevel), account.batch);
  } catch (err) {
    throw new AdmissionError(400, 'ACCOUNT_INVALID', (err as Error).message, { 'account.batch': (err as Error).message });
  }
  if (await takenAnywhere('email', account.email)) {
    throw new AdmissionError(409, 'EMAIL_TAKEN', 'That email already has an account.', { 'account.email': 'Already in use' });
  }
  if (await takenAnywhere('empCode', account.empCode)) {
    throw new AdmissionError(409, 'EMPCODE_TAKEN', 'That roll number is already used by another account.', { 'account.empCode': 'Already in use' });
  }
  const password = account.password || generatePassword();
  const name = lead.application?.data?.student?.name || lead.student?.name;
  // The family's number on the account is what lets a parent link to this
  // student from the app (student code + this phone; core/guardians).
  const phone = lead.application?.data?.primary?.phone || lead.phone;
  const user = await withCapacity({
    orgId: currentTenantOrgId(),
    resource: seatOf({ role: 'student', status: 'approved' }) as SeatResource,
    run: () =>
      User.create({
        name,
        email: account.email,
        password,
        role: 'student',
        classLevel: resolved.classLevel,
        batch: resolved.batch,
        empCode: account.empCode,
        phone,
        registrationSource: 'admin',
      }),
  });
  await logAudit(actor.id, 'admin.user.create', String(user._id), { name, email: account.email, role: 'student', empCode: account.empCode, via: 'admissions', leadId: String(lead._id) });
  return {
    id: String(user._id),
    email: account.email,
    empCode: account.empCode,
    classLevel: resolved.classLevel,
    batch: resolved.batch,
    ...(account.password ? {} : { password }),
  };
}

/**
 * Confirm an admission: the payment is recorded and, when asked (and the staff
 * member may create student accounts), the student's login is created from the
 * application — nobody retypes the name, class or family phone.
 */
export async function recordEnrolment(
  leadId: string,
  input: EnrolmentInput,
  actor: Actor,
  mayCreateAccount: boolean,
  now = new Date(),
) {
  const lead = await findScopedLead(leadId);
  if (lead.status === 'enrolled') throw new AdmissionError(409, 'ALREADY_ENROLLED', 'This student is already admitted.');
  const classLevel = lead.offer?.classLevel || lead.admission?.classLevel;
  if (!classLevel) throw new AdmissionError(409, 'CLASS_REQUIRED', 'Offer a seat (class and stream) before confirming the admission.');
  if (input.account && !mayCreateAccount) {
    throw new AdmissionError(403, 'PERMISSION_DENIED', 'You do not have permission to create student accounts.');
  }

  const account = input.account ? await createStudentAccount(lead, classLevel, input.account, actor) : null;

  lead.set('enrolment', {
    paidAt: input.paidAt,
    amount: input.amount,
    mode: input.mode,
    receiptNo: input.receiptNo,
    recordedAt: now,
    byName: actorName(actor),
    studentUserId: account ? new Types.ObjectId(account.id) : null,
    empCode: account?.empCode || '',
  });
  if (!lead.admission?.session) lead.set('admission.session', currentAdmissionSession());
  const paid = input.amount !== null ? `₹${input.amount.toLocaleString('en-IN')} by ${input.mode.replace('_', ' ')}` : `paid by ${input.mode.replace('_', ' ')}`;
  const summary = `Admission confirmed — ${classLabel(classLevel, lead.offer?.stream || lead.admission?.stream)}, ${paid}${input.receiptNo ? `, receipt ${input.receiptNo}` : ''}${account ? `; student login ${account.empCode}` : ''}`;
  pushHistory(lead, 'enrolled', now, input.note || summary, actor);
  pushNote(lead, input.note ? `${summary}. ${input.note}` : summary, now, actor);
  await lead.save();
  await logAudit(actor.id, 'admissions.lead.enrol', String(lead._id), { account: account?.id || null });
  return { lead: staffLeadView(lead), account };
}

export async function documentUrl(leadId: string, documentId: string) {
  const lead = await findScopedLead(leadId);
  const doc = Types.ObjectId.isValid(documentId) ? (lead.application?.documents as any)?.id(documentId) : null;
  if (!doc) throw new AdmissionError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
  const url = await signedUrlForTenantPath(doc.storagePath, { ttlMs: 10 * 60 * 1000 });
  return { url, fileName: doc.fileName, contentType: doc.contentType };
}

// ── Seats ───────────────────────────────────────────────────────────────────

export async function getSeatTable(session: string, now = new Date()) {
  const [seats, usage] = await Promise.all([
    AdmissionSeat.find({ ...requireTenantScope('admissions:seats'), session }).sort({ classLevel: 1, stream: 1 }).lean(),
    seatUsage(session, now),
  ]);
  const rows = seats.map((s) => {
    const key = seatKey(s.classLevel, s.stream);
    const enrolled = usage.enrolled.get(key) || 0;
    const held = usage.held.get(key) || 0;
    return { classLevel: s.classLevel, stream: s.stream || '', capacity: s.capacity, enrolled, held, left: seatsLeft(s.capacity, enrolled, held) };
  });
  return { session, configured: rows.length > 0, rows };
}

/** Replace a session's capacity table with exactly these rows. */
export async function saveSeatTable(session: string, rows: SeatRow[], actor: Actor) {
  const scope = requireTenantScope('admissions:seats-save');
  for (const row of rows) {
    await AdmissionSeat.findOneAndUpdate(
      { ...scope, session, classLevel: row.classLevel, stream: row.stream },
      { $set: { capacity: row.capacity, updatedByName: actorName(actor) } },
      { upsert: true, setDefaultsOnInsert: true, runValidators: true },
    );
  }
  const keep = rows.map((r) => ({ classLevel: r.classLevel, stream: r.stream }));
  await AdmissionSeat.deleteMany({ ...scope, session, ...(keep.length ? { $nor: keep } : {}) });
  await logAudit(actor.id, 'admissions.seats.save', session, { rows: rows.length });
  return getSeatTable(session);
}

/** What the public site shows: only classes with seats configured. */
export async function publicSeats(now = new Date()) {
  const session = currentAdmissionSession();
  const table = await getSeatTable(session, now);
  const rows = table.rows.filter((r) => r.capacity > 0).map((r) => ({ classLevel: r.classLevel, stream: r.stream, capacity: r.capacity, left: r.left }));
  return { session, configured: rows.length > 0, rows, totalLeft: rows.reduce((sum, r) => sum + r.left, 0) };
}

// ── Funnel ──────────────────────────────────────────────────────────────────

export const FUNNEL_STAGES = ['enquired', 'agts', 'counselled', 'applied', 'offered', 'enrolled'] as const;

const COUNSELLED_OR_LATER = new Set(['counselling', 'applied', 'offered', 'waitlisted', 'enrolled']);
const APPLIED_OR_LATER = new Set(['applied', 'offered', 'waitlisted', 'enrolled']);
const OFFERED_OR_LATER = new Set(['offered', 'enrolled']);

/** How far each class's families got this session, and where they stopped. */
export async function funnel(session: string) {
  const leads = await Lead.find({ ...requireTenantScope('admissions:funnel'), 'admission.session': session })
    .select('status statusHistory.to agts.completedCount application.submittedAt admission')
    .limit(20000)
    .lean();

  const rows = new Map<string, { classLevel: number | null; stream: string; counts: Record<string, number> }>();
  const blank = () => Object.fromEntries([...FUNNEL_STAGES, 'waitlisted', 'lost'].map((s) => [s, 0])) as Record<string, number>;

  for (const lead of leads as any[]) {
    const classLevel = lead.admission?.classLevel || null;
    const stream = classLevel && needsStream(classLevel) ? lead.admission?.stream || '' : '';
    const key = classLevel ? seatKey(classLevel, stream) : 'unknown';
    if (!rows.has(key)) rows.set(key, { classLevel, stream, counts: blank() });
    const counts = rows.get(key)!.counts;
    const seen = new Set<string>([lead.status, ...(lead.statusHistory || []).map((h: any) => h.to)]);
    const any = (set: Set<string>) => [...seen].some((s) => set.has(s));

    counts.enquired += 1;
    if ((lead.agts?.completedCount || 0) > 0) counts.agts += 1;
    if (any(COUNSELLED_OR_LATER)) counts.counselled += 1;
    if (lead.application?.submittedAt || any(APPLIED_OR_LATER)) counts.applied += 1;
    if (any(OFFERED_OR_LATER)) counts.offered += 1;
    if (seen.has('enrolled')) counts.enrolled += 1;
    if (lead.status === 'waitlisted') counts.waitlisted += 1;
    if (lead.status === 'lost') counts.lost += 1;
  }

  const ordered = [...rows.values()].sort((a, b) => (a.classLevel ?? 99) - (b.classLevel ?? 99) || a.stream.localeCompare(b.stream));
  const total = blank();
  for (const row of ordered) for (const k of Object.keys(total)) total[k] += row.counts[k];
  return { session, stages: FUNNEL_STAGES, rows: ordered, total };
}
