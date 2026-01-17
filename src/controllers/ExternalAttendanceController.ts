import { Request, Response } from 'express';
import EtimeService from '../services/EtimeService';

export class ExternalAttendanceController {
  
  // POST /api/attendance/fetch-external
  public static async fetchExternal(req: Request, res: Response): Promise<void> {
    console.log('=== ExternalAttendanceController.fetchExternal START ===');
    console.log('[ExternalAttendance] Request body:', JSON.stringify(req.body));
    
    try {
      const { fromDate, toDate } = req.body; // Expects "dd/mm/yyyy" format
      
      console.log('[ExternalAttendance] Parsed dates - fromDate:', fromDate, 'toDate:', toDate);
      
      if (!fromDate || !toDate) {
        console.log('[ExternalAttendance] ERROR: Missing date parameters');
        res.status(400).json({ message: 'Missing fromDate or toDate (dd/mm/yyyy)' });
        return;
      }

      // Validate date format (should be dd/mm/yyyy)
      const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
      if (!dateRegex.test(fromDate) || !dateRegex.test(toDate)) {
        console.log('[ExternalAttendance] ERROR: Invalid date format. Expected dd/mm/yyyy');
        console.log('[ExternalAttendance] fromDate format valid:', dateRegex.test(fromDate));
        console.log('[ExternalAttendance] toDate format valid:', dateRegex.test(toDate));
        res.status(400).json({ message: 'Invalid date format. Expected dd/mm/yyyy' });
        return;
      }

      console.log('[ExternalAttendance] Starting async sync with EtimeService...');
      
      // Async trigger - fire and forget, returns immediately
      EtimeService.syncAttendance(fromDate, toDate)
        .then(stats => {
          console.log('[ExternalAttendance] Sync completed successfully!');
          console.log('[ExternalAttendance] Stats:', JSON.stringify(stats));
        })
        .catch(err => {
          console.error('[ExternalAttendance] Sync FAILED!');
          console.error('[ExternalAttendance] Error:', err.message);
          console.error('[ExternalAttendance] Stack:', err.stack);
        });

      console.log('[ExternalAttendance] Responding with 202 Accepted');
      res.status(202).json({ 
        message: 'Sync started successfully', 
        details: 'Check audit logs for completion status.',
        requestedDates: { fromDate, toDate }
      });

    } catch (error: any) {
      console.error('[ExternalAttendance] Controller Error:', error.message);
      console.error('[ExternalAttendance] Stack:', error.stack);
      res.status(500).json({ message: 'Internal Server Error' });
    }
  }
}

export default ExternalAttendanceController;
