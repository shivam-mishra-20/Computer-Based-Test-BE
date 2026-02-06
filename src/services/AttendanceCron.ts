import cron from 'node-cron';
import EtimeService from './EtimeService';
import AuditLog from '../models/AuditLog';
import { broadcastNotification } from './notificationService';
import Notification from '../models/Notification';

/**
 * AttendanceCron - Schedules automatic attendance sync 4 times daily:
 * - 11:40 AM IST
 * - 4:00 PM IST
 * - 9:00 PM IST
 * - 3:00 AM IST
 */
export class AttendanceCron {
  private static scheduled = false;

  // Cron schedule configuration
  private static readonly SYNC_TIMES = [
    { cron: '40 11 * * *', label: '11:40 AM IST' },
    { cron: '0 16 * * *', label: '4:00 PM IST' },
    { cron: '0 21 * * *', label: '9:00 PM IST' },
    { cron: '0 3 * * *', label: '3:00 AM IST' },
  ];

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
        await this.runAutoSync();
      }, {
        timezone: 'Asia/Kolkata' // IST timezone
      });
      
      console.log(`[AttendanceCron] Scheduled daily auto-sync at ${schedule.label}`);
    }

    this.scheduled = true;
    console.log('[AttendanceCron] All 4 daily sync schedules initialized');
  }

  /**
   * Run the auto-sync process - syncs attendance from start of month to today
   * After sync, sends push notifications to users whose attendance was updated
   */
  public static async runAutoSync(): Promise<{ success: boolean; processed?: number; notified?: number; error?: string }> {
    const startTime = Date.now();
    
    try {
      // Get today's date in dd/mm/yyyy format
      const today = new Date();
      const toDate = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
      
      // Start from beginning of current month
      const fromDate = `01/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

      console.log(`[AttendanceCron] Auto-sync from ${fromDate} to ${toDate}`);

      // Log audit before sync
      await AuditLog.create({
        action: 'AUTO_SYNC_ATTENDANCE_START',
        entity: 'Attendance',
        metadata: { fromDate, toDate, triggeredBy: 'cron' }
      });

      const result = await EtimeService.syncAttendance(fromDate, toDate);

      const duration = Date.now() - startTime;
      console.log(`[AttendanceCron] Auto-sync completed in ${duration}ms. Processed: ${result.processed}, Failed: ${result.failed}, Users updated: ${result.updatedUserIds.length}`);

      // Send push notifications to users whose attendance was updated
      let notified = 0;
      if (result.updatedUserIds.length > 0) {
        try {
          console.log(`[AttendanceCron] Sending notifications to ${result.updatedUserIds.length} users...`);
          
          // Create in-app notifications for each user
          const notificationPromises = result.updatedUserIds.map(userId => 
            Notification.create({
              userId,
              title: 'Attendance Updated',
              body: 'Your attendance has been synced. Check your attendance records for the latest updates.',
              type: 'attendance_sync',
              read: false
            })
          );
          await Promise.all(notificationPromises);
          
          // Send push notifications
          await broadcastNotification(result.updatedUserIds, {
            title: 'Attendance Updated',
            body: 'Your attendance has been synced. Check your attendance records for the latest updates.',
            type: 'attendance_sync',
            data: { screen: 'Attendance' }
          });
          
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

      const result = await EtimeService.syncAttendance(fromDate, toDate);

      // Send notifications for manual sync too
      let notified = 0;
      if (result.updatedUserIds.length > 0) {
        try {
          // Create in-app notifications
          const notificationPromises = result.updatedUserIds.map(userId => 
            Notification.create({
              userId,
              title: 'Attendance Updated',
              body: 'Your attendance has been synced. Check your attendance records for the latest updates.',
              type: 'attendance_sync',
              read: false
            })
          );
          await Promise.all(notificationPromises);
          
          // Send push notifications
          await broadcastNotification(result.updatedUserIds, {
            title: 'Attendance Updated',
            body: 'Your attendance has been synced. Check your attendance records for the latest updates.',
            type: 'attendance_sync',
            data: { screen: 'Attendance' }
          });
          
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
