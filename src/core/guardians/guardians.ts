/**
 * Parents and their wards — matching, the link lifecycle, and the only reads a
 * parent is allowed.
 *
 * ── How a parent identifies a ward, and why this way ────────────────────────
 * A parent must never be able to pick a child out of an institute's roster. So
 * there is no search, no list and no lookup by name. Instead the parent types
 * two things the institute has already given the family:
 *
 *   · the ward's STUDENT CODE — the `empCode` an administrator assigns when a
 *     student is approved (it is the roll number printed on exam seating);
 *   · the ward's REGISTERED PHONE NUMBER — the one on the student's account.
 *
 * Both must match ONE approved student in THIS organization. Knowing a code is
 * not enough (codes are printed on seating charts); knowing a phone number is
 * not enough (it names no student). Together they are what a family has and a
 * stranger does not. A failed match says the same thing whichever half was
 * wrong, so it cannot be used to discover which codes exist, and it is rate
 * limited per device.
 *
 * Even a correct match only creates a PENDING link. An administrator verifies
 * it before the parent can see anything — the match is the evidence, the
 * administrator is the decision.
 *
 * ── What a parent can read ──────────────────────────────────────────────────
 * Exactly two things, both through this module: the list of wards whose links
 * are VERIFIED, and a verified ward's PUBLISHED results. Every read re-checks
 * the link in the parent's own organization; a student id in a URL is a
 * question, never an authorization.
 */

import mongoose from 'mongoose';
import GuardianLink, { type IGuardianLink } from '../../models/GuardianLink';
import User from '../../models/User';
import Attempt from '../../models/Attempt';
import { withoutTenantScope } from '../tenancy/context';

export class GuardianLinkError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'INVALID_STATE' | 'WARD_NOT_VERIFIED', readonly httpStatus: number, message: string) {
    super(message);
    this.name = 'GuardianLinkError';
  }
}

/** The last ten digits — enough to ignore a country code or a leading zero. */
export function phoneKey(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-10) : '';
}

/**
 * The approved student in THIS organization that both details identify, or null.
 *
 * Null for every way of being wrong. The caller must not branch its message on
 * why, or the difference becomes an oracle for which student codes exist.
 */
export async function findWardByCredentials(
  orgId: string,
  studentCode: unknown,
  wardPhone: unknown,
): Promise<{ _id: mongoose.Types.ObjectId; name: string } | null> {
  const code = typeof studentCode === 'string' ? studentCode.trim() : '';
  const phone = phoneKey(wardPhone);
  if (!code || code.length > 64 || !phone) return null;

  const student = await withoutTenantScope('guardian:find-ward', async () =>
    User.findOne({ orgId, role: 'student', status: 'approved', empCode: code })
      .select('_id name phone')
      .lean(),
  );
  if (!student) return null;
  if (phoneKey((student as { phone?: string }).phone) !== phone) return null;
  const found = student as unknown as { _id: mongoose.Types.ObjectId; name: string };
  return { _id: found._id, name: found.name };
}

/**
 * Open (or re-open) a pending link. Idempotent: asking twice is one link.
 *
 * A REVOKED link is re-opened as pending — the family is asking again and an
 * administrator decides again. A VERIFIED link is left alone.
 */
export async function requestLink(
  input: { orgId: string; parentId: mongoose.Types.ObjectId | string; studentId: mongoose.Types.ObjectId | string },
  session?: mongoose.ClientSession,
): Promise<IGuardianLink> {
  const filter = {
    orgId: input.orgId,
    parentId: new mongoose.Types.ObjectId(String(input.parentId)),
    studentId: new mongoose.Types.ObjectId(String(input.studentId)),
  };
  return withoutTenantScope('guardian:request-link', async () => {
    const existing = await GuardianLink.findOne(filter).session(session ?? null);
    if (existing) {
      if (existing.status === 'revoked') {
        existing.status = 'pending';
        existing.requestedAt = new Date();
        await existing.save({ session });
      }
      return existing;
    }
    const [created] = await GuardianLink.create(
      [{ ...filter, status: 'pending', method: 'student-code+phone', requestedAt: new Date() }],
      session ? { session } : {},
    );
    return created;
  });
}

export interface LinkActor {
  id: string;
  kind: 'org-admin' | 'platform';
}

/**
 * An administrator confirms a relationship.
 *
 * Also approves the parent's account if it is still pending: the parent
 * registered only in order to follow this child, and approving the link without
 * the account would leave a verified relationship nobody can sign in to use.
 * The parent's account must belong to the same organization as the link — a
 * link cannot promote an account from somewhere else.
 */
export async function verifyLink(orgId: string, linkId: string, actor: LinkActor): Promise<IGuardianLink> {
  if (!mongoose.isValidObjectId(linkId)) throw new GuardianLinkError('NOT_FOUND', 404, 'Link not found.');
  return withoutTenantScope('guardian:verify', async () => {
    const link = await GuardianLink.findOne({ _id: linkId, orgId });
    if (!link) throw new GuardianLinkError('NOT_FOUND', 404, 'Link not found.');
    if (link.status === 'revoked') {
      throw new GuardianLinkError('INVALID_STATE', 409, 'A revoked link must be requested again by the parent.');
    }
    const [parent, student] = await Promise.all([
      User.findOne({ _id: link.parentId, orgId, role: 'parent' }).select('_id status'),
      User.findOne({ _id: link.studentId, orgId, role: 'student' }).select('_id status').lean(),
    ]);
    if (!parent || !student) throw new GuardianLinkError('INVALID_STATE', 409, 'The parent or student is no longer part of this organization.');

    link.status = 'verified';
    link.verifiedAt = new Date();
    link.verifiedBy = actor.id;
    link.verifiedByKind = actor.kind;
    await link.save();
    if (parent.status === 'pending') {
      parent.status = 'approved';
      await parent.save();
    }
    return link;
  });
}

/** An administrator removes a relationship. The parent loses access immediately. */
export async function revokeLink(orgId: string, linkId: string, actor: LinkActor): Promise<IGuardianLink> {
  if (!mongoose.isValidObjectId(linkId)) throw new GuardianLinkError('NOT_FOUND', 404, 'Link not found.');
  return withoutTenantScope('guardian:revoke', async () => {
    const link = await GuardianLink.findOne({ _id: linkId, orgId });
    if (!link) throw new GuardianLinkError('NOT_FOUND', 404, 'Link not found.');
    link.status = 'revoked';
    link.revokedAt = new Date();
    link.revokedBy = actor.id;
    link.revokedByKind = actor.kind;
    await link.save();
    return link;
  });
}

/** Links for an administrator's review, with just enough to recognise people. */
export async function listLinks(orgId: string, status?: string) {
  const filter: Record<string, unknown> = { orgId };
  if (status && ['pending', 'verified', 'revoked'].includes(status)) filter.status = status;
  return withoutTenantScope('guardian:list', async () => {
    const links = await GuardianLink.find(filter).sort({ requestedAt: -1 }).limit(200).lean();
    const ids = links.flatMap((l) => [l.parentId, l.studentId]);
    const people = await User.find({ _id: { $in: ids }, orgId })
      .select('name email phone empCode classLevel batch role status')
      .lean();
    const byId = new Map(people.map((p) => [String(p._id), p]));
    return links.map((l) => {
      const parent = byId.get(String(l.parentId)) as Record<string, unknown> | undefined;
      const student = byId.get(String(l.studentId)) as Record<string, unknown> | undefined;
      return {
        id: String(l._id),
        status: l.status,
        requestedAt: l.requestedAt,
        verifiedAt: l.verifiedAt,
        parent: parent ? { id: String(parent._id), name: parent.name, email: parent.email, phone: parent.phone, status: parent.status } : null,
        student: student ? { id: String(student._id), name: student.name, studentCode: student.empCode, classLevel: student.classLevel, batch: student.batch } : null,
      };
    });
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   What a parent may read
   ══════════════════════════════════════════════════════════════════════════ */

/** Verified wards only. Pending and revoked links show nothing. */
export async function wardsOf(orgId: string, parentId: string) {
  return withoutTenantScope('guardian:wards', async () => {
    const links = await GuardianLink.find({ orgId, parentId, status: { $in: ['verified', 'pending'] } }).lean();
    const verifiedIds = links.filter((l) => l.status === 'verified').map((l) => l.studentId);
    const students = await User.find({ _id: { $in: verifiedIds }, orgId, role: 'student' })
      .select('name classLevel batch')
      .lean();
    return {
      wards: students.map((s) => ({ id: String(s._id), name: s.name, classLevel: s.classLevel, batch: s.batch })),
      // A count, not names: a pending link has not been confirmed, so the
      // parent is not yet entitled to see who it points at.
      pendingCount: links.filter((l) => l.status === 'pending').length,
    };
  });
}

/**
 * A verified ward's published results.
 *
 * The link is re-checked on every call, in the parent's own organization. An
 * unverified, revoked, foreign or invented student id all get the same 404.
 */
export async function wardResults(orgId: string, parentId: string, studentId: string) {
  if (!mongoose.isValidObjectId(studentId)) {
    throw new GuardianLinkError('WARD_NOT_VERIFIED', 404, 'No such ward.');
  }
  return withoutTenantScope('guardian:ward-results', async () => {
    const link = await GuardianLink.findOne({ orgId, parentId, studentId, status: 'verified' }).lean();
    if (!link) throw new GuardianLinkError('WARD_NOT_VERIFIED', 404, 'No such ward.');
    const attempts = await Attempt.find({ userId: studentId, orgId, resultPublished: true })
      .select('examId percentage submittedAt status')
      .populate({ path: 'examId', select: 'title subject totalMarks' })
      .sort({ submittedAt: -1 })
      .limit(50)
      .lean();
    return attempts.map((a) => {
      const exam = (a as { examId?: { _id?: unknown; title?: string; subject?: string } }).examId;
      return {
        id: String(a._id),
        exam: exam && typeof exam === 'object' ? { title: exam.title, subject: exam.subject } : null,
        percentage: typeof a.percentage === 'number' ? Math.round(a.percentage * 10) / 10 : null,
        submittedAt: a.submittedAt,
      };
    });
  });
}
