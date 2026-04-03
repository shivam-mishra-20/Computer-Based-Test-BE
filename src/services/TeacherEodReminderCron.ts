import cron from 'node-cron';
import User from '../models/User';
import { broadcastNotification } from './notificationService';

export class TeacherEodReminderCron {
  private static initialized = false;
  private static readonly REMINDER_CRON = '0 20 * * *'; // 8:00 PM IST

  public static init(): void {
    if (this.initialized) {
      console.log('[TeacherEodReminderCron] Already initialized, skipping...');
      return;
    }

    cron.schedule(this.REMINDER_CRON, async () => {
      console.log('[TeacherEodReminderCron] Running 8 PM daily reminder job...');
      await this.sendDailyReminder();
    }, {
      timezone: 'Asia/Kolkata'
    });

    this.initialized = true;
    console.log('[TeacherEodReminderCron] Scheduled 8 PM IST daily reminder for teacher reports');
  }

  public static async sendDailyReminder(): Promise<{ success: boolean; notified?: number; error?: string }> {
    try {
      const teachers = await User.find({ role: 'teacher', status: 'approved' })
        .select('_id')
        .lean();

      const teacherIds = teachers.map((teacher: any) => String(teacher._id));

      if (teacherIds.length === 0) {
        console.log('[TeacherEodReminderCron] No approved teachers found for reminder');
        return { success: true, notified: 0 };
      }

      await broadcastNotification(teacherIds, {
        title: 'EOD Report Reminder',
        body: 'Please submit your daily work report for today (10:30 AM to 7:30 PM).',
        type: 'general',
        data: {
          type: 'teacher_daily_work_report_reminder',
          role: 'teacher',
          screen: '/(teacher)/more/eod',
          workWindow: {
            startTime: '10:30',
            endTime: '19:30'
          }
        }
      });

      console.log(`[TeacherEodReminderCron] Sent reminder to ${teacherIds.length} teachers`);
      return { success: true, notified: teacherIds.length };
    } catch (error: any) {
      console.error('[TeacherEodReminderCron] Failed to send reminders:', error);
      return { success: false, error: error.message };
    }
  }
}

export default TeacherEodReminderCron;
