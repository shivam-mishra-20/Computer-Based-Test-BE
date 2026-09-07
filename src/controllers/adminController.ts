 import { Request, Response } from 'express';
import AppSetting from '../models/AppSetting';
import AuditLog from '../models/AuditLog';
import { tenantScope } from '../core/tenancy';

/**
 * Settings are per organization.
 *
 * `AppSetting.key` used to be globally unique, so these three handlers operated
 * on a single shared row per key. In a claim-mode process that means one
 * institute's admin listing, editing or DELETING another institute's settings —
 * and for the time-slot keys, silently rewriting their timetable.
 *
 * `tenantScope()` is a no-op where there is no context, so a pinned or
 * pre-migration deployment behaves exactly as before.
 */
export const listSettings = async (_req: Request, res: Response) => {
  const items = await AppSetting.find({ ...tenantScope() }).sort({ key: 1 });
  res.json({ items });
};

export const upsertSetting = async (req: Request, res: Response) => {
  const { key, value, description } = req.body as { key: string; value: any; description?: string };
  if (!key) return res.status(400).json({ message: 'key is required' });
  const updatedBy = (req as any).user?.id;
  const doc = await AppSetting.findOneAndUpdate(
    { ...tenantScope(), key },
    { $set: { value, description, updatedBy } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  res.json(doc);
};

export const deleteSetting = async (req: Request, res: Response) => {
  const { key } = req.params;
  const removed = await AppSetting.deleteOne({ ...tenantScope(), key });
  if (!removed.deletedCount) return res.status(404).json({ message: 'setting not found' });
  res.json({ message: 'deleted' });
};

export const listAuditLogs = async (req: Request, res: Response) => {
  const { limit = '50', skip = '0', action, userId } = req.query as any;
  const filter: any = {};
  if (action) filter.action = action;
  if (userId) filter.userId = userId;
  const items = await AuditLog.find(filter)
    .sort({ createdAt: -1 })
    .skip(parseInt(skip, 10))
    .limit(parseInt(limit, 10));
  const total = await AuditLog.countDocuments(filter);
  res.json({ items, total });
};
