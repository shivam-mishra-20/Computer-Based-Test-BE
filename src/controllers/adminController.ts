 import { Request, Response } from 'express';
import AppSetting from '../models/AppSetting';
import AuditLog from '../models/AuditLog';

export const listSettings = async (_req: Request, res: Response) => {
  const items = await AppSetting.find({}).sort({ key: 1 });
  res.json({ items });
};

export const upsertSetting = async (req: Request, res: Response) => {
  const { key, value, description } = req.body as { key: string; value: any; description?: string };
  if (!key) return res.status(400).json({ message: 'key is required' });
  const updatedBy = (req as any).user?.id;
  const doc = await AppSetting.findOneAndUpdate(
    { key },
    { $set: { value, description, updatedBy } },
    { upsert: true, new: true }
  );
  res.json(doc);
};

export const deleteSetting = async (req: Request, res: Response) => {
  const { key } = req.params;
  await AppSetting.deleteOne({ key });
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
