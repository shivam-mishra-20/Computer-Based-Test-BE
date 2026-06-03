import { Request, Response } from 'express';
import mongoose from 'mongoose';
import AttendanceRule from '../models/AttendanceRule';
import { isValidTimeString, SYSTEM_DEFAULT_RULE } from '../services/attendanceRuleService';
import User from '../models/User';

function validatePayload(body: any): string | null {
  const { userId, role, officialInTime, officialOutTime } = body;

  // Must have exactly one scope
  if (!userId && !role) return 'Provide either userId (user-specific) or role (role default).';
  if (userId && role) return 'Provide either userId or role, not both.';

  if (role && !['admin', 'teacher', 'student'].includes(role)) {
    return 'role must be admin, teacher, or student.';
  }

  if (userId && !mongoose.Types.ObjectId.isValid(userId)) {
    return 'userId is not a valid ObjectId.';
  }

  if (officialInTime && !isValidTimeString(officialInTime)) {
    return 'officialInTime must be HH:MM (24-hour, e.g. "10:30").';
  }
  if (officialOutTime && !isValidTimeString(officialOutTime)) {
    return 'officialOutTime must be HH:MM (24-hour, e.g. "19:30").';
  }

  const pctFields = [
    'lateDeductionPct',
    'partialFullDayDeductionPct',
    'halfDayDeductionPct',
    'halfTimeLateDeductionPct',
  ] as const;
  for (const f of pctFields) {
    const v = body[f];
    if (v !== undefined) {
      const n = Number(v);
      if (isNaN(n) || n < 0 || n > 100) return `${f} must be a number between 0 and 100.`;
    }
  }

  const numFields = [
    'graceMinutes',
    'fullDayMinHours',
    'partialFullDayMinHours',
    'halfTimeRequiredHours',
  ] as const;
  for (const f of numFields) {
    const v = body[f];
    if (v !== undefined) {
      const n = Number(v);
      if (isNaN(n) || n < 0) return `${f} must be a non-negative number.`;
    }
  }

  const { fullDayMinHours, partialFullDayMinHours } = body;
  if (
    fullDayMinHours !== undefined &&
    partialFullDayMinHours !== undefined &&
    Number(partialFullDayMinHours) > Number(fullDayMinHours)
  ) {
    return 'partialFullDayMinHours must be ≤ fullDayMinHours.';
  }

  return null;
}

export class AttendanceRuleController {
  // GET /api/attendance-rules
  // Returns all rules with user/role info populated
  public static async listRules(req: Request, res: Response): Promise<void> {
    try {
      const rules = await AttendanceRule.find()
        .populate('userId', 'name email empCode role')
        .sort({ createdAt: -1 })
        .lean();

      res.json({ rules, systemDefault: SYSTEM_DEFAULT_RULE });
    } catch (err) {
      console.error('[AttendanceRuleController] listRules error:', err);
      res.status(500).json({ message: 'Failed to fetch attendance rules.' });
    }
  }

  // GET /api/attendance-rules/user/:userId
  // Returns the effective rule for a specific user (used by admin to preview)
  public static async getRuleForUser(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        res.status(400).json({ message: 'Invalid userId.' });
        return;
      }

      const user = await User.findById(userId).select('name role empCode').lean();
      if (!user) {
        res.status(404).json({ message: 'User not found.' });
        return;
      }

      const userRule = await AttendanceRule.findOne({ userId: new mongoose.Types.ObjectId(userId) }).lean();
      const roleRule = await AttendanceRule.findOne({ role: user.role, userId: { $exists: false } }).lean();

      res.json({
        user: { _id: user._id, name: (user as any).name, role: user.role, empCode: (user as any).empCode },
        userRule: userRule || null,
        roleRule: roleRule || null,
        systemDefault: SYSTEM_DEFAULT_RULE,
        activeSource: userRule ? 'user' : roleRule ? 'role' : 'default',
      });
    } catch (err) {
      console.error('[AttendanceRuleController] getRuleForUser error:', err);
      res.status(500).json({ message: 'Failed to fetch rule for user.' });
    }
  }

  // POST /api/attendance-rules
  public static async createRule(req: Request, res: Response): Promise<void> {
    try {
      const admin = (req as any).user;
      const validationError = validatePayload(req.body);
      if (validationError) {
        res.status(400).json({ message: validationError });
        return;
      }

      const {
        userId,
        role,
        userType,
        officialInTime,
        officialOutTime,
        graceMinutes,
        fullDayMinHours,
        partialFullDayMinHours,
        halfTimeRequiredHours,
        lateDeductionPct,
        partialFullDayDeductionPct,
        halfDayDeductionPct,
        halfTimeLateDeductionPct,
        label,
      } = req.body;

      // Check for conflict
      const conflictQuery: any = userId
        ? { userId: new mongoose.Types.ObjectId(userId) }
        : { role, userId: { $exists: false } };
      const existing = await AttendanceRule.findOne(conflictQuery);
      if (existing) {
        res.status(409).json({
          message: userId
            ? 'A rule for this user already exists. Use PUT to update it.'
            : `A default rule for role '${role}' already exists. Use PUT to update it.`,
          existingId: existing._id,
        });
        return;
      }

      const sanitiseTime = (t: string) => (t ? String(t).slice(0, 5) : t);
      const rule = new AttendanceRule({
        userId: userId ? new mongoose.Types.ObjectId(userId) : undefined,
        role: userId ? undefined : role,
        userType: userType || 'full_time',
        officialInTime: sanitiseTime(officialInTime) || '10:30',
        officialOutTime: sanitiseTime(officialOutTime) || '19:30',
        graceMinutes: graceMinutes ?? 0,
        fullDayMinHours: fullDayMinHours ?? 9,
        partialFullDayMinHours: partialFullDayMinHours ?? 8,
        halfTimeRequiredHours: halfTimeRequiredHours ?? 4,
        lateDeductionPct: lateDeductionPct ?? 0,
        partialFullDayDeductionPct: partialFullDayDeductionPct ?? 25,
        halfDayDeductionPct: halfDayDeductionPct ?? 50,
        halfTimeLateDeductionPct: halfTimeLateDeductionPct ?? 50,
        label,
        createdBy: new mongoose.Types.ObjectId(admin.id),
      });

      await rule.save();
      res.status(201).json({ message: 'Rule created.', rule });
    } catch (err: any) {
      if (err.code === 11000) {
        res.status(409).json({ message: 'A rule for this scope already exists.' });
        return;
      }
      console.error('[AttendanceRuleController] createRule error:', err);
      res.status(500).json({ message: 'Failed to create rule.' });
    }
  }

  // PUT /api/attendance-rules/:id
  public static async updateRule(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({ message: 'Invalid rule id.' });
        return;
      }

      // For updates, userId/role must stay the same (scope is immutable after create)
      const UPDATABLE_FIELDS = [
        'userType',
        'officialInTime',
        'officialOutTime',
        'graceMinutes',
        'fullDayMinHours',
        'partialFullDayMinHours',
        'halfTimeRequiredHours',
        'lateDeductionPct',
        'partialFullDayDeductionPct',
        'halfDayDeductionPct',
        'halfTimeLateDeductionPct',
        'label',
      ];

      const updates: Record<string, any> = {};
      for (const f of UPDATABLE_FIELDS) {
        if (req.body[f] !== undefined) updates[f] = req.body[f];
      }

      if (Object.keys(updates).length === 0) {
        res.status(400).json({ message: 'No updatable fields provided.' });
        return;
      }

      // Partial validation of what's being updated
      const combined = { ...req.body, userId: 'dummy' }; // scope check not needed for update
      const validationError = validatePayload({ ...combined, userId: undefined, role: 'teacher' });
      // Just validate the numeric/time fields; ignore scope error by providing dummy
      if (validationError && !validationError.includes('userId') && !validationError.includes('role')) {
        res.status(400).json({ message: validationError });
        return;
      }

      const rule = await AttendanceRule.findByIdAndUpdate(
        id,
        { $set: updates },
        { new: true, runValidators: true }
      );

      if (!rule) {
        res.status(404).json({ message: 'Rule not found.' });
        return;
      }

      res.json({ message: 'Rule updated.', rule });
    } catch (err) {
      console.error('[AttendanceRuleController] updateRule error:', err);
      res.status(500).json({ message: 'Failed to update rule.' });
    }
  }

  // POST /api/attendance-rules/upsert
  // Create-or-update a rule for a specific userId or role.
  // Used by the multi-user form: the frontend sends one request per selected user.
  public static async upsertRule(req: Request, res: Response): Promise<void> {
    try {
      const admin = (req as any).user;
      const validationError = validatePayload(req.body);
      if (validationError) {
        res.status(400).json({ message: validationError });
        return;
      }

      const {
        userId,
        role,
        userType,
        officialInTime,
        officialOutTime,
        graceMinutes,
        fullDayMinHours,
        partialFullDayMinHours,
        halfTimeRequiredHours,
        lateDeductionPct,
        partialFullDayDeductionPct,
        halfDayDeductionPct,
        halfTimeLateDeductionPct,
        label,
      } = req.body;

      // Sanitise time strings — strip seconds if browser includes them (HH:MM:SS → HH:MM)
      const sanitiseTime = (t: string) => (t ? String(t).slice(0, 5) : t);

      const filter = userId
        ? { userId: new mongoose.Types.ObjectId(userId) }
        : { role, userId: { $exists: false } };

      const update: any = {
        userType: userType || 'full_time',
        officialInTime: sanitiseTime(officialInTime) || '10:30',
        officialOutTime: sanitiseTime(officialOutTime) || '19:30',
        graceMinutes: graceMinutes ?? 0,
        fullDayMinHours: fullDayMinHours ?? 9,
        partialFullDayMinHours: partialFullDayMinHours ?? 8,
        halfTimeRequiredHours: halfTimeRequiredHours ?? 4,
        lateDeductionPct: lateDeductionPct ?? 0,
        partialFullDayDeductionPct: partialFullDayDeductionPct ?? 25,
        halfDayDeductionPct: halfDayDeductionPct ?? 50,
        halfTimeLateDeductionPct: halfTimeLateDeductionPct ?? 50,
        createdBy: new mongoose.Types.ObjectId(admin.id),
      };
      if (label !== undefined) update.label = label;
      if (userId) {
        update.userId = new mongoose.Types.ObjectId(userId);
        update.$unset = { role: '' };
      } else {
        update.role = role;
        update.$unset = { userId: '' };
      }

      const { $unset, ...setFields } = update;
      const existing = await AttendanceRule.findOne(filter);

      if (existing) {
        await AttendanceRule.findByIdAndUpdate(
          existing._id,
          { $set: setFields, $unset },
          { new: true, runValidators: true }
        );
        res.json({ action: 'updated', ruleId: String(existing._id) });
      } else {
        const rule = new AttendanceRule(setFields);
        await rule.save();
        res.status(201).json({ action: 'created', ruleId: String(rule._id) });
      }
    } catch (err: any) {
      console.error('[AttendanceRuleController] upsertRule error:', err);
      res.status(500).json({ message: 'Failed to upsert rule.' });
    }
  }

  // DELETE /api/attendance-rules/:id
  public static async deleteRule(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({ message: 'Invalid rule id.' });
        return;
      }

      const rule = await AttendanceRule.findByIdAndDelete(id);
      if (!rule) {
        res.status(404).json({ message: 'Rule not found.' });
        return;
      }

      res.json({ message: 'Rule deleted.' });
    } catch (err) {
      console.error('[AttendanceRuleController] deleteRule error:', err);
      res.status(500).json({ message: 'Failed to delete rule.' });
    }
  }
}

export default AttendanceRuleController;
