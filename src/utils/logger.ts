import AuditLog from '../models/AuditLog';
import { Types } from 'mongoose';

export async function logAudit(
	userId: string | Types.ObjectId | undefined,
	action: string,
	resource?: string,
	meta?: Record<string, any>
) {
	try {
		if (!userId) return;
		await AuditLog.create({
			userId: new Types.ObjectId(String(userId)),
			action,
			resource,
			meta,
		});
	} catch {
		// ignore logging failures
	}
}

