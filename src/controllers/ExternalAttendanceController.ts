import { Request, Response } from 'express';
import AttendanceCron from '../services/AttendanceCron';
import { getSyncOverview, getSyncRun, startSyncRun } from '../services/attendanceSyncRuns';
import { checkSyncRange } from '../services/etimeSyncLogic';

export class ExternalAttendanceController {

  // POST /api/attendance/fetch-external
  //
  // Starts a device sync for the requested range and answers at once with the
  // run's id. The sync carries on in the background; GET /sync-runs/:runId says
  // when it has really finished and what it changed.
  public static async fetchExternal(req: Request, res: Response): Promise<void> {
    try {
      const { fromDate, toDate } = req.body || {}; // Expects "dd/mm/yyyy" format

      if (!fromDate || !toDate) {
        res.status(400).json({ message: 'Missing fromDate or toDate (dd/mm/yyyy)' });
        return;
      }

      const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
      if (!dateRegex.test(fromDate) || !dateRegex.test(toDate)) {
        res.status(400).json({ message: 'Invalid date format. Expected dd/mm/yyyy' });
        return;
      }

      const range = checkSyncRange(fromDate, toDate);
      if (!range.ok) {
        res.status(400).json({ message: range.message });
        return;
      }

      const user = (req as any).user;
      const { runId, reused } = await startSyncRun({
        fromDate,
        toDate,
        trigger: 'manual',
        userId: user?.id || user?._id,
      });

      console.log(`[ExternalAttendance] Sync ${fromDate}–${toDate} ${reused ? 'already running' : 'started'}: ${runId}`);

      res.status(202).json({
        message: 'Sync started successfully',
        details: 'Check audit logs for completion status.',
        requestedDates: { fromDate, toDate },
        runId,
        reused,
      });

    } catch (error: any) {
      console.error('[ExternalAttendance] Controller Error:', error.message);
      res.status(error?.statusCode === 400 ? 400 : 500).json({
        message: error?.statusCode === 400 ? error.message : 'Internal Server Error',
      });
    }
  }

  // GET /api/attendance/sync-runs/:runId
  public static async getRun(req: Request, res: Response): Promise<void> {
    try {
      const run = await getSyncRun(String(req.params.runId || ''));
      if (!run) {
        res.status(404).json({ message: 'Sync run not found' });
        return;
      }
      res.json(run);
    } catch (error: any) {
      console.error('[ExternalAttendance] Run status error:', error.message);
      res.status(500).json({ message: 'Could not read the sync status' });
    }
  }

  // GET /api/attendance/sync-status
  public static async getStatus(_req: Request, res: Response): Promise<void> {
    try {
      res.json(await getSyncOverview(AttendanceCron.schedule));
    } catch (error: any) {
      console.error('[ExternalAttendance] Sync overview error:', error.message);
      res.status(500).json({ message: 'Could not read the sync status' });
    }
  }
}

export default ExternalAttendanceController;
