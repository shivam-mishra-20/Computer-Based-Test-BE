/**
 * Which exams a staff member may act on.
 *
 * A teacher works on the exams they created; an admin account on any. That is
 * the rule the teacher's exam list (listExamsCtrl) and the review module
 * (examReviewController.ensureExamOwnership) already apply — but the routes
 * that read, change, delete or assign ONE exam by id, its reports, and its
 * attempts checked only the permission, so any teacher could edit or delete
 * another teacher's exam, or read and re-mark its students' attempts, by id.
 *
 * Permissions (exams.update, reports.read, attempts.grade …) still decide what
 * KIND of action is allowed; these guards decide WHICH exams. Tenant isolation
 * is unchanged: the lookups below go through the tenant plugin like any read.
 */
import { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import Exam from '../models/Exam';
import Attempt from '../models/Attempt';

interface StaffUser {
  id?: string;
  role?: string;
  /** The account's own role; `role` may be narrowed by assigned custom roles. */
  accountRole?: string;
}
const userOf = (req: Request): StaffUser | undefined => (req as Request & { user?: StaffUser }).user;

export function isAdminAccount(req: Request): boolean {
  const user = userOf(req);
  return String(user?.accountRole ?? user?.role ?? '') === 'admin';
}

const notOwner = (res: Response) =>
  res.status(403).json({ message: 'You can only manage exams you created.', code: 'NOT_EXAM_OWNER' });

async function ownsExam(req: Request, examId: unknown): Promise<'yes' | 'no' | 'missing'> {
  if (!Types.ObjectId.isValid(String(examId))) return 'missing';
  const exam = await Exam.findById(examId).select('createdBy').lean<{ createdBy?: unknown }>();
  if (!exam) return 'missing';
  return String(exam.createdBy) === String(userOf(req)?.id) ? 'yes' : 'no';
}

/** The exam named by `req.params[param]` must be the caller's own (or the caller an admin). */
export function requireExamOwner(param = 'id') {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (isAdminAccount(req)) return next();
    try {
      const owns = await ownsExam(req, req.params[param]);
      if (owns === 'missing') return res.status(404).json({ message: 'Exam not found' });
      if (owns === 'no') return notOwner(res);
      return next();
    } catch (error) {
      console.error('[examOwnership] exam check failed:', (error as Error).message);
      return res.status(500).json({ message: 'Could not verify access to this exam' });
    }
  };
}

/** The attempt named by `req.params[param]` must belong to one of the caller's exams. */
export function requireAttemptExamOwner(param = 'attemptId') {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (isAdminAccount(req)) return next();
    try {
      const attemptId = req.params[param];
      if (!Types.ObjectId.isValid(String(attemptId))) return res.status(404).json({ message: 'Attempt not found' });
      const attempt = await Attempt.findById(attemptId).select('examId').lean<{ examId?: unknown }>();
      if (!attempt) return res.status(404).json({ message: 'Attempt not found' });
      // A practice-test attempt (no exam) belongs to the student, not a teacher.
      if (!attempt.examId) return notOwner(res);
      const owns = await ownsExam(req, attempt.examId);
      if (owns === 'missing') return res.status(404).json({ message: 'Exam not found' });
      if (owns === 'no') return notOwner(res);
      return next();
    } catch (error) {
      console.error('[examOwnership] attempt check failed:', (error as Error).message);
      return res.status(500).json({ message: 'Could not verify access to this attempt' });
    }
  };
}

/** The exam ids a teacher may see attempts for; null = all (admin). */
export async function ownedExamIdsOrAll(req: Request): Promise<Types.ObjectId[] | null> {
  if (isAdminAccount(req)) return null;
  const own = await Exam.find({ createdBy: userOf(req)?.id }).select('_id').lean<Array<{ _id: Types.ObjectId }>>();
  return own.map((e) => e._id);
}
