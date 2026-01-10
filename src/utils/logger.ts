import AuditLog from '../models/AuditLog';
import { Types } from 'mongoose';

// Audit logging to database
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

// ============ Structured Console Logging ============

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  meta?: object;
}

function formatLog(entry: LogEntry): string {
  const base = `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`;
  if (entry.meta) {
    return `${base} ${JSON.stringify(entry.meta)}`;
  }
  return base;
}

export function log(level: LogLevel, message: string, meta?: object): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    meta
  };

  const formatted = formatLog(entry);

  switch (level) {
    case 'error':
      console.error(formatted);
      break;
    case 'warn':
      console.warn(formatted);
      break;
    case 'debug':
      if (process.env.NODE_ENV === 'development') {
        console.log(formatted);
      }
      break;
    default:
      console.log(formatted);
  }
}

export const logger = {
  info: (message: string, meta?: object) => log('info', message, meta),
  warn: (message: string, meta?: object) => log('warn', message, meta),
  error: (message: string, meta?: object) => log('error', message, meta),
  debug: (message: string, meta?: object) => log('debug', message, meta),
};
