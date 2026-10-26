import cron from 'node-cron';
import { forEachOrg } from '../core/tenancy';
import { runSyncAndRecord } from './attendanceSyncRuns';
import { assessAutoSync, autoSyncRange } from './etimeSyncLogic';
import AuditLog from '../models/AuditLog';
import { broadcastNotification } from './notificationService';

/**
 * AttendanceCron - Schedules automatic attendance sync 4 times daily:
 * - 11:40 AM IST
 * - 4:00 PM IST
 * - 9:00 PM IST
 * - 3:00 AM IST
 */
/**
 * "Attendance Updated" — the inbox entry AND the push, from ONE call.
 *
 * Both sync paths used to `Notification.create({ body })` and then call
 * broadcastNotification. The model requires `message`, so every create was
 * rejected, `Promise.all` threw, and the broadcast after it never ran: no inbox
 * entry and no push for any attendance sync. Renaming the field alone would
 * have stored each notification twice, because broadcastNotification
 * (sendStudentNotifications) already persists one per recipient — with
 * `message` — before pushing. So it is now the only call.
 */
export const ATTENDANCE_SYNC_NOTICE = {
  title: 'Attendance Updated',
  body: 'Your attendance has been synced. Check your attendance records for the latest updates.',
  type: 'attendance',
  data: {
    type: 'attendance',
    role: 'student',
    screen: '/(student)/modules/attendance',
  },
} as const;

export async function notifyAttendanceSynced(userIds: string[]): Promise<void> {
  if (!userIds.length) return;
  await broadcastNotification(userIds, {
    ...ATTENDANCE_SYNC_NOTICE,
    data: { ...ATTENDANCE_SYNC_NOTICE.data },
  });
}
export class AttendanceCron {
  private static scheduled = false;

  // Cron schedule configuration (hour/minute are IST, matching `cron`)
  private static readonly SYNC_TIMES = [
    { cron: '40 11 * * *', label: '11:40 AM IST', hour: 11, minute: 40 },
    { cron: '0 16 * * *', label: '4:00 PM IST', hour: 16, minute: 0 },
    { cron: '0 21 * * *', label: '9:00 PM IST', hour: 21, minute: 0 },
    { cron: '0 3 * * *', label: '3:00 AM IST', hour: 3, minute: 0 },
  ];

  /** The schedule, for the admin page's "is auto-sync working" check. */
  public static get schedule() {
    return this.SYNC_TIMES.map(({ label, hour, minute }) => ({ label, hour, minute }));
  }

  /**
   * Initialize cron jobs for attendance auto-sync
   * Runs 4 times daily at the configured times
   */
  public static init(): void {
    if (this.scheduled) {
      console.log('[AttendanceCron] Already initialized, skipping...');
      return;
    }

    // Schedule all 4 sync times
    for (const schedule of this.SYNC_TIMES) {
      cron.schedule(schedule.cron, async () => {
        console.log(`[AttendanceCron] Starting scheduled auto-sync at ${schedule.label}...`);
        // Wrapped at the SCHEDULING boundary, not inside runAutoSync(), so the
        // method stays callable from a request handler — where the request's
        // own tenant context is already open and must not be replaced.
        //
        // forEachOrg isolates failures: one organization with a bad eTimeOffice
        // credential must not stop attendance sync for every other tenant.
        await forEachOrg('attendance-sync', () => this.runAutoSync());
      }, {
        timezone: 'Asia/Kolkata' // IST timezone
      });
      
      console.log(`[AttendanceCron] Scheduled daily auto-sync at ${schedule.label}`);
    }

    this.scheduled = true;
    console.log('[AttendanceCron] All 4 daily sync schedules initialized');

    // A scheduled time that passed while the server was down or redeploying
    // never fires later on its own, so the missed sync is made up shortly after
    // boot. Delayed so it does not compete with startup.
    setTimeout(() => {
      forEachOrg('attendance-sync-catch-up', async () => {
        if (await this.missedScheduledSync()) {
          console.warn('[AttendanceCron] A scheduled sync was missed — running a catch-up sync now');
          await this.runAutoSync();
        }
      }).catch((error) => console.error('[AttendanceCron] Catch-up check failed:', error?.message || error));
    }, 60_000).unref();
  }

  /** True when the last scheduled slot has no completed sync after it. */
  private static async missedScheduledSync(): Promise<boolean> {
    const latest = (action: string) =>
      AuditLog.findOne({ action }).sort({ createdAt: -1 }).select('createdAt').lean();
    const [lastStart, lastComplete, lastFailure] = await Promise.all([
      latest('AUTO_SYNC_ATTENDANCE_START'),
      latest('AUTO_SYNC_ATTENDANCE_COMPLETE'),
      latest('AUTO_SYNC_ATTENDANCE_FAILED'),
    ]);
    const { status } = assessAutoSync(new Date(), this.schedule, {
      lastStart: (lastStart as any)?.createdAt,
      lastComplete: (lastComplete as any)?.createdAt,
      lastFailure: (lastFailure as any)?.createdAt,
    });
    return status !== 'ok' && status !== 'running';
  }

  /**
   * Run the auto-sync process - syncs attendance from start of month to today
   * After sync, sends push notifications to users whose attendance was updated
   */
  public static async runAutoSync(): Promise<{ success: boolean; processed?: number; notified?: number; error?: string }> {
    const startTime = Date.now();
    
    try {
      // Month to date in India time, always including yesterday (see autoSyncRange)
      const { fromDate, toDate } = autoSyncRange(new Date());

      console.log(`[AttendanceCron] Auto-sync from ${fromDate} to ${toDate}`);

      // Log audit before sync
      await AuditLog.create({
        action: 'AUTO_SYNC_ATTENDANCE_START',
        entity: 'Attendance',
        metadata: { fromDate, toDate, triggeredBy: 'cron' }
      });

      const result = await runSyncAndRecord({ fromDate, toDate, trigger: 'cron' });

      const duration = Date.now() - startTime;
      console.log(`[AttendanceCron] Auto-sync completed in ${duration}ms. Processed: ${result.processed}, Failed: ${result.failed}, Users updated: ${result.updatedUserIds.length}`);

      // Send push notifications to users whose attendance was updated
      let notified = 0;
      if (result.updatedUserIds.length > 0) {
        try {
          console.log(`[AttendanceCron] Sending notifications to ${result.updatedUserIds.length} users...`);
          
          await notifyAttendanceSynced(result.updatedUserIds);
          
          notified = result.updatedUserIds.length;
          console.log(`[AttendanceCron] Successfully notified ${notified} users`);
        } catch (notifError: any) {
          console.error('[AttendanceCron] Error sending notifications:', notifError.message);
          // Don't fail the entire sync if notifications fail
        }
      }

      // Log audit after sync
      await AuditLog.create({
        action: 'AUTO_SYNC_ATTENDANCE_COMPLETE',
        status: 'success',
        entity: 'Attendance',
        metadata: { fromDate, toDate, ...result, notified, durationMs: duration }
      });

      return { success: true, processed: result.processed, notified };
    } catch (error: any) {
      console.error('[AttendanceCron] Auto-sync failed:', error.message);
      
      await AuditLog.create({
        action: 'AUTO_SYNC_ATTENDANCE_FAILED',
        status: 'failure',
        entity: 'Attendance',
        errorMessage: error.message
      });

      return { success: false, error: error.message };
    }
  }

  /**
   * Trigger manual sync (can be called from API)
   */
  public static async triggerManualSync(fromDate: string, toDate: string): Promise<{ success: boolean; message: string; notified?: number }> {
    console.log(`[AttendanceCron] Manual sync triggered: ${fromDate} to ${toDate}`);
    
    try {
      await AuditLog.create({
        action: 'MANUAL_SYNC_ATTENDANCE_START',
        entity: 'Attendance',
        metadata: { fromDate, toDate, triggeredBy: 'manual' }
      });

      const result = await runSyncAndRecord({ fromDate, toDate, trigger: 'api' });

      // Send notifications for manual sync too
      let notified = 0;
      if (result.updatedUserIds.length > 0) {
        try {
          await notifyAttendanceSynced(result.updatedUserIds);
          
          notified = result.updatedUserIds.length;
        } catch (notifError: any) {
          console.error('[AttendanceCron] Error sending notifications:', notifError.message);
        }
      }

      await AuditLog.create({
        action: 'MANUAL_SYNC_ATTENDANCE_COMPLETE',
        status: 'success',
        entity: 'Attendance',
        metadata: { fromDate, toDate, ...result, notified }
      });

      return { 
        success: true, 
        message: `Sync completed. Processed: ${result.processed}, Failed: ${result.failed}, Notified: ${notified}`,
        notified
      };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }
}

export default AttendanceCron;
