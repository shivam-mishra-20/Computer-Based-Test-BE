/**
 * Admissions input validation — pure, no database.
 *
 * The same rules as AGTS (services/agts/agtsValidation): every function reads
 * an explicit allow-list of fields, trims and caps every string, and returns
 * field-level messages a form can show beside the input. A body carrying
 * `status`, `orgId`, `owner`, `registrationId` or `__proto__` sets nothing.
 *
 * One class list for the whole flow: 7 to 12. Student accounts can only be
 * created for those classes (userController.resolveStudentClassAndBatch), so a
 * form that offered Class 6 was promising an admission the system could not
 * complete.
 */

import { createHash, randomBytes, randomInt } from 'crypto';
import {
  ADMISSION_STREAMS,
  DOCUMENT_KINDS,
  GUARDIAN_OCCUPATIONS,
  GUARDIAN_RELATIONS,
  PAYMENT_MODES,
  type ApplicationData,
  type GuardianDetails,
  type SubjectMark,
  type Touch,
} from '../../models/Lead';
import {
  AGTS_BOARDS,
  AgtsValidationError,
  cleanText,
  normalizeIndianMobile,
  parseAttribution,
} from '../agts/agtsValidation';

export { AgtsValidationError as AdmissionValidationError };

export const ADMISSION_CLASS_LEVELS = [7, 8, 9, 10, 11, 12] as const;
/** Classes that are split by stream. */
export const STREAM_CLASS_LEVELS = [11, 12] as const;
export const ADMISSION_BOARDS = AGTS_BOARDS;

export const needsStream = (classLevel: number) => (STREAM_CLASS_LEVELS as readonly number[]).includes(classLevel);

/** Where on the website an enquiry came from. Closed, so reports stay comparable. */
export const ENQUIRY_SOURCES = ['enrollnow', 'enquiry-page', 'home', 'marketing-hub', 'admissions-page', 'agts-result', 'other'] as const;
export type EnquirySource = (typeof ENQUIRY_SOURCES)[number];

/** Bump when the wording on the form changes. */
export const ENQUIRY_CONSENT_VERSION = '2026-10-25';
export const ENQUIRY_CONSENT_TEXT =
  'I agree that Abhigyan Gurukul may contact me by phone, SMS or WhatsApp about admission for my child.';

export const APPLICATION_CONSENT_VERSION = '2026-10-25';
export const APPLICATION_CONSENT_TEXT =
  'I confirm these details are correct and agree that Abhigyan Gurukul may use them, and the documents I upload, to process this admission.';

// ── Session ─────────────────────────────────────────────────────────────────

const SESSION_PATTERN = /^(\d{4})-(\d{2})$/;

/** True for "2027-28": two consecutive years. */
export function isValidSession(value: unknown): value is string {
  const match = SESSION_PATTERN.exec(String(value ?? ''));
  if (!match) return false;
  const start = Number(match[1]);
  return (start + 1) % 100 === Number(match[2]) && start >= 2020 && start <= 2100;
}

/**
 * The session admissions are being taken for. `ADMISSION_SESSION` overrides
 * the default, so the next season is a configuration change, not a release.
 */
export function currentAdmissionSession(env: NodeJS.ProcessEnv = process.env): string {
  const configured = String(env.ADMISSION_SESSION || '').trim();
  return isValidSession(configured) ? configured : '2027-28';
}

export function sessionStartYear(session: string): number {
  const match = SESSION_PATTERN.exec(session);
  return match ? Number(match[1]) : new Date().getFullYear();
}

export function seatHoldDays(env: NodeJS.ProcessEnv = process.env): number {
  const days = Math.floor(Number(env.ADMISSION_SEAT_HOLD_DAYS));
  return Number.isFinite(days) && days >= 1 && days <= 60 ? days : 7;
}

// ── Shared readers ──────────────────────────────────────────────────────────

const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

type Errors = Record<string, string>;

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function readName(value: unknown, field: string, label: string, errors: Errors, required = true): string {
  const name = cleanText(value, 80);
  if (!name) {
    if (required) errors[field] = `${label} is required`;
  } else if (name.length < 2) errors[field] = `${label} is too short`;
  else if (!NAME_PATTERN.test(name)) errors[field] = `${label} can only contain letters, spaces, dots, apostrophes and hyphens`;
  return name;
}

function readPhone(value: unknown, field: string, errors: Errors, required = true): string {
  const raw = String(value ?? '').trim();
  const phone = normalizeIndianMobile(value);
  if (!raw) {
    if (required) errors[field] = 'Phone number is required';
  } else if (!phone) errors[field] = 'Enter a valid 10-digit Indian mobile number';
  return phone;
}

function readEmail(value: unknown, field: string, errors: Errors): string {
  const email = cleanText(value, 120).toLowerCase();
  if (email && !EMAIL_PATTERN.test(email)) errors[field] = 'Enter a valid email address';
  return email;
}

function readBoard(value: unknown, field: string, errors: Errors, required = false): string {
  const raw = cleanText(value, 40);
  const board = raw ? ADMISSION_BOARDS.find((b) => b.toLowerCase() === raw.toLowerCase()) || '' : '';
  if (raw && !board) errors[field] = 'Select a board from the list';
  else if (!raw && required) errors[field] = 'Board is required';
  return board;
}

function readClassAndStream(src: Record<string, unknown>, errors: Errors, prefix = ''): { classLevel: number; stream: string } {
  const classLevel = Number(src.classLevel);
  if (!(ADMISSION_CLASS_LEVELS as readonly number[]).includes(classLevel)) {
    errors[`${prefix}classLevel`] = 'Select a class between 7 and 12';
  }
  const streamRaw = cleanText(src.stream, 20);
  const stream = ADMISSION_STREAMS.find((s) => s.toLowerCase() === streamRaw.toLowerCase()) || '';
  if (needsStream(classLevel)) {
    if (!stream) errors[`${prefix}stream`] = 'Select Science or Commerce';
  }
  return { classLevel, stream: needsStream(classLevel) ? stream : '' };
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | '' {
  const raw = cleanText(value, 40).toLowerCase();
  return allowed.find((a) => a.toLowerCase() === raw) || '';
}

// ── Enquiry (every public form) ─────────────────────────────────────────────

export interface EnquiryInput {
  studentName: string;
  classLevel: number;
  stream: string;
  board: string;
  school: string;
  guardianName: string;
  phone: string;
  phoneNormalized: string;
  email: string;
  message: string;
  source: EnquirySource;
  consent: true;
  attribution: Touch | null;
}

export function validateEnquiry(body: unknown): EnquiryInput {
  const src = asObject(body);
  const errors: Errors = {};

  const studentName = readName(src.studentName, 'studentName', 'Student name', errors);
  const { classLevel, stream } = readClassAndStream(src, errors);
  const guardianName = readName(src.guardianName, 'guardianName', 'Parent/guardian name', errors);
  const phone = readPhone(src.phone, 'phone', errors);
  const email = readEmail(src.email, 'email', errors);
  const board = readBoard(src.board, 'board', errors);
  const school = cleanText(src.school, 120);
  const message = cleanText(src.message, 500);
  const source = (pick(src.source, ENQUIRY_SOURCES) || 'other') as EnquirySource;

  // Consent must be the boolean `true`, not a truthy string a script might send.
  if (src.consent !== true) errors.consent = 'Please agree to be contacted about the admission';

  if (Object.keys(errors).length) throw new AgtsValidationError(errors);

  return {
    studentName,
    classLevel,
    stream,
    board,
    school,
    guardianName,
    phone,
    phoneNormalized: phone,
    email,
    message,
    source,
    consent: true,
    attribution: parseAttribution(src.attribution ?? src.utm),
  };
}

// ── Application (the personal link) ─────────────────────────────────────────

export interface ApplicationInput {
  classLevel: number;
  stream: string;
  data: ApplicationData;
}

function readMark(value: unknown, field: string, errors: Errors): SubjectMark | undefined {
  const src = asObject(value);
  const hasObtained = src.obtained !== undefined && src.obtained !== null && String(src.obtained).trim() !== '';
  const hasOutOf = src.outOf !== undefined && src.outOf !== null && String(src.outOf).trim() !== '';
  if (!hasObtained && !hasOutOf) return undefined;
  const obtained = Number(src.obtained);
  const outOf = Number(src.outOf);
  if (!hasObtained || !hasOutOf) {
    errors[field] = 'Enter both the marks and the total';
    return undefined;
  }
  if (!Number.isFinite(obtained) || !Number.isFinite(outOf) || outOf <= 0 || outOf > 1000 || obtained < 0 || obtained > outOf) {
    errors[field] = 'Marks must be a number between 0 and the total';
    return undefined;
  }
  return { obtained: Math.round(obtained * 100) / 100, outOf: Math.round(outOf * 100) / 100 };
}

function readGuardian(value: unknown, prefix: string, errors: Errors, required: boolean): GuardianDetails | null {
  const src = asObject(value);
  const anyGiven = ['relation', 'name', 'phone', 'email', 'occupation', 'organisation', 'designation'].some(
    (key) => cleanText(src[key], 120) !== '',
  );
  if (!required && !anyGiven) return null;

  const relation = pick(src.relation, GUARDIAN_RELATIONS);
  if (!relation) errors[`${prefix}.relation`] = 'Select father, mother or guardian';
  const name = readName(src.name, `${prefix}.name`, 'Name', errors);
  const phone = readPhone(src.phone, `${prefix}.phone`, errors, required);
  const email = readEmail(src.email, `${prefix}.email`, errors);
  const occupationRaw = cleanText(src.occupation, 40);
  const occupation = pick(src.occupation, GUARDIAN_OCCUPATIONS);
  if (occupationRaw && !occupation) errors[`${prefix}.occupation`] = 'Select an occupation from the list';
  else if (required && !occupation) errors[`${prefix}.occupation`] = 'Occupation is required';

  return {
    relation: relation || undefined,
    name,
    phone,
    email,
    occupation: occupation || undefined,
    organisation: cleanText(src.organisation, 120),
    designation: cleanText(src.designation, 80),
  };
}

/** A date of birth that makes a Class 7–12 student plausible: 9 to 21 years old. */
function readDateOfBirth(value: unknown, errors: Errors, now: Date): Date | null {
  const raw = cleanText(value, 30);
  if (!raw) {
    errors['student.dateOfBirth'] = 'Date of birth is required';
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    errors['student.dateOfBirth'] = 'Enter the date as YYYY-MM-DD';
    return null;
  }
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    errors['student.dateOfBirth'] = 'Enter a real date';
    return null;
  }
  const ageYears = (now.getTime() - date.getTime()) / (365.25 * 24 * 3600 * 1000);
  if (ageYears < 9 || ageYears > 21) {
    errors['student.dateOfBirth'] = 'Check the date of birth — the student should be 9 to 21 years old';
    return null;
  }
  return date;
}

export function validateApplication(body: unknown, now = new Date()): ApplicationInput {
  const src = asObject(body);
  const errors: Errors = {};

  const { classLevel, stream } = readClassAndStream(src, errors);

  const student = asObject(src.student);
  const name = readName(student.name, 'student.name', 'Student name', errors);
  const dateOfBirth = readDateOfBirth(student.dateOfBirth, errors, now);
  const school = cleanText(student.school, 120);
  if (!school) errors['student.school'] = 'School name is required';
  const board = readBoard(student.board, 'student.board', errors, true);

  const currentRaw = String(student.currentClass ?? '').trim();
  const currentClass = currentRaw ? Number(currentRaw) : null;
  if (currentClass !== null && (!Number.isInteger(currentClass) || currentClass < 1 || currentClass > 12)) {
    errors['student.currentClass'] = 'Select the current class';
  }

  const pctRaw = String(student.previousPercentage ?? '').trim().replace(/%$/, '');
  const previousPercentage = pctRaw ? Number(pctRaw) : null;
  if (previousPercentage !== null && (!Number.isFinite(previousPercentage) || previousPercentage < 0 || previousPercentage > 100)) {
    errors['student.previousPercentage'] = 'Enter a percentage between 0 and 100';
  }

  const marksSrc = asObject(student.marks);
  const marks: NonNullable<ApplicationData['student']['marks']> = {};
  for (const subject of ['maths', 'science', 'socialScience', 'english'] as const) {
    const mark = readMark(marksSrc[subject], `student.marks.${subject}`, errors);
    if (mark) marks[subject] = mark;
  }

  const primary = readGuardian(src.primary, 'primary', errors, true) as GuardianDetails;
  const secondary = readGuardian(src.secondary, 'secondary', errors, false);

  const address = asObject(src.address);
  const line = cleanText(address.line, 300);
  if (!line) errors['address.line'] = 'Home address is required';
  const city = cleanText(address.city, 80);
  if (!city) errors['address.city'] = 'City is required';
  const pincode = cleanText(address.pincode, 10).replace(/\s/g, '');
  if (pincode && !/^[1-9]\d{5}$/.test(pincode)) errors['address.pincode'] = 'Enter a 6-digit PIN code';

  if (src.consent !== true) errors.consent = 'Please confirm the details and agree to their use for this admission';

  if (Object.keys(errors).length) throw new AgtsValidationError(errors);

  return {
    classLevel,
    stream,
    data: {
      student: {
        name,
        dateOfBirth,
        currentClass,
        school,
        board,
        previousPercentage: previousPercentage === null ? null : Math.round(previousPercentage * 100) / 100,
        marks,
      },
      primary,
      secondary,
      address: { line, city, pincode },
      query: cleanText(src.query, 1000),
    },
  };
}

export function parseDocumentKind(value: unknown): string {
  const kind = pick(value, DOCUMENT_KINDS);
  if (!kind) throw new AgtsValidationError({ kind: `Document type must be one of: ${DOCUMENT_KINDS.join(', ')}` });
  return kind;
}

// ── Staff inputs ────────────────────────────────────────────────────────────

export interface OfferInput {
  classLevel: number;
  stream: string;
  batch: string;
  feeNote: string;
  holdDays: number;
  note: string;
  overrideCapacity: boolean;
}

export function parseOffer(body: unknown, env: NodeJS.ProcessEnv = process.env): OfferInput {
  const src = asObject(body);
  const errors: Errors = {};
  const { classLevel, stream } = readClassAndStream(src, errors);
  const holdRaw = String(src.holdDays ?? '').trim();
  const holdDays = holdRaw ? Math.floor(Number(holdRaw)) : seatHoldDays(env);
  if (!Number.isFinite(holdDays) || holdDays < 1 || holdDays > 60) errors.holdDays = 'Hold the seat for 1 to 60 days';
  if (Object.keys(errors).length) throw new AgtsValidationError(errors);
  return {
    classLevel,
    stream,
    batch: cleanText(src.batch, 60),
    feeNote: cleanText(src.feeNote, 300),
    holdDays,
    note: cleanText(src.note, 500),
    overrideCapacity: src.overrideCapacity === true,
  };
}

export interface AccountInput {
  email: string;
  empCode: string;
  password: string;
  batch: string;
}

export interface EnrolmentInput {
  paidAt: Date;
  amount: number | null;
  mode: string;
  receiptNo: string;
  note: string;
  account: AccountInput | null;
}

export function parseEnrolment(body: unknown, now = new Date()): EnrolmentInput {
  const src = asObject(body);
  const errors: Errors = {};

  const paidRaw = cleanText(src.paidAt, 30);
  const paidAt = paidRaw ? new Date(paidRaw) : now;
  if (Number.isNaN(paidAt.getTime())) errors.paidAt = 'Invalid payment date';
  else if (paidAt.getTime() > now.getTime() + 24 * 3600 * 1000) errors.paidAt = 'The payment date cannot be in the future';
  else if (paidAt.getTime() < now.getTime() - 400 * 24 * 3600 * 1000) errors.paidAt = 'The payment date is more than a year ago';

  const amountRaw = String(src.amount ?? '').trim();
  const amount = amountRaw ? Number(amountRaw) : null;
  if (amount !== null && (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000)) errors.amount = 'Enter the amount paid in rupees';

  const mode = pick(src.mode, PAYMENT_MODES);
  if (!mode) errors.mode = `Payment mode must be one of: ${PAYMENT_MODES.join(', ')}`;

  let account: AccountInput | null = null;
  const accountSrc = asObject(src.account);
  if (accountSrc.create === true) {
    const email = readEmail(accountSrc.email, 'account.email', errors);
    if (!email) errors['account.email'] = errors['account.email'] || 'An email is required for the student login';
    const empCode = cleanText(accountSrc.empCode, 64);
    if (!empCode) errors['account.empCode'] = 'Roll number / student code is required';
    else if (!/^[A-Za-z0-9._/-]+$/.test(empCode)) errors['account.empCode'] = 'Use letters, digits, dots, dashes or slashes only';
    const password = typeof accountSrc.password === 'string' ? accountSrc.password : '';
    if (password && (password.length < 8 || password.length > 128)) errors['account.password'] = 'Use 8 to 128 characters, or leave it empty to generate one';
    account = { email, empCode, password, batch: cleanText(accountSrc.batch, 60) };
  }

  if (Object.keys(errors).length) throw new AgtsValidationError(errors);
  return { paidAt, amount: amount === null ? null : Math.round(amount * 100) / 100, mode, receiptNo: cleanText(src.receiptNo, 60), note: cleanText(src.note, 500), account };
}

export interface SeatRow {
  classLevel: number;
  stream: string;
  capacity: number;
}

/** The capacity table for one session. Duplicate rows are refused, not merged. */
export function parseSeatRows(body: unknown): { session: string; rows: SeatRow[] } {
  const src = asObject(body);
  const errors: Errors = {};
  const session = cleanText(src.session, 10);
  if (!isValidSession(session)) errors.session = 'Session must look like 2027-28';
  const input = Array.isArray(src.rows) ? src.rows.slice(0, 40) : [];
  const rows: SeatRow[] = [];
  const seen = new Set<string>();
  input.forEach((value, index) => {
    const row = asObject(value);
    const rowErrors: Errors = {};
    const { classLevel, stream } = readClassAndStream(row, rowErrors);
    const capacity = Math.floor(Number(row.capacity));
    if (!Number.isFinite(capacity) || capacity < 0 || capacity > 1000) rowErrors.capacity = 'Capacity must be 0 to 1000';
    for (const [key, message] of Object.entries(rowErrors)) errors[`rows.${index}.${key}`] = message;
    if (Object.keys(rowErrors).length) return;
    const key = `${classLevel}|${stream}`;
    if (seen.has(key)) {
      errors[`rows.${index}`] = `Class ${classLevel}${stream ? ` ${stream}` : ''} is listed twice`;
      return;
    }
    seen.add(key);
    rows.push({ classLevel, stream, capacity });
  });
  if (Object.keys(errors).length) throw new AgtsValidationError(errors);
  return { session, rows };
}

/** 'me', 'none', or a user id. */
export function parseOwner(value: unknown): 'me' | 'none' | string {
  const raw = cleanText(value, 30);
  if (raw === 'me' || raw === 'none') return raw;
  if (/^[a-f0-9]{24}$/i.test(raw)) return raw;
  throw new AgtsValidationError({ owner: 'Choose a staff member, yourself, or nobody' });
}

// ── Identifiers ─────────────────────────────────────────────────────────────

/** `AG-2027-C10-12345678` — the same shape the fee lookup page has always accepted. */
export function generateRegistrationId(session: string, classLevel: number, digits = () => randomInt(0, 100_000_000)): string {
  const year = sessionStartYear(session);
  const klass = String(Math.max(1, Math.min(12, Math.floor(classLevel) || 0))).padStart(2, '0');
  return `AG-${year}-C${klass}-${String(digits()).padStart(8, '0')}`;
}

export const REGISTRATION_ID_PATTERN = /^AG-\d{4}-C\d{2}-\d{8}$/;

export function parseRegistrationId(value: unknown): string {
  const id = cleanText(value, 30).toUpperCase();
  return REGISTRATION_ID_PATTERN.test(id) ? id : '';
}

/** 192 bits, URL-safe. Only its hash is stored. */
export function newApplicationToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function parseApplicationToken(value: unknown): string {
  const token = String(value ?? '').trim();
  return /^[A-Za-z0-9_-]{32}$/.test(token) ? token : '';
}

/** A readable one-time password for a new student login. */
export function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[randomInt(0, alphabet.length)];
  return `${out}#${randomInt(10, 100)}`;
}

// ── Seat arithmetic ─────────────────────────────────────────────────────────

/** Seats still free: capacity less confirmed admissions and offers still held. */
export function seatsLeft(capacity: number, enrolled: number, held: number): number {
  return Math.max(0, capacity - enrolled - held);
}

export const seatKey = (classLevel: number, stream?: string) => `${classLevel}|${needsStream(classLevel) ? stream || '' : ''}`;
