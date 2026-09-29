/**
 * Lead service — one prospective family per phone number per organization.
 *
 * ── Duplicate protection ────────────────────────────────────────────────────
 * Leads are written with a single atomic upsert keyed on the normalized phone
 * number, backed by the unique `{orgId, phoneNormalized}` index. Two
 * registrations racing for a new number both upsert; the loser's E11000 is
 * retried once as an update. Where indexes are not auto-built (legacy
 * database mode, see core/tenancy/dataSource), the upsert alone still prevents
 * sequential duplicates; build the index with the index CLI before launch.
 *
 * ── Lifecycle ───────────────────────────────────────────────────────────────
 * new → contacted → qualified → agts_completed → counselling → follow_up →
 * enrolled, plus lost and nurture. The ONLY automatic move is to
 * `agts_completed`, and only from a status before it in the pipeline — a
 * completed test is a fact, not a decision. Counselling, enrolment and loss
 * are always a person's call.
 */

import { Types } from 'mongoose';
import Lead, { type ILead, type LeadStatus, type AgtsResultSnapshot } from '../../models/Lead';
import ScholarshipAttempt from '../../models/ScholarshipAttempt';
import { requireTenantScope } from '../../core/tenancy';
import { logAudit } from '../../utils/logger';
import { attemptDisplayName } from './agtsNaming';
import {
  CONSENT_TEXT,
  CONSENT_VERSION,
  escapeRegex,
  type LeadListQuery,
  type RegistrationInput,
} from './agtsValidation';

export class LeadNotFound extends Error {
  status = 404;
  code = 'LEAD_NOT_FOUND';
  constructor() {
    super('Lead not found');
  }
}

export interface Actor {
  id?: string;
  name?: string;
}

const actorId = (actor?: Actor) => (actor?.id && Types.ObjectId.isValid(actor.id) ? new Types.ObjectId(actor.id) : undefined);
const actorName = (actor?: Actor) => String(actor?.name || '').slice(0, 80);

/** Statuses a completed AGTS test may advance from. Anything later is left alone. */
const PRE_AGTS_STATUSES: LeadStatus[] = ['new', 'contacted', 'qualified'];

// ── Public writes ───────────────────────────────────────────────────────────

/**
 * Create or update the lead for a registration. Contact details and consent
 * are refreshed on every registration (the latest is the most accurate);
 * status, notes and history are never touched here.
 */
export async function upsertLeadFromRegistration(input: RegistrationInput, now = new Date()): Promise<ILead> {
  const touch = input.attribution ? { ...input.attribution, capturedAt: now } : null;
  const set: Record<string, unknown> = {
    phone: input.phone,
    'student.name': input.studentName,
    'student.classLevel': input.classLevel,
    'guardian.name': input.guardianName,
    consent: { contact: true, version: CONSENT_VERSION, text: CONSENT_TEXT, grantedAt: now, channel: 'agts' },
  };
  // Optional fields only overwrite when supplied, so a second, sparser
  // registration does not erase a school or email the first one gave.
  if (input.email) set.email = input.email;
  if (input.school) set['student.school'] = input.school;
  if (input.board) set['student.board'] = input.board;
  if (touch) set['attribution.last'] = touch;

  const setOnInsert: Record<string, unknown> = {
    status: 'new',
    statusHistory: [{ to: 'new', at: now, automatic: true, note: 'Registered for AGTS' }],
  };
  if (touch) setOnInsert['attribution.first'] = touch;

  const update = {
    $set: set,
    $setOnInsert: setOnInsert,
    $addToSet: { channels: 'agts', studentNames: input.studentName },
  };

  const run = () =>
    Lead.findOneAndUpdate({ phoneNormalized: input.phoneNormalized }, update, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      runValidators: true,
    });

  try {
    return (await run()) as ILead;
  } catch (err: any) {
    if (err?.code === 11000) return (await run()) as ILead; // lost the insert race — now an update
    throw err;
  }
}

/** Count a newly started attempt against the lead. */
export async function recordAttemptStarted(leadId: Types.ObjectId, now = new Date()): Promise<void> {
  await Lead.updateOne(
    { _id: leadId },
    {
      $inc: { 'agts.attemptCount': 1 },
      $set: { 'agts.lastAttemptAt': now },
      $min: { 'agts.firstAttemptAt': now },
    },
  );
}

/**
 * Record a graded AGTS result on its lead: latest snapshot, completed count,
 * and the one automatic lifecycle step.
 */
export async function recordAgtsResult(leadId: Types.ObjectId, snapshot: AgtsResultSnapshot, now = new Date()): Promise<void> {
  await Lead.updateOne(
    { _id: leadId },
    {
      $set: { 'agts.latest': snapshot, 'agts.lastAttemptAt': snapshot.submittedAt || now },
      $inc: { 'agts.completedCount': 1 },
    },
  );
  // A separate write, conditional on the status it read, so a lead already in
  // counselling, enrolled or lost is never moved backwards by a new test — and
  // a concurrent admin change wins over this automatic one.
  const current = await Lead.findById(leadId).select('status').lean();
  if (current && PRE_AGTS_STATUSES.includes(current.status as LeadStatus)) {
    await Lead.updateOne(
      { _id: leadId, status: current.status },
      {
        $set: { status: 'agts_completed' },
        $push: { statusHistory: { from: current.status, to: 'agts_completed', at: now, automatic: true, note: 'AGTS test completed' } },
      },
    );
  }
}

/** The family asked for academic guidance from the result page. */
export async function recordGuidanceRequest(
  leadId: Types.ObjectId,
  input: { preferredTime: string; message: string; attemptId: string },
  now = new Date(),
): Promise<void> {
  const lead = await Lead.findById(leadId).select('guidance').lean();
  if (!lead) throw new LeadNotFound();
  // A double-click or a reload inside ten minutes is the same request.
  const last = lead.guidance?.requestedAt ? new Date(lead.guidance.requestedAt).getTime() : 0;
  const repeat = lead.guidance?.requested && now.getTime() - last < 10 * 60 * 1000;
  await Lead.updateOne(
    { _id: leadId },
    {
      $set: {
        'guidance.requested': true,
        'guidance.requestedAt': now,
        'guidance.preferredTime': input.preferredTime,
        'guidance.message': input.message,
        'guidance.attemptId': input.attemptId,
      },
      ...(repeat ? {} : { $inc: { 'guidance.count': 1 } }),
    },
  );
}

// ── Admin reads ─────────────────────────────────────────────────────────────

const LIST_PROJECTION =
  'phone email student studentNames guardian status consent.contact consent.grantedAt agts followUpAt lastContactedAt lastContactChannel guidance.requested guidance.requestedAt guidance.preferredTime attribution.first.source attribution.first.medium attribution.first.campaign createdAt updatedAt';

function listFilter(query: LeadListQuery, now = new Date()): Record<string, unknown> {
  const filter: Record<string, unknown> = { ...requireTenantScope('agts:leads'), channels: 'agts' };
  if (query.status) filter.status = query.status;
  if (query.classLevel) filter['student.classLevel'] = query.classLevel;
  if (query.guidance) filter['guidance.requested'] = true;
  if (query.from || query.to) {
    const range: Record<string, Date> = {};
    if (query.from) range.$gte = query.from;
    if (query.to) range.$lte = query.to;
    filter['agts.lastAttemptAt'] = range;
  }
  if (query.followUp === 'due') {
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    filter.followUpAt = { $ne: null, $lte: endOfToday };
  } else if (query.followUp === 'upcoming') {
    filter.followUpAt = { $gt: now };
  } else if (query.followUp === 'none') {
    filter.followUpAt = null;
  }
  if (query.search) {
    const digits = query.search.replace(/\D/g, '');
    const rx = new RegExp(escapeRegex(query.search), 'i');
    const or: Record<string, unknown>[] = [
      { 'student.name': rx },
      { studentNames: rx },
      { 'guardian.name': rx },
      { email: rx },
      { 'student.school': rx },
    ];
    if (digits.length >= 3) or.push({ phoneNormalized: new RegExp(escapeRegex(digits)) });
    filter.$or = or;
  }
  return filter;
}

const SORTS: Record<LeadListQuery['sort'], Record<string, 1 | -1>> = {
  recent: { updatedAt: -1 },
  created: { createdAt: -1 },
  score: { 'agts.latest.percentage': -1, updatedAt: -1 },
  followup: { followUpAt: 1, updatedAt: -1 },
};

export async function listLeads(query: LeadListQuery, now = new Date()) {
  const filter = listFilter(query, now);
  const skip = (query.page - 1) * query.limit;
  // Sorting by follow-up date is the follow-up queue: without an explicit
  // follow-up filter it lists only leads that have a date set.
  const sortFilter =
    query.sort === 'followup' && !('followUpAt' in filter) ? { ...filter, followUpAt: { $ne: null } } : filter;

  const [items, total, counts, due, guidance] = await Promise.all([
    Lead.find(sortFilter).select(LIST_PROJECTION).sort(SORTS[query.sort]).skip(skip).limit(query.limit).lean(),
    Lead.countDocuments(sortFilter),
    Lead.aggregate([{ $match: { ...requireTenantScope('agts:leads'), channels: 'agts' } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Lead.countDocuments(listFilter({ page: 1, limit: 1, sort: 'recent', followUp: 'due' }, now)),
    Lead.countDocuments(listFilter({ page: 1, limit: 1, sort: 'recent', guidance: true }, now)),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of counts as Array<{ _id: string; n: number }>) byStatus[row._id] = row.n;

  return {
    items,
    total,
    page: query.page,
    pages: Math.max(1, Math.ceil(total / query.limit)),
    summary: {
      byStatus,
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      followUpsDue: due,
      guidanceRequests: guidance,
    },
  };
}

async function findScopedLead(leadId: string) {
  if (!Types.ObjectId.isValid(leadId)) throw new LeadNotFound();
  const lead = await Lead.findOne({ _id: new Types.ObjectId(leadId), ...requireTenantScope('agts:lead') });
  if (!lead) throw new LeadNotFound();
  return lead;
}

const ATTEMPT_SUMMARY =
  'attemptId scholarshipTestName classLevel status startedAt submittedAt durationMins totalScore maxScore scoring submitReason autoSubmitted program name';

export async function getLead(leadId: string) {
  const lead = await findScopedLead(leadId);
  const attempts = await ScholarshipAttempt.find({ leadId: lead._id, ...requireTenantScope('agts:lead-attempts') })
    .select(`${ATTEMPT_SUMMARY} questions`)
    .sort({ startedAt: -1 })
    .limit(50)
    .lean();
  return {
    lead: lead.toObject(),
    attempts: attempts.map(({ questions, ...attempt }: any) => ({
      ...attempt,
      displayName: attemptDisplayName({ ...attempt, questions }),
      questionCount: Array.isArray(questions) ? questions.length : 0,
    })),
  };
}

export async function assertAttemptOfLead(leadId: string, attemptId: string) {
  const lead = await findScopedLead(leadId);
  const attempt = await ScholarshipAttempt.findOne({
    attemptId: String(attemptId || '').slice(0, 40),
    leadId: lead._id,
    ...requireTenantScope('agts:lead-attempt'),
  });
  if (!attempt) {
    const err: any = new Error('Attempt not found for this lead');
    err.status = 404;
    err.code = 'ATTEMPT_NOT_FOUND';
    throw err;
  }
  return { lead, attempt };
}

// ── Admin writes ────────────────────────────────────────────────────────────

export async function updateLeadStatus(leadId: string, status: LeadStatus, note: string, actor: Actor) {
  const lead = await findScopedLead(leadId);
  const from = lead.status;
  const now = new Date();
  lead.status = status;
  lead.statusHistory.push({ from, to: status, at: now, by: actorId(actor), byName: actorName(actor), note: note.slice(0, 500) });
  if (note) lead.notes.push({ text: `Status → ${status}: ${note}`, at: now, by: actorId(actor), byName: actorName(actor) });
  await lead.save();
  await logAudit(actor.id, 'agts.lead.status', String(lead._id), { from, to: status });
  return lead.toObject();
}

export async function addLeadNote(leadId: string, text: string, actor: Actor) {
  const lead = await findScopedLead(leadId);
  lead.notes.push({ text, at: new Date(), by: actorId(actor), byName: actorName(actor) });
  if (lead.notes.length > 500) lead.notes.splice(0, lead.notes.length - 500);
  await lead.save();
  await logAudit(actor.id, 'agts.lead.note', String(lead._id));
  return lead.toObject();
}

export async function setLeadFollowUp(leadId: string, followUpAt: Date | null, note: string, actor: Actor) {
  const lead = await findScopedLead(leadId);
  lead.followUpAt = followUpAt;
  const when = followUpAt ? followUpAt.toISOString().slice(0, 10) : 'cleared';
  lead.notes.push({
    text: `Follow-up ${followUpAt ? `set for ${when}` : 'cleared'}${note ? `: ${note}` : ''}`,
    at: new Date(),
    by: actorId(actor),
    byName: actorName(actor),
  });
  await lead.save();
  await logAudit(actor.id, 'agts.lead.follow-up', String(lead._id), { followUpAt: followUpAt ? followUpAt.toISOString() : null });
  return lead.toObject();
}

/** An admin opened a call or WhatsApp to the family. Status is NOT changed automatically. */
export async function logLeadContact(leadId: string, channel: string, actor: Actor) {
  const lead = await findScopedLead(leadId);
  const now = new Date();
  await Lead.updateOne(
    { _id: lead._id },
    {
      $set: { lastContactedAt: now, lastContactChannel: channel },
      $push: { contactLog: { $each: [{ channel, at: now, by: actorId(actor), byName: actorName(actor) }], $slice: -200 } },
    },
  );
  await logAudit(actor.id, 'agts.lead.contact', String(lead._id), { channel });
  return { lastContactedAt: now, lastContactChannel: channel };
}
