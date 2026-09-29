/**
 * AGTS input validation — pure, no database.
 *
 * Every public and admin AGTS input passes through one of these functions
 * before it reaches a service. Each one:
 *
 *  - reads an explicit allow-list of fields and ignores everything else, so a
 *    body carrying `score`, `status`, `orgId`, `owner` or `__proto__` can set
 *    nothing;
 *  - trims, strips control characters and caps every string;
 *  - returns field-level messages a form can show next to the input.
 *
 * Nothing here trusts the browser for anything that decides an outcome.
 */

import { CONTACT_CHANNELS, LEAD_STATUSES, type ContactChannel, type LeadStatus, type Touch } from '../../models/Lead';

export const AGTS_CLASS_LEVELS = [7, 8, 9, 10, 11, 12] as const;
export const AGTS_BOARDS = ['CBSE', 'GSEB', 'ICSE', 'State Board', 'Other'] as const;

/** Bump when the wording on the registration form changes. */
export const CONSENT_VERSION = '2026-09-28';
export const CONSENT_TEXT =
  'I agree that Abhigyan Gurukul may contact me by phone, SMS or WhatsApp about this AGTS result and academic guidance.';

export class AgtsValidationError extends Error {
  constructor(public readonly errors: Record<string, string>, message = 'Please check the highlighted fields.') {
    super(message);
    this.name = 'AgtsValidationError';
  }
}

// ── Primitive cleaners ──────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]/g;

export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).normalize('NFKC').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;

/**
 * Indian mobile numbers only: 10 digits starting 6–9, optionally prefixed by
 * +91, 91 or 0. Returns the bare 10 digits, or '' when invalid.
 */
export function normalizeIndianMobile(value: unknown): string {
  const digits = String(value ?? '').replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return '';
  let local = digits;
  if (local.length === 12 && local.startsWith('91')) local = local.slice(2);
  else if (local.length === 11 && local.startsWith('0')) local = local.slice(1);
  return /^[6-9]\d{9}$/.test(local) ? local : '';
}

const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

function readName(value: unknown, field: string, label: string, errors: Record<string, string>): string {
  const name = cleanText(value, 80);
  if (!name) errors[field] = `${label} is required`;
  else if (name.length < 2) errors[field] = `${label} is too short`;
  else if (!NAME_PATTERN.test(name)) errors[field] = `${label} can only contain letters, spaces, dots, apostrophes and hyphens`;
  return name;
}

// ── Attribution (UTM) ───────────────────────────────────────────────────────

const UTM_PATTERN = /^[\p{L}\p{N} _.~+:\-/%|]*$/u;

function cleanUtm(value: unknown): string {
  const text = cleanText(value, 100);
  return UTM_PATTERN.test(text) ? text : '';
}

/** Keep only the path of a landing page — never its query string or fragment. */
export function cleanLandingPage(value: unknown): string {
  const raw = cleanText(value, 400);
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://placeholder.invalid');
    const path = url.pathname.replace(/[^A-Za-z0-9/_\-.~]/g, '').slice(0, 200);
    return path.startsWith('/') ? path : `/${path}`;
  } catch {
    return '';
  }
}

/** Keep only the referring HOST — a full referrer URL can carry personal data. */
export function cleanReferrer(value: unknown): string {
  const raw = cleanText(value, 400);
  if (!raw) return '';
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return /^[a-z0-9.-]+$/.test(host) ? host.slice(0, 120) : '';
  } catch {
    return '';
  }
}

export function parseAttribution(input: unknown): Touch | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const src = input as Record<string, unknown>;
  const touch: Touch = {
    source: cleanUtm(src.source ?? src.utm_source),
    medium: cleanUtm(src.medium ?? src.utm_medium),
    campaign: cleanUtm(src.campaign ?? src.utm_campaign),
    content: cleanUtm(src.content ?? src.utm_content),
    term: cleanUtm(src.term ?? src.utm_term),
    landingPage: cleanLandingPage(src.landingPage),
    referrer: cleanReferrer(src.referrer),
  };
  const any = Object.values(touch).some((v) => Boolean(v));
  return any ? touch : null;
}

// ── Registration ────────────────────────────────────────────────────────────

export interface RegistrationInput {
  studentName: string;
  classLevel: number;
  guardianName: string;
  phone: string;
  phoneNormalized: string;
  email: string;
  school: string;
  board: string;
  consent: true;
  testRef: string;
  attribution: Touch | null;
}

export function validateRegistration(body: unknown): RegistrationInput {
  const src = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};

  const studentName = readName(src.studentName, 'studentName', 'Student name', errors);
  const guardianName = readName(src.guardianName, 'guardianName', 'Parent/guardian name', errors);

  const classLevel = Number(src.classLevel);
  if (!AGTS_CLASS_LEVELS.includes(classLevel as (typeof AGTS_CLASS_LEVELS)[number])) {
    errors.classLevel = 'Select a class between 7 and 12';
  }

  const phoneNormalized = normalizeIndianMobile(src.phone);
  if (!String(src.phone ?? '').trim()) errors.phone = 'Phone number is required';
  else if (!phoneNormalized) errors.phone = 'Enter a valid 10-digit Indian mobile number';

  const email = cleanText(src.email, 120).toLowerCase();
  if (email && !EMAIL_PATTERN.test(email)) errors.email = 'Enter a valid email address';

  const school = cleanText(src.school, 120);
  const boardRaw = cleanText(src.board, 40);
  const board = boardRaw ? AGTS_BOARDS.find((b) => b.toLowerCase() === boardRaw.toLowerCase()) || '' : '';
  if (boardRaw && !board) errors.board = 'Select a board from the list';

  // Consent must be the boolean `true`, not a truthy string a script might send.
  if (src.consent !== true) errors.consent = 'Please agree to be contacted about your result';

  // A test reference is a share-link slug or an ObjectId — nothing else.
  const testRef = cleanText(src.testRef ?? src.testId, 120);
  if (testRef && !/^[a-z0-9-]{1,120}$/i.test(testRef)) errors.testRef = 'Invalid test link';

  if (Object.keys(errors).length) throw new AgtsValidationError(errors);

  return {
    studentName,
    classLevel,
    guardianName,
    phone: phoneNormalized,
    phoneNormalized,
    email,
    school,
    board,
    consent: true,
    testRef,
    attribution: parseAttribution(src.attribution ?? src.utm),
  };
}

// ── Answers ─────────────────────────────────────────────────────────────────

export interface AnswerInput {
  questionId: string;
  /** '' clears the response (the question becomes "skipped"). */
  chosenOptionId: string;
  textAnswer: string;
  markedForReview: boolean;
}

const OBJECT_ID = /^[a-f0-9]{24}$/i;

/**
 * One answer. The value may be an option id string, a text/number answer, or
 * `{ chosenOptionId?, textAnswer?, markedForReview? }`. Any other key —
 * `isCorrect`, `marks`, `score` — is ignored.
 */
export function parseAnswer(questionId: unknown, value: unknown, markedForReview?: unknown): AnswerInput {
  const id = cleanText(questionId, 24);
  if (!OBJECT_ID.test(id)) throw new AgtsValidationError({ questionId: 'Invalid question' });

  let chosen = '';
  let text = '';
  let marked = typeof markedForReview === 'boolean' ? markedForReview : false;

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    chosen = cleanText(v.chosenOptionId, 24);
    text = cleanText(v.textAnswer, 500);
    if (typeof v.markedForReview === 'boolean') marked = v.markedForReview;
  } else if (typeof value === 'string' || typeof value === 'number') {
    const raw = cleanText(value, 500);
    if (OBJECT_ID.test(raw)) chosen = raw;
    else text = raw;
  } else if (value !== null && value !== undefined) {
    throw new AgtsValidationError({ answer: 'Invalid answer' });
  }

  if (chosen && !OBJECT_ID.test(chosen)) throw new AgtsValidationError({ answer: 'Invalid option' });
  return { questionId: id, chosenOptionId: chosen, textAnswer: text, markedForReview: marked };
}

/** A batch of answers, as a map or an array. Capped so a body cannot balloon. */
export function parseAnswerBatch(input: unknown, maxItems = 200): AnswerInput[] {
  const out: AnswerInput[] = [];
  if (Array.isArray(input)) {
    for (const item of input.slice(0, maxItems)) {
      if (!item || typeof item !== 'object') continue;
      const v = item as Record<string, unknown>;
      try {
        out.push(parseAnswer(v.questionId, v, v.markedForReview));
      } catch {
        /* drop malformed entries; the stored copy stays authoritative */
      }
    }
  } else if (input && typeof input === 'object') {
    for (const [questionId, value] of Object.entries(input as Record<string, unknown>).slice(0, maxItems)) {
      try {
        out.push(parseAnswer(questionId, value));
      } catch {
        /* as above */
      }
    }
  }
  return out;
}

// ── Guidance request ────────────────────────────────────────────────────────

export const GUIDANCE_TIMES = ['Morning (9am–12pm)', 'Afternoon (12pm–4pm)', 'Evening (4pm–8pm)', 'Any time'] as const;

export function validateGuidance(body: unknown): { preferredTime: string; message: string } {
  const src = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const timeRaw = cleanText(src.preferredTime, 60);
  const preferredTime = GUIDANCE_TIMES.find((t) => t === timeRaw) || (timeRaw ? '' : 'Any time');
  if (timeRaw && !preferredTime) throw new AgtsValidationError({ preferredTime: 'Choose a time from the list' });
  return { preferredTime, message: cleanText(src.message, 500) };
}

// ── Admin inputs ────────────────────────────────────────────────────────────

export function parseLeadStatus(value: unknown): LeadStatus {
  const status = cleanText(value, 30).toLowerCase() as LeadStatus;
  if (!LEAD_STATUSES.includes(status)) {
    throw new AgtsValidationError({ status: `Status must be one of: ${LEAD_STATUSES.join(', ')}` });
  }
  return status;
}

export function parseNote(value: unknown, field = 'text', required = true): string {
  const text = cleanText(value, 2000);
  if (required && !text) throw new AgtsValidationError({ [field]: 'Note cannot be empty' });
  return text;
}

/** A follow-up date: null clears it; otherwise within the next 18 months. */
export function parseFollowUp(value: unknown, now = new Date()): Date | null {
  if (value === null || value === '' || value === undefined) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new AgtsValidationError({ followUpAt: 'Invalid date' });
  const earliest = now.getTime() - 24 * 3600 * 1000;
  const latest = now.getTime() + 548 * 24 * 3600 * 1000;
  if (date.getTime() < earliest || date.getTime() > latest) {
    throw new AgtsValidationError({ followUpAt: 'Pick a date between today and the next 18 months' });
  }
  return date;
}

export function parseContactChannel(value: unknown): ContactChannel {
  const channel = cleanText(value, 20).toLowerCase() as ContactChannel;
  if (!CONTACT_CHANNELS.includes(channel)) {
    throw new AgtsValidationError({ channel: `Channel must be one of: ${CONTACT_CHANNELS.join(', ')}` });
  }
  return channel;
}

export interface LeadListQuery {
  status?: LeadStatus;
  classLevel?: number;
  search?: string;
  from?: Date;
  to?: Date;
  followUp?: 'due' | 'upcoming' | 'none';
  guidance?: boolean;
  page: number;
  limit: number;
  sort: 'recent' | 'score' | 'followup' | 'created';
}

export function parseLeadListQuery(query: Record<string, unknown>): LeadListQuery {
  const out: LeadListQuery = { page: 1, limit: 25, sort: 'recent' };
  const status = cleanText(query.status, 30).toLowerCase();
  if (status && (LEAD_STATUSES as readonly string[]).includes(status)) out.status = status as LeadStatus;
  const classLevel = Number(query.classLevel);
  if (AGTS_CLASS_LEVELS.includes(classLevel as (typeof AGTS_CLASS_LEVELS)[number])) out.classLevel = classLevel;
  const search = cleanText(query.search, 60);
  if (search) out.search = search;
  for (const key of ['from', 'to'] as const) {
    const raw = cleanText(query[key], 30);
    if (!raw) continue;
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      if (key === 'to') d.setHours(23, 59, 59, 999);
      out[key] = d;
    }
  }
  const followUp = cleanText(query.followUp, 10);
  if (followUp === 'due' || followUp === 'upcoming' || followUp === 'none') out.followUp = followUp;
  if (query.guidance === 'true' || query.guidance === '1') out.guidance = true;
  const page = Math.floor(Number(query.page));
  if (Number.isFinite(page) && page >= 1 && page <= 10000) out.page = page;
  const limit = Math.floor(Number(query.limit));
  if (Number.isFinite(limit) && limit >= 1) out.limit = Math.min(limit, 100);
  const sort = cleanText(query.sort, 12);
  if (sort === 'score' || sort === 'followup' || sort === 'created' || sort === 'recent') out.sort = sort;
  return out;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
