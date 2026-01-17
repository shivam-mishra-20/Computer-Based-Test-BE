import axios from 'axios';
import User from '../models/User';
import QueueService from './QueueService';
import AuditLog from '../models/AuditLog';

// Interface matching actual DownloadPunchData API response
interface EtimePunch {
  Name: string;
  Empcode: string;
  PunchDate: string; // "13/01/2026 10:56:00"
  M_Flag: string | null;
}

// The API returns data wrapped in an object with PunchData array
interface EtimeResponse {
  Error: boolean;
  Msg: string;
  IsAdmin?: boolean;
  PunchData: EtimePunch[];
}

class EtimeService {
  private static instance: EtimeService;
  private baseUrl: string;
  // Basic Auth credentials for eTimeOffice API
  private basicAuthUsername: string = 'AbhigyanGurukul:AbhigyanGurukul:ABGU4698@:true';
  private basicAuthPassword: string = ''; // Empty password as per API requirements

  private constructor() {
    this.baseUrl = process.env.ETIME_API_URL || 'https://api.etimeoffice.com/api';
  }

  public static getInstance(): EtimeService {
    if (!EtimeService.instance) {
      EtimeService.instance = new EtimeService();
    }
    return EtimeService.instance;
  }

  /**
   * Get Basic Auth header for eTimeOffice API
   * Username: AbhigyanGurukul:AbhigyanGurukul:ABGU4698@:true
   * Password: (empty)
   */
  private getBasicAuthHeader(): string {
    const credentials = Buffer.from(`${this.basicAuthUsername}:${this.basicAuthPassword}`).toString('base64');
    return `Basic ${credentials}`;
  }

  /**
   * Fetch attendance for a specific date range
   * @param fromDate Format: dd/mm/yyyy (will be converted to dd/mm/yyyy_HH:mm)
   * @param toDate Format: dd/mm/yyyy (will be converted to dd/mm/yyyy_HH:mm)
   */
  public async syncAttendance(fromDate: string, toDate: string): Promise<{ processed: number; failed: number }> {
    console.log('=== EtimeService.syncAttendance START ===');
    console.log('Date range:', fromDate, 'to', toDate);
    
    try {
      // Use correct endpoint: DownloadPunchData (not DownloadInOutPunchData)
      const apiUrl = `${this.baseUrl}/DownloadPunchData`;
      console.log('[Etime] Calling API:', apiUrl);
      
      // Convert date format from dd/mm/yyyy to dd/mm/yyyy_HH:mm
      // Using same format as working Postman example
      const formattedFromDate = `${fromDate}_00:00`;
      const formattedToDate = `${toDate}_23:59`;
      
      const authHeader = this.getBasicAuthHeader();
      console.log('[Etime] Auth header (first 30 chars):', authHeader.substring(0, 30) + '...');
      
      const config = {
        params: {
          Empcode: 'ALL',
          FromDate: formattedFromDate,
          ToDate: formattedToDate
        },
        headers: {
          'Authorization': authHeader
        }
      };

      console.log('[Etime] API Request params:', JSON.stringify(config.params));
      console.log('[Etime] Full URL will be:', `${apiUrl}?Empcode=ALL&FromDate=${formattedFromDate}&ToDate=${formattedToDate}`);

      const response = await axios.get<EtimeResponse>(apiUrl, config);
      console.log('[Etime] API Response status:', response.status);
      console.log('[Etime] API Response Error:', response.data.Error, 'Msg:', response.data.Msg);

      // Check for API error
      if (response.data.Error) {
        console.error('[Etime] API returned error:', response.data.Msg);
        throw new Error(`eTimeOffice API Error: ${response.data.Msg}`);
      }

      // Extract PunchData from the response wrapper
      const punches = response.data.PunchData || [];
      console.log(`[Etime] Fetched ${punches.length} punch records from PunchData`);
      
      if (punches.length > 0) {
        console.log('[Etime] Sample punch:', JSON.stringify(punches[0]));
        console.log('[Etime] Last punch:', JSON.stringify(punches[punches.length - 1]));
      } else {
        console.log('[Etime] WARNING: No punch records in PunchData array!');
      }

      let processed = 0;
      let failed = 0;

      // Fetch all users with empCode
      const potentialUsers = await User.find({ empCode: { $exists: true, $ne: null } }).select('_id empCode name');
      console.log(`[Etime] Found ${potentialUsers.length} users with empCode in DB`);
      
      if (potentialUsers.length > 0) {
        console.log('[Etime] Sample users:', potentialUsers.slice(0, 3).map(u => ({ empCode: u.empCode, name: u.name })));
      }
      const empCodes = punches.map(p => p.Empcode).filter((v, i, a) => a.indexOf(v) === i); // Unique
      console.log('[Etime] Unique empCodes from API:', empCodes.slice(0, 5), '...');
      
      // Create a map of TRIMMED empCode -> userId
      const userMap = new Map();
      potentialUsers.forEach(u => {
        if (u.empCode) {
           userMap.set(u.empCode.trim(), u._id);
           userMap.set(u.empCode, u._id);
        }
      });
      
      console.log('[Etime] UserMap size:', userMap.size);

      // ========================================
      // GROUP PUNCHES BY EMPLOYEE + DATE
      // First punch of day = Clock IN
      // Second/Last punch of day = Clock OUT
      // ========================================
      
      // Group punches by Empcode + Date
      const punchGroups = new Map<string, EtimePunch[]>();
      
      for (const punch of punches) {
        // Parse PunchDate "dd/mm/yyyy HH:mm:ss" format
        const [datePart] = punch.PunchDate.split(' ');
        const key = `${punch.Empcode.trim()}_${datePart}`; // empcode_dd/mm/yyyy
        
        if (!punchGroups.has(key)) {
          punchGroups.set(key, []);
        }
        punchGroups.get(key)!.push(punch);
      }
      
      console.log(`[Etime] Grouped into ${punchGroups.size} employee-date combinations`);

      // Process each employee-date group
      for (const [key, groupPunches] of punchGroups.entries()) {
        try {
          const punchCode = groupPunches[0].Empcode.trim();
          const userId = userMap.get(punchCode);
          
          if (!userId) {
            console.log(`[Etime] No user found for Empcode: ${punchCode}`);
            continue;
          }
          
          // Sort punches by time to get first (clock in) and last (clock out)
          const sortedPunches = groupPunches.sort((a, b) => {
            const timeA = a.PunchDate.split(' ')[1] || '00:00:00';
            const timeB = b.PunchDate.split(' ')[1] || '00:00:00';
            return timeA.localeCompare(timeB);
          });
          
          const firstPunch = sortedPunches[0];
          const lastPunch = sortedPunches.length > 1 ? sortedPunches[sortedPunches.length - 1] : null;
          
          // Parse date
          const [datePart] = firstPunch.PunchDate.split(' ');
          const [day, month, year] = datePart.split('/');
          const dateObj = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
          
          // Extract times
          const clockInTime = firstPunch.PunchDate.split(' ')[1]?.substring(0, 5); // HH:mm
          const clockOutTime = lastPunch ? lastPunch.PunchDate.split(' ')[1]?.substring(0, 5) : undefined;
          
          console.log(`[Etime] Processing ${punchCode} on ${datePart}: ClockIn=${clockInTime}, ClockOut=${clockOutTime || 'N/A'} (${sortedPunches.length} punches)`);

          // Add to Queue with aggregated clock in/out times
          await QueueService.add({
            studentId: userId.toString(),
            date: dateObj,
            status: 'present',
            markedBy: userId.toString(), 
            source: 'external',
            idempotencyKey: `etime-${punchCode}-${datePart}`, // One record per employee per day
            clockIn: clockInTime,
            clockOut: clockOutTime,
            metadata: {
              punchCount: sortedPunches.length,
              firstPunchTime: firstPunch.PunchDate,
              lastPunchTime: lastPunch?.PunchDate || firstPunch.PunchDate,
              apiName: firstPunch.Name,
              mFlag: firstPunch.M_Flag
            }
          });

          processed++;
        } catch (err) {
          console.error(`[Etime] Error processing group ${key}:`, err);
          failed++;
        }
      }

      await AuditLog.create({
        action: 'SYNC_ETIME',
        status: 'success',
        entity: 'System',
        metadata: { fromDate, toDate, totalPunches: punches.length, groupsProcessed: punchGroups.size, processed, failed }
      });

      return { processed, failed };

    } catch (error: any) {
      console.error('Etime Sync Error:', error.message);
      await AuditLog.create({
        action: 'SYNC_ETIME',
        status: 'failure',
        entity: 'System',
        errorMessage: error.message
      });
      throw error;
    }
  }
}

export default EtimeService.getInstance();
