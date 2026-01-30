import cron, { ScheduledTask } from 'node-cron';
import AutomationStatus from '../models/AutomationStatus';
import { exec } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

class AutomationScheduler {
  private scheduledTask: ScheduledTask | null = null;
  private isInitialized = false;

  /**
   * Initialize the scheduler and load schedule from database
   */
  async initialize() {
    if (this.isInitialized) {
      console.log('[Scheduler] Already initialized');
      return;
    }

    console.log('[Scheduler] Initializing automation scheduler...');

    // Load current schedule from database
    const status = await AutomationStatus.findOne();
    
    if (status && status.isEnabled && status.schedule?.cronExpression) {
      this.startSchedule(status.schedule.cronExpression);
    } else {
      console.log('[Scheduler] No schedule configured or automation disabled');
    }

    this.isInitialized = true;
  }

  /**
   * Start a new schedule with the given cron expression
   */
  startSchedule(cronExpression: string) {
    // Stop existing schedule if any
    this.stopSchedule();

    console.log(`[Scheduler] Starting new schedule: ${cronExpression}`);

    // Validate cron expression
    if (!cron.validate(cronExpression)) {
      throw new Error(`Invalid cron expression: ${cronExpression}`);
    }

    // Create new scheduled task
    this.scheduledTask = cron.schedule(cronExpression, async () => {
      console.log(`[Scheduler] Triggered at ${new Date().toISOString()}`);
      await this.runAutomation();
    });

    console.log('[Scheduler] Schedule started successfully');
  }

  /**
   * Stop the current schedule
   */
  stopSchedule() {
    if (this.scheduledTask) {
      console.log('[Scheduler] Stopping current schedule');
      this.scheduledTask.stop();
      this.scheduledTask.destroy();
      this.scheduledTask = null;
    }
  }

  /**
   * Update schedule configuration
   */
  async updateSchedule(cronExpression: string, enabled: boolean) {
    console.log(`[Scheduler] Updating schedule: ${cronExpression}, enabled: ${enabled}`);

    // Validate cron expression
    if (!cron.validate(cronExpression)) {
      throw new Error(`Invalid cron expression: ${cronExpression}`);
    }

    // Update database
    const status = await AutomationStatus.findOne();
    if (status) {
      status.schedule = {
        cronExpression,
        enabled,
        lastModified: new Date()
      };
      await status.save();
    } else {
      await AutomationStatus.create({
        isEnabled: enabled,
        schedule: {
          cronExpression,
          enabled,
          lastModified: new Date()
        }
      });
    }

    // Restart scheduler if enabled
    if (enabled) {
      this.startSchedule(cronExpression);
    } else {
      this.stopSchedule();
    }

    console.log('[Scheduler] Schedule updated successfully');
  }

  /**
   * Execute the automation script
   */
  private async runAutomation() {
    try {
      // Check if automation is still enabled
      const status = await AutomationStatus.findOne();
      if (!status || !status.isEnabled) {
        console.log('[Scheduler] Automation disabled, skipping run');
        return;
      }

      // Check if already running
      if (status.currentlyRunning) {
        console.log('[Scheduler] Automation already running, skipping');
        return;
      }

      console.log('[Scheduler] Executing automation script...');

      // Path to automation script
      const scriptPath = path.resolve(process.cwd(), 'scripts', 'automation-runner.js');

      // Execute the script
      const { stdout, stderr } = await execAsync(`node "${scriptPath}"`);

      if (stdout) {
        console.log('[Scheduler] Script output:', stdout);
      }

      if (stderr) {
        console.error('[Scheduler] Script errors:', stderr);
      }

      console.log('[Scheduler] Automation completed successfully');
    } catch (error) {
      console.error('[Scheduler] Error running automation:', error);
    }
  }

  /**
   * Get current schedule status
   */
  async getScheduleStatus() {
    const status = await AutomationStatus.findOne();
    return {
      isScheduled: !!this.scheduledTask,
      cronExpression: status?.schedule?.cronExpression || null,
      enabled: status?.schedule?.enabled || false,
      lastModified: status?.schedule?.lastModified || null
    };
  }

  /**
   * Convert human-readable schedule to cron expression
   */
  static parseSchedule(time: string, days?: number[]): string {
    // time format: "HH:MM" (24-hour)
    const [hours, minutes] = time.split(':').map(Number);

    if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      throw new Error('Invalid time format. Use HH:MM (24-hour)');
    }

    // days: [0=Sunday, 1=Monday, ..., 6=Saturday]
    const dayString = days && days.length > 0 ? days.join(',') : '*';

    // Cron format: minute hour day month dayOfWeek
    return `${minutes} ${hours} * * ${dayString}`;
  }

  /**
   * Get human-readable description of cron expression
   */
  static describeCron(cronExpression: string): string {
    const parts = cronExpression.split(' ');
    if (parts.length < 5) return 'Invalid cron expression';

    const [minute, hour, , , dayOfWeek] = parts;

    const timeStr = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    
    if (dayOfWeek === '*') {
      return `Daily at ${timeStr}`;
    } else if (dayOfWeek === '1-5') {
      return `Weekdays at ${timeStr}`;
    } else if (dayOfWeek === '0,6') {
      return `Weekends at ${timeStr}`;
    } else {
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const selectedDays = dayOfWeek.split(',').map(d => dayNames[parseInt(d)]).join(', ');
      return `${selectedDays} at ${timeStr}`;
    }
  }
}

// Export singleton instance
export const automationScheduler = new AutomationScheduler();
