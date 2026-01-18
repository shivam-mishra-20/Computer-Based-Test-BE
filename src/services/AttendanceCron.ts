import cron from 'node-cron';
import EtimeService from './EtimeService';
import AuditLog from '../models/AuditLog';

/**
 * AttendanceCron - Schedules automatic attendance sync at 9 PM daily
 */
export class AttendanceCron {
  private static scheduled = false;

  /**
   * Initialize cron job for attendance auto-sync
   * Runs every day at 9:00 PM IST (21:00)
   */
  public static init(): void {
    if (this.scheduled) {
      console.log('[AttendanceCron] Already initialized, skipping...');
      return;
    }

    // Schedule for 9 PM IST every day
    // Cron format: minute hour day month dayOfWeek
    // 0 21 * * * = At 21:00 (9 PM) every day
    cron.schedule('0 21 * * *', async () => {
      console.log('[AttendanceCron] Starting scheduled auto-sync at 9 PM...');
      await this.runAutoSync();
    }, {
      timezone: 'Asia/Kolkata' // IST timezone
    });

    this.scheduled = true;
    console.log('[AttendanceCron] Scheduled daily auto-sync at 9:00 PM IST');
  }

  /**
   * Run the auto-sync process - syncs attendance from start of month to today
   */
  public static async runAutoSync(): Promise<{ success: boolean; processed?: number; error?: string }> {
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
        status: 'info',
        entity: 'Attendance',
        metadata: { fromDate, toDate, triggeredBy: 'cron' }
      });

      const result = await EtimeService.syncAttendance(fromDate, toDate);

      const duration = Date.now() - startTime;
      console.log(`[AttendanceCron] Auto-sync completed in ${duration}ms. Processed: ${result.processed}, Failed: ${result.failed}`);

      // Log audit after sync
      await AuditLog.create({
        action: 'AUTO_SYNC_ATTENDANCE_COMPLETE',
        status: 'success',
        entity: 'Attendance',
        metadata: { fromDate, toDate, ...result, durationMs: duration }
      });

      return { success: true, processed: result.processed };
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
  public static async triggerManualSync(fromDate: string, toDate: string): Promise<{ success: boolean; message: string }> {
    console.log(`[AttendanceCron] Manual sync triggered: ${fromDate} to ${toDate}`);
    
    try {
      await AuditLog.create({
        action: 'MANUAL_SYNC_ATTENDANCE_START',
        status: 'info',
        entity: 'Attendance',
        metadata: { fromDate, toDate, triggeredBy: 'manual' }
      });

      const result = await EtimeService.syncAttendance(fromDate, toDate);

      await AuditLog.create({
        action: 'MANUAL_SYNC_ATTENDANCE_COMPLETE',
        status: 'success',
        entity: 'Attendance',
        metadata: { fromDate, toDate, ...result }
      });

      return { success: true, message: `Sync completed. Processed: ${result.processed}, Failed: ${result.failed}` };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }
}

export default AttendanceCron;
