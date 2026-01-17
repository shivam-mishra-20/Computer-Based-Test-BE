import Attendance from '../models/Attendance';
import AuditLog from '../models/AuditLog';
import SocketService from '../services/SocketService';

export class AttendanceWorker {
  public static async process(data: any): Promise<void> {
    const { 
      studentId, date, status, markedBy, source, idempotencyKey, metadata,
      clockIn, clockOut, lateIn, earlyOut 
    } = data;

    try {
      console.log('[AttendanceWorker] Processing:', { studentId, date, status, idempotencyKey });
      
      // Build update document
      const updateDoc = {
        studentId,
        date: new Date(date),
        status,
        markedBy,
        source: source || 'webhook',
        idempotencyKey,
        metadata,
        ...(clockIn && { clockIn }),
        ...(clockOut && { clockOut }),
        ...(lateIn && { lateIn }),
        ...(earlyOut && { earlyOut })
      };

      // Use upsert to prevent duplicates and allow updates on re-sync
      // Query by idempotencyKey if available, else by studentId + date
      const query = idempotencyKey 
        ? { idempotencyKey } 
        : { studentId, date: new Date(date) };
      
      const attendance = await Attendance.findOneAndUpdate(
        query,
        { $set: updateDoc },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      console.log('[AttendanceWorker] Saved/Updated attendance:', attendance._id);

      // 3. Emit Real-Time Event
      SocketService.emitToUser(studentId, 'attendance_update', attendance);
      if (metadata?.classId) {
        SocketService.emitToClass(metadata.classId, 'class_attendance_update', attendance);
      }

      // 4. Audit Log (Success)
      await AuditLog.create({
        action: 'PROCESS_ATTENDANCE',
        status: 'success',
        entity: 'Attendance',
        entityId: (attendance as any)._id.toString(),
        metadata: { idempotencyKey, source }
      });

    } catch (error: any) {
      console.error('Error in AttendanceWorker:', error);
      
      // Audit Log (Failure)
      await AuditLog.create({
        action: 'PROCESS_ATTENDANCE',
        status: 'failure',
        entity: 'Attendance',
        errorMessage: error.message,
        metadata: { idempotencyKey, data }
      });

      throw error; // Re-throw to let QueueService handle retry if needed
    }
  }
}

export default AttendanceWorker;
