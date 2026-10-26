/**
 * Admissions pure-logic checks — input validation, identifiers, seat
 * arithmetic and the staff-facing lead view.
 * No database, no network: `npm run safety:admissions-logic`.
 */

import {
  AdmissionValidationError,
  REGISTRATION_ID_PATTERN,
  currentAdmissionSession,
  generatePassword,
  generateRegistrationId,
  hashToken,
  isValidSession,
  newApplicationToken,
  parseApplicationToken,
  parseDocumentKind,
  parseEnrolment,
  parseOffer,
  parseOwner,
  parseRegistrationId,
  parseSeatRows,
  seatHoldDays,
  seatKey,
  seatsLeft,
  validateApplication,
  validateEnquiry,
} from '../../src/services/admissions/admissionValidation';
import { alertText, enquirySourceLabel } from '../../src/services/admissions/admissionAlerts';
import { parseLeadListQuery } from '../../src/services/agts/agtsValidation';
import { staffLeadView } from '../../src/services/agts/leadService';
import { Checks } from './e2eHarness';

const t = new Checks();

const refused = (fn: () => unknown): Record<string, string> | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof AdmissionValidationError ? err.errors : { unexpected: String(err) };
  }
};

// ── Session ─────────────────────────────────────────────────────────────────
{
  t.check('session default is 2027-28', currentAdmissionSession({}) === '2027-28');
  t.check('session override is read', currentAdmissionSession({ ADMISSION_SESSION: '2028-29' }) === '2028-29');
  t.check('a malformed override falls back', currentAdmissionSession({ ADMISSION_SESSION: '2028-30' }) === '2027-28');
  t.check('sessions must be consecutive years', isValidSession('2027-28') && !isValidSession('2027-29') && !isValidSession('27-28'));
  t.check('seat hold defaults to 7 days', seatHoldDays({}) === 7 && seatHoldDays({ ADMISSION_SEAT_HOLD_DAYS: '14' }) === 14 && seatHoldDays({ ADMISSION_SEAT_HOLD_DAYS: '400' }) === 7);
}

// ── Enquiry ─────────────────────────────────────────────────────────────────
const enquiry = {
  studentName: 'Aarav Shah',
  classLevel: 10,
  guardianName: 'Neha Shah',
  phone: '+91 98765 43210',
  email: 'NEHA@Example.com',
  board: 'icse',
  school: 'Navrachana',
  message: 'Evening batch?',
  source: 'home',
  consent: true,
};
{
  const ok = validateEnquiry(enquiry);
  t.check('enquiry: phone normalised to 10 digits', ok.phoneNormalized === '9876543210');
  t.check('enquiry: board matched case-insensitively, ICSE accepted', ok.board === 'ICSE');
  t.check('enquiry: email lower-cased', ok.email === 'neha@example.com');
  t.check('enquiry: source kept', ok.source === 'home');
  t.check('enquiry: stream empty below Class 11', ok.stream === '');
  t.check('enquiry: unknown source becomes "other"', validateEnquiry({ ...enquiry, source: 'evil' }).source === 'other');

  const tamper = validateEnquiry({ ...enquiry, status: 'enrolled', orgId: 'x', owner: 'me', registrationId: 'AG-2027-C10-00000001' }) as any;
  t.check('enquiry: status / orgId / owner / registrationId ignored', !('status' in tamper) && !('orgId' in tamper) && !('owner' in tamper) && !('registrationId' in tamper));

  t.check('enquiry: consent must be boolean true', refused(() => validateEnquiry({ ...enquiry, consent: 'true' }))?.consent !== undefined);
  t.check('enquiry: Class 6 refused (no accounts below 7)', refused(() => validateEnquiry({ ...enquiry, classLevel: 6 }))?.classLevel !== undefined);
  t.check('enquiry: Class 11 needs a stream', refused(() => validateEnquiry({ ...enquiry, classLevel: 11 }))?.stream !== undefined);
  t.check('enquiry: Class 11 Science accepted', validateEnquiry({ ...enquiry, classLevel: 11, stream: 'science' }).stream === 'Science');
  t.check('enquiry: landline-style number refused', refused(() => validateEnquiry({ ...enquiry, phone: '0265 123456' }))?.phone !== undefined);
  t.check('enquiry: board outside the list refused', refused(() => validateEnquiry({ ...enquiry, board: 'Hogwarts' }))?.board !== undefined);
  t.check('enquiry: message capped at 500', validateEnquiry({ ...enquiry, message: 'x'.repeat(900) }).message.length === 500);
  t.check('enquiry: digits in a name refused', refused(() => validateEnquiry({ ...enquiry, studentName: 'R2D2' }))?.studentName !== undefined);
}

// ── Application ─────────────────────────────────────────────────────────────
const now = new Date('2026-11-01T10:00:00Z');
const application = {
  classLevel: 11,
  stream: 'Commerce',
  student: {
    name: 'Aarav Shah',
    dateOfBirth: '2011-05-14',
    currentClass: '10',
    school: 'Navrachana',
    board: 'CBSE',
    previousPercentage: '88.5%',
    marks: { maths: { obtained: '92', outOf: '100' }, english: { obtained: '', outOf: '' } },
  },
  primary: { relation: 'Mother', name: 'Neha Shah', phone: '9876543210', occupation: 'homemaker', email: 'neha@example.com' },
  secondary: { relation: '', name: '', phone: '' },
  address: { line: '12 Alkapuri', city: 'Vadodara', pincode: '390007' },
  consent: true,
};
{
  const ok = validateApplication(application, now);
  t.check('application: Homemaker accepted for the primary contact', ok.data.primary.occupation === 'Homemaker');
  t.check('application: mother as the only contact is enough', ok.data.primary.relation === 'Mother' && ok.data.secondary === null);
  t.check('application: percentage parsed from "88.5%"', ok.data.student.previousPercentage === 88.5);
  t.check('application: marks are numbers', ok.data.student.marks?.maths?.obtained === 92 && ok.data.student.marks?.maths?.outOf === 100);
  t.check('application: an empty subject is left out', ok.data.student.marks?.english === undefined);
  t.check('application: date of birth parsed', ok.data.student.dateOfBirth?.toISOString().slice(0, 10) === '2011-05-14');
  t.check('application: stream kept for Class 11', ok.stream === 'Commerce');

  const marksOver = refused(() => validateApplication({ ...application, student: { ...application.student, marks: { maths: { obtained: 120, outOf: 100 } } } }, now));
  t.check('application: marks above the total refused', marksOver?.['student.marks.maths'] !== undefined);
  const halfMark = refused(() => validateApplication({ ...application, student: { ...application.student, marks: { science: { obtained: 50 } } } }, now));
  t.check('application: marks without a total refused', halfMark?.['student.marks.science'] !== undefined);
  const baby = refused(() => validateApplication({ ...application, student: { ...application.student, dateOfBirth: '2024-01-01' } }, now));
  t.check('application: implausible date of birth refused', baby?.['student.dateOfBirth'] !== undefined);
  const feb30 = refused(() => validateApplication({ ...application, student: { ...application.student, dateOfBirth: '2011-02-30' } }, now));
  t.check('application: impossible date refused', feb30?.['student.dateOfBirth'] !== undefined);
  const noBoard = refused(() => validateApplication({ ...application, student: { ...application.student, board: '' } }, now));
  t.check('application: board required', noBoard?.['student.board'] !== undefined);
  const pin = refused(() => validateApplication({ ...application, address: { ...application.address, pincode: '12345' } }, now));
  t.check('application: 5-digit PIN refused', pin?.['address.pincode'] !== undefined);
  const half = refused(() => validateApplication({ ...application, secondary: { phone: '9876501234' } }, now));
  t.check('application: a half-filled second parent needs relation and name', half?.['secondary.relation'] !== undefined && half?.['secondary.name'] !== undefined);
  const noConsent = refused(() => validateApplication({ ...application, consent: undefined }, now));
  t.check('application: consent required', noConsent?.consent !== undefined);
  const everything = refused(() => validateApplication({}, now)) || {};
  t.check(
    'application: an empty body names every required field at once',
    ['classLevel', 'student.name', 'student.dateOfBirth', 'student.school', 'student.board', 'primary.relation', 'primary.name', 'primary.phone', 'primary.occupation', 'address.line', 'address.city', 'consent'].every((k) => k in everything),
  );
}

// ── Staff inputs ────────────────────────────────────────────────────────────
{
  const offer = parseOffer({ classLevel: 12, stream: 'Science', batch: 'Morning', holdDays: '10' });
  t.check('offer: parsed', offer.classLevel === 12 && offer.stream === 'Science' && offer.holdDays === 10 && !offer.overrideCapacity);
  t.check('offer: hold defaults from env', parseOffer({ classLevel: 9 }, { ADMISSION_SEAT_HOLD_DAYS: '5' }).holdDays === 5);
  t.check('offer: override only on boolean true', parseOffer({ classLevel: 9, overrideCapacity: 'yes' }).overrideCapacity === false);
  t.check('offer: 90-day hold refused', refused(() => parseOffer({ classLevel: 9, holdDays: 90 }))?.holdDays !== undefined);

  const enrol = parseEnrolment({ amount: '45000', mode: 'UPI', receiptNo: 'R-12' }, now);
  t.check('enrolment: amount and mode parsed', enrol.amount === 45000 && enrol.mode === 'upi' && enrol.account === null);
  t.check('enrolment: future payment refused', refused(() => parseEnrolment({ mode: 'cash', paidAt: '2027-01-01' }, now))?.paidAt !== undefined);
  t.check('enrolment: unknown mode refused', refused(() => parseEnrolment({ mode: 'crypto' }, now))?.mode !== undefined);
  const acct = refused(() => parseEnrolment({ mode: 'cash', account: { create: true, email: 'bad', empCode: '' } }, now));
  t.check('enrolment: a login needs a valid email and a roll number', acct?.['account.email'] !== undefined && acct?.['account.empCode'] !== undefined);
  const withAcct = parseEnrolment({ mode: 'cash', account: { create: true, email: 'A@B.in', empCode: 'AG27-101', batch: 'Alpha' } }, now);
  t.check('enrolment: login fields parsed, empty password left for generation', withAcct.account?.email === 'a@b.in' && withAcct.account?.empCode === 'AG27-101' && withAcct.account?.password === '');

  const seats = parseSeatRows({ session: '2027-28', rows: [{ classLevel: 10, capacity: 40 }, { classLevel: 11, stream: 'Science', capacity: '30' }] });
  t.check('seats: parsed', seats.rows.length === 2 && seats.rows[1].capacity === 30 && seats.rows[0].stream === '');
  t.check('seats: a duplicate class refused', refused(() => parseSeatRows({ session: '2027-28', rows: [{ classLevel: 10, capacity: 1 }, { classLevel: 10, capacity: 2 }] }))?.['rows.1'] !== undefined);
  t.check('seats: Class 12 without stream refused', refused(() => parseSeatRows({ session: '2027-28', rows: [{ classLevel: 12, capacity: 5 }] }))?.['rows.0.stream'] !== undefined);
  t.check('seats: bad session refused', refused(() => parseSeatRows({ session: 'next year', rows: [] }))?.session !== undefined);

  t.check('owner: me / none / id accepted', parseOwner('me') === 'me' && parseOwner('none') === 'none' && parseOwner('a'.repeat(24)) === 'a'.repeat(24));
  t.check('owner: anything else refused', refused(() => parseOwner('$ne'))?.owner !== undefined);
  t.check('document kind allow-list', parseDocumentKind('Report_Card') === 'report_card' && refused(() => parseDocumentKind('exe'))?.kind !== undefined);

  const list = parseLeadListQuery({ channel: 'enquiry', session: '2027-28', admissionClass: '11', stream: 'Commerce', owner: 'none' });
  t.check('list query: admissions filters parsed', list.channel === 'enquiry' && list.session === '2027-28' && list.admissionClass === 11 && list.stream === 'Commerce' && list.owner === 'none');
  t.check('list query: no channel stays AGTS-only by default (undefined)', parseLeadListQuery({}).channel === undefined);
  t.check('list query: bad owner dropped', parseLeadListQuery({ owner: '{"$gt":""}' }).owner === undefined);
}

// ── Identifiers ─────────────────────────────────────────────────────────────
{
  const id = generateRegistrationId('2027-28', 9, () => 42);
  t.check('registration ID shape matches the fee page', id === 'AG-2027-C09-00000042' && REGISTRATION_ID_PATTERN.test(id));
  t.check('registration ID parse upper-cases and rejects junk', parseRegistrationId('ag-2027-c09-00000042') === id && parseRegistrationId('AG-2027-C09-42') === '');
  const token = newApplicationToken();
  t.check('application token is 32 URL-safe characters', parseApplicationToken(token) === token);
  t.check('a token is stored as its sha256', hashToken(token).length === 64 && hashToken(token) !== token);
  t.check('a malformed token is refused', parseApplicationToken('../../etc') === '' && parseApplicationToken(`${token}x`) === '');
  const pw = generatePassword();
  t.check('generated password is long and mixed', pw.length >= 12 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /\d/.test(pw));
}

// ── Seats and alerts ────────────────────────────────────────────────────────
{
  t.check('seats left = capacity − enrolled − held', seatsLeft(40, 30, 6) === 4);
  t.check('seats left never negative', seatsLeft(10, 9, 5) === 0);
  t.check('seat key ignores stream below 11', seatKey(10, 'Science') === '10|' && seatKey(11, 'Science') === '11|Science');

  const text = alertText('enquiry', { _id: 'x', student: { name: 'Aarav Shah' }, admission: { classLevel: 11, stream: 'Science' } }, enquirySourceLabel('home'));
  t.check('alert names first name and class only', text.body.startsWith('Aarav, Class 11 Science') && !text.body.includes('Shah'));
  t.check('alert source label', text.body.includes('home page'));
}

// ── Staff view hides the link credential ───────────────────────────────────
{
  const view = staffLeadView({ application: { tokenHash: 'f'.repeat(64), tokenExpiresAt: new Date(Date.now() + 86_400_000), documents: [] } });
  t.check('staff view drops tokenHash', !('tokenHash' in view.application));
  t.check('staff view says whether the link is live', view.application.linkActive === true);
  const expired = staffLeadView({ application: { tokenHash: 'f'.repeat(64), tokenExpiresAt: new Date(0), documents: [] } });
  t.check('staff view: an expired link is not live', expired.application.linkActive === false);
}

t.report();
