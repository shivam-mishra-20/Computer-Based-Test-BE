import User, { IUser } from '../models/User';
import Holiday, { IHoliday } from '../models/Holiday';
import Attendance from '../models/Attendance';
import mongoose from 'mongoose';

export interface AttendanceStats {
  expectedDays: number;
  presentDays: number;
  absentDays: number;
  holidays: number;
  extraDays: number;
  workingDates: string[];
  presentDates: string[];
  absentDates: string[];
  holidayDates: string[];
}

/**
 * Service to calculate attendance statistics including expected days and absences
 */
class AbsentCalculationService {
  
  /**
   * Calculate attendance statistics using uniform Mon-Sat rule
   * 
   * RULE: Working days are Monday to Saturday, excluding:
   * - Sundays (automatically excluded)
   * - Admin-marked holidays
   * 
   * ABSENT = Working days without attendance records (up to today only)
   * 
   * EXTRA DAY = Present on a Sunday or Holiday
   * 
   * @param userId The user ID (student or teacher)
   * @param fromDate Start date
   * @param toDate End date
   */
  public async calculateStats(userId: string, fromDate: Date, toDate: Date): Promise<AttendanceStats> {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    // Cap calculation at today (don't count future dates as absent)
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    const effectiveToDate = toDate > today ? today : toDate;

    // 1. Fetch holidays and attendance records
    const [holidays, attendanceRecords] = await Promise.all([
      this.getHolidaysInRange(fromDate, effectiveToDate),
      this.getAttendanceRecords(userId, fromDate, effectiveToDate)
    ]);

    // 2. Get all dates in range
    const allDates = this.getDatesInRange(fromDate, effectiveToDate);
    
    const workingDates: string[] = [];
    const holidayDates: string[] = [];
    const presentDates = new Set<string>();

    // 3. Build set of present dates from attendance records
    attendanceRecords.forEach(r => {
      presentDates.add(this.toYMD(r.date));
    });

    // 4. Classify each date as working day or holiday
    allDates.forEach(date => {
      const dateStr = this.toYMD(date);
      
      if (this.isHoliday(date, holidays)) {
        // Sunday or admin-marked holiday
        holidayDates.push(dateStr);
      } else {
        // Monday to Saturday (not a holiday)
        workingDates.push(dateStr);
      }
    });

    // 5. Calculate absent dates (working days without attendance)
    const absentDates = workingDates.filter(d => !presentDates.has(d));

    // 6. Calculate extra days (present on holiday/Sunday)
    // Intersection of presentDates and holidayDates
    const extraDaysList = holidayDates.filter(d => presentDates.has(d));

    return {
      expectedDays: workingDates.length,
      presentDays: presentDates.size,
      absentDays: absentDates.length,
      holidays: holidayDates.length,
      extraDays: extraDaysList.length,
      workingDates,
      presentDates: Array.from(presentDates),
      absentDates,
      holidayDates
    };
  }

  // ==========================================
  // Private Helper Methods
  // ==========================================
  
  /**
   * Format Date to YYYY-MM-DD string using Local time to avoid UTC shifts
   * Assuming the input Date objects are meant to interpret "Jan 1 00:00 Local" as "Jan 1"
   */
  private toYMD(date: Date): string {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private async getHolidaysInRange(from: Date, to: Date): Promise<IHoliday[]> {
    return Holiday.find({
      date: { $gte: from, $lte: to }
    });
  }

  private async getAttendanceRecords(userId: string, from: Date, to: Date): Promise<any[]> {
    // Only count "present" records, removing "late" logic as requested
    // Assuming 'status' field or clockIn time presence determines attendance
    return Attendance.find({
      studentId: userId,
      date: { $gte: from, $lte: to },
      $or: [
        { status: 'present' },
        // Late logic removed
        { clockIn: { $ne: '--:--' } }
      ]
    }).select('date clockIn status');
  }

  /**
   * Determine if a specific date is a holiday
   */
  private isHoliday(date: Date, holidays: IHoliday[]): boolean {
    const dateStr = this.toYMD(date);
    const holidayRecord = holidays.find(h => this.toYMD(h.date) === dateStr);
    
    // Explicit holidays
    if (holidayRecord && holidayRecord.type === 'holiday') return true;
    
    // Explicit working days override Sundays
    if (holidayRecord && holidayRecord.type === 'working') return false;
    
    // Default rule: Sunday is holiday
    if (date.getDay() === 0) return true;
    
    return false;
  }

  /**
   * Generate all dates in a range
   */
  private getDatesInRange(from: Date, to: Date): Date[] {
    const dates: Date[] = [];
    const current = new Date(from);
    // Normalize to start of day
    current.setHours(0,0,0,0);
    const end = new Date(to);
    end.setHours(23,59,59,999);

    while (current <= end) {
      dates.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
    return dates;
  }


}

export default new AbsentCalculationService();
