import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import Attempt from '../models/Attempt';
import Exam from '../models/Exam';
import ExamEvaluation from '../models/ExamEvaluation';
import ReviewAuditLog from '../models/ReviewAuditLog';

/**
 * One-time cleanup for attempts whose exam was deleted BEFORE cascade-delete was
 * added (examService.deleteExam). These orphaned attempts otherwise show up as
 * "Exam Not Found" in a student's results/analytics.
 *
 * Run once:  npx ts-node src/scripts/cleanup_orphaned_attempts.ts
 * Safe to re-run (idempotent). Practice-test attempts are left untouched.
 */
async function cleanupOrphanedAttempts() {
  try {
    console.log('Connecting to database...');
    await connectDB();

    // Only exam-type attempts (practice tests are not exams).
    const examAttempts = await Attempt.find({
      $or: [{ practiceTestId: { $exists: false } }, { practiceTestId: null }],
    })
      .select('_id examId')
      .lean();

    console.log(`Found ${examAttempts.length} exam-type attempts to check.`);

    const referencedExamIds = [
      ...new Set(
        examAttempts
          .map((a: any) => a.examId)
          .filter(Boolean)
          .map((id: any) => id.toString()),
      ),
    ];

    const existingExams = await Exam.find({ _id: { $in: referencedExamIds } })
      .select('_id')
      .lean();
    const existingSet = new Set(existingExams.map((e: any) => e._id.toString()));

    // Orphaned exam ids = referenced by attempts but no longer existing.
    const orphanExamIds = referencedExamIds.filter((id) => !existingSet.has(id));

    // Attempts to delete: referencing a deleted exam, or with no exam at all.
    const orphanAttemptIds = examAttempts
      .filter((a: any) => {
        const examId = a.examId ? a.examId.toString() : null;
        return !examId || !existingSet.has(examId);
      })
      .map((a: any) => a._id);

    console.log(`Orphaned exams referenced: ${orphanExamIds.length}`);
    console.log(`Orphaned attempts to delete: ${orphanAttemptIds.length}`);

    if (orphanAttemptIds.length > 0) {
      const res = await Attempt.deleteMany({ _id: { $in: orphanAttemptIds } });
      console.log(`✅ Deleted ${res.deletedCount} orphaned attempts.`);
    }

    if (orphanExamIds.length > 0) {
      const evalRes = await ExamEvaluation.deleteMany({
        examId: { $in: orphanExamIds },
      });
      const logRes = await ReviewAuditLog.deleteMany({
        examId: { $in: orphanExamIds },
      });
      console.log(
        `✅ Deleted ${evalRes.deletedCount} evaluations and ${logRes.deletedCount} review logs for orphaned exams.`,
      );
    }

    console.log('Cleanup complete.');
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

cleanupOrphanedAttempts();
