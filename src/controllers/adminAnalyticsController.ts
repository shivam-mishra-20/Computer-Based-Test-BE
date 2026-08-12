import { Request, Response } from 'express';
import { Types } from 'mongoose';
import Attempt from '../models/Attempt';
import Exam from '../models/Exam';
import Question from '../models/Question';
import TestResult, { IStudentResult } from '../models/TestResult';
import User from '../models/User';

const COMPLETED_STATUSES = ['submitted', 'auto-submitted', 'graded'];

type Mode = 'online' | 'offline' | 'combined';

interface ResultRow {
  id: string;
  type: 'online' | 'offline';
  title: string;
  subject: string;
  topic?: string;
  date: string | null;
  marks: number | null;
  outOf: number | null;
  percentage: number | null;
  rank: number | null;
  classSize: number | null;
  accuracy: number | null;
  correct?: number;
  incorrect?: number;
  unattempted?: number;
  totalQuestions?: number;
  timeSpentSec?: number | null;
  grade?: string;
  status: 'completed' | 'incomplete' | 'absent' | 'missed';
  resultPublished?: boolean;
  examId?: string;
  testId?: string;
  attemptId?: string;
}

/** Build the list of class string variants a student might be stored under. */
function classVariants(classLevel?: string): string[] {
  const raw = String(classLevel || '').trim();
  if (!raw) return [];
  const normalized = raw.replace(/^Class\s*/i, '').trim();
  return [...new Set([raw, normalized, `Class ${normalized}`])].filter(Boolean);
}

function pct(num: number, den: number): number {
  return den > 0 ? Math.round((num / den) * 100) : 0;
}

/** Standard competition ranking (1,2,2,4) for a value within a sorted-desc list. */
function rankOf(value: number, sortedDesc: number[]): number {
  const idx = sortedDesc.findIndex((v) => v <= value);
  return idx === -1 ? sortedDesc.length : idx + 1;
}

function withinDateRange(dateStr: string | null, from?: string, to?: string): boolean {
  if (!dateStr) return !from && !to; // undated rows only pass when no range set
  const d = dateStr.slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

/**
 * GET /api/admin-analytics/students/:studentId/report
 *
 * Combined per-student performance report across online (Attempt) and offline
 * (TestResult) tests, with server-side filtering. Reused by the admin
 * Student Analytics drill-down (Admin → Student → Test Type → Filters → Report).
 *
 * Query params (all optional):
 *   mode     online | offline | combined            (default combined)
 *   from,to  yyyy-mm-dd inclusive date range
 *   subject  exact subject filter
 *   batch    batch filter (offline + assigned-exam scope)
 *   status   all | completed | incomplete | absent | missed   (default all)
 *   examId   restrict to a single online exam
 *   testId   restrict to a single offline TestResult
 *   topic    online topic filter (tags.topic)
 *
 * Access: admin sees every exam; teacher is scoped to exams they created
 * (offline tests are class-wide and not scoped, matching existing behaviour).
 */
export const getStudentReport = async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user as { id: string; role?: string };
    const { studentId } = req.params;

    if (!Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ message: 'Invalid student id' });
    }

    const student = await User.findById(studentId)
      .select('name email classLevel batch role profileImage')
      .lean();
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    const mode = ((req.query.mode as string) || 'combined') as Mode;
    const from = (req.query.from as string) || undefined;
    const to = (req.query.to as string) || undefined;
    const subjectFilter = ((req.query.subject as string) || '').trim();
    const batchFilter = ((req.query.batch as string) || '').trim();
    const statusFilter = ((req.query.status as string) || 'all').trim();
    const examIdFilter = ((req.query.examId as string) || '').trim();
    const testIdFilter = ((req.query.testId as string) || '').trim();
    const topicFilter = ((req.query.topic as string) || '').trim();

    const isTeacher = authUser.role === 'teacher';

    const results: ResultRow[] = [];
    const subjectAgg: Record<string, { count: number; pctSum: number }> = {};
    const topicAgg: Record<string, { subject: string; correct: number; total: number }> = {};

    let onlineTimeSpent = 0;
    let missedCount = 0;

    // ── Online attempts ──────────────────────────────────────────────────────
    if (mode === 'online' || mode === 'combined') {
      // Scope: teachers only see attempts on exams they authored.
      let scopedExamIds: Types.ObjectId[] | null = null;
      if (isTeacher) {
        scopedExamIds = (await Exam.find({ createdBy: new Types.ObjectId(authUser.id) }).distinct('_id')) as Types.ObjectId[];
      }

      const attemptQuery: any = {
        userId: new Types.ObjectId(studentId),
        status: { $in: ['in-progress', ...COMPLETED_STATUSES] },
        examId: { $exists: true, $ne: null },
      };
      if (examIdFilter && Types.ObjectId.isValid(examIdFilter)) {
        attemptQuery.examId = new Types.ObjectId(examIdFilter);
      } else if (scopedExamIds) {
        attemptQuery.examId = { $in: scopedExamIds };
      }

      const rawAttempts = await Attempt.find(attemptQuery)
        .populate('examId', 'title classLevel batch schedule')
        .sort({ submittedAt: -1, createdAt: -1 })
        .lean();

      // Exclude attempts whose exam was deleted (orphaned) — deleted exams must
      // not appear in or skew a student's performance/analytics.
      const attempts = rawAttempts.filter((a: any) => a.examId);

      // Resolve subjects/topics for every answered question in one round-trip.
      const questionIds = new Set<string>();
      attempts.forEach((a: any) => (a.answers || []).forEach((ans: any) => questionIds.add(String(ans.questionId))));
      const questions = await Question.find({ _id: { $in: Array.from(questionIds) } })
        .select('tags.subject tags.topic')
        .lean();
      const qSubject = new Map<string, string>();
      const qTopic = new Map<string, string>();
      questions.forEach((q: any) => {
        qSubject.set(String(q._id), q.tags?.subject || 'General');
        qTopic.set(String(q._id), q.tags?.topic || 'General');
      });

      for (const a of attempts as any[]) {
        const exam = a.examId || {};
        const completed = COMPLETED_STATUSES.includes(a.status);
        const dateRaw = a.submittedAt || a.updatedAt || a.createdAt || null;
        const date = dateRaw ? new Date(dateRaw).toISOString() : null;

        // Subject mix → dominant subject for the row.
        const answers = a.answers || [];
        const subjCount: Record<string, number> = {};
        let correct = 0;
        let incorrect = 0;
        let unattempted = 0;
        let timeSpent = 0;

        for (const ans of answers) {
          const qid = String(ans.questionId);
          const subj = qSubject.get(qid) || 'General';
          subjCount[subj] = (subjCount[subj] || 0) + 1;
          timeSpent += ans.timeSpentSec || 0;

          const attempted = !!(ans.chosenOptionId || ans.textAnswer);
          if (ans.isCorrect) correct++;
          else if (attempted) incorrect++;
          else unattempted++;

          // Topic-level accuracy (online only). Only count completed attempts.
          if (completed) {
            const topic = qTopic.get(qid) || 'General';
            if (!topicAgg[topic]) topicAgg[topic] = { subject: subj, correct: 0, total: 0 };
            topicAgg[topic].total++;
            if (ans.isCorrect) topicAgg[topic].correct++;
          }
        }

        if (timeSpent === 0 && a.submittedAt && a.startedAt) {
          timeSpent = Math.max(0, Math.round((new Date(a.submittedAt).getTime() - new Date(a.startedAt).getTime()) / 1000));
        }

        const subjects = Object.keys(subjCount);
        const dominantSubject =
          subjects.length === 0 ? 'General' : subjects.length === 1 ? subjects[0] : 'Mixed';

        const attemptedCount = correct + incorrect;
        const percentage = completed
          ? (typeof a.percentage === 'number' ? a.percentage : pct(a.totalScore || 0, a.maxScore || 0))
          : null;

        const row: ResultRow = {
          id: String(a._id),
          type: 'online',
          title: exam.title || 'Exam',
          subject: dominantSubject,
          date,
          marks: completed ? (a.totalScore ?? 0) : null,
          outOf: completed ? (a.maxScore ?? 0) : null,
          percentage,
          rank: typeof a.rankInTest === 'number' ? a.rankInTest : null,
          classSize: null,
          accuracy: completed ? pct(correct, attemptedCount) : null,
          correct,
          incorrect,
          unattempted,
          totalQuestions: answers.length,
          timeSpentSec: timeSpent,
          status: completed ? 'completed' : 'incomplete',
          resultPublished: !!a.resultPublished,
          examId: exam._id ? String(exam._id) : undefined,
          attemptId: String(a._id),
        };

        // Apply filters.
        if (subjectFilter && row.subject !== subjectFilter) continue;
        if (topicFilter && !Object.keys(subjCount).length) continue; // topic filter ⇒ online only
        if (batchFilter && exam.batch && exam.batch !== batchFilter) continue;
        if (!withinDateRange(date, from, to)) continue;

        if (completed) {
          subjectAgg[row.subject] = subjectAgg[row.subject] || { count: 0, pctSum: 0 };
          subjectAgg[row.subject].count++;
          subjectAgg[row.subject].pctSum += percentage || 0;
          onlineTimeSpent += timeSpent;
        }

        results.push(row);
      }

      // ── Missed online exams (assigned but never attempted) ────────────────
      if (!examIdFilter && !subjectFilter && !topicFilter) {
        const variants = classVariants(student.classLevel);
        const assignmentOr: any[] = [
          { 'assignedTo.users': new Types.ObjectId(studentId) },
        ];
        const effBatch = batchFilter || student.batch;
        if (effBatch) {
          assignmentOr.push({ 'assignedTo.groups': effBatch });
          assignmentOr.push({ batch: effBatch });
        }
        if (variants.length) assignmentOr.push({ classLevel: { $in: variants } });

        const assignedQuery: any = { isPublished: true, $or: assignmentOr };
        if (scopedExamIds) assignedQuery._id = { $in: scopedExamIds };

        const assignedExams = await Exam.find(assignedQuery)
          .select('title batch classLevel schedule')
          .lean();

        const attemptedExamIds = new Set(
          (await Attempt.find({ userId: new Types.ObjectId(studentId), examId: { $exists: true, $ne: null } }).distinct('examId')).map(String)
        );

        for (const ex of assignedExams as any[]) {
          if (attemptedExamIds.has(String(ex._id))) continue;
          // Only count as "missed" once the exam window has opened/closed.
          const openedAt = ex.schedule?.endAt || ex.schedule?.startAt || null;
          const dateIso = openedAt ? new Date(openedAt).toISOString() : null;
          if (openedAt && new Date(openedAt).getTime() > Date.now()) continue; // upcoming, not missed
          if (!withinDateRange(dateIso, from, to)) continue;

          missedCount++;
          results.push({
            id: String(ex._id),
            type: 'online',
            title: ex.title || 'Exam',
            subject: '—',
            date: dateIso,
            marks: null,
            outOf: null,
            percentage: null,
            rank: null,
            classSize: null,
            accuracy: null,
            status: 'missed',
            examId: String(ex._id),
          });
        }
      }
    }

    // ── Offline tests (TestResult) ───────────────────────────────────────────
    if (mode === 'offline' || mode === 'combined') {
      const variants = classVariants(student.classLevel);
      const offlineQuery: any = {};
      if (variants.length) offlineQuery.class = { $in: variants };
      if (subjectFilter) offlineQuery.subject = subjectFilter;
      if (testIdFilter && Types.ObjectId.isValid(testIdFilter)) offlineQuery._id = new Types.ObjectId(testIdFilter);
      if (batchFilter) {
        offlineQuery.$or = [{ batch: batchFilter }, { batch: null }, { batch: '' }];
      } else if (student.batch) {
        offlineQuery.$or = [{ batch: student.batch }, { batch: null }, { batch: '' }];
      }

      const tests = await TestResult.find(offlineQuery).sort({ testDate: -1 }).lean();

      for (const test of tests as any[]) {
        const sr: IStudentResult | undefined = (test.studentResults || []).find(
          (r: IStudentResult) => r.studentId === studentId || r.studentName === student.name
        );
        if (!sr) continue;
        if (!withinDateRange(test.testDate, from, to)) continue;

        const present = (test.studentResults || []).filter((r: IStudentResult) => !r.isAbsent);
        const sortedDesc = present.map((r: IStudentResult) => r.marksObtained || 0).sort((a: number, b: number) => b - a);
        const percentage = sr.isAbsent
          ? null
          : (typeof sr.percentage === 'number' ? sr.percentage : pct(sr.marksObtained || 0, test.maxMarks || 0));

        const row: ResultRow = {
          id: String(test._id),
          type: 'offline',
          title: test.testName || 'Offline Test',
          subject: test.subject || 'General',
          date: test.testDate || null,
          marks: sr.isAbsent ? null : (sr.marksObtained ?? 0),
          outOf: test.maxMarks ?? 0,
          percentage,
          rank: sr.isAbsent ? null : rankOf(sr.marksObtained || 0, sortedDesc),
          classSize: present.length,
          accuracy: percentage,
          grade: sr.grade || '',
          status: sr.isAbsent ? 'absent' : 'completed',
          testId: String(test._id),
        };

        if (!sr.isAbsent) {
          subjectAgg[row.subject] = subjectAgg[row.subject] || { count: 0, pctSum: 0 };
          subjectAgg[row.subject].count++;
          subjectAgg[row.subject].pctSum += percentage || 0;
        }

        results.push(row);
      }
    }

    // ── Apply the status filter to the unified list ───────────────────────────
    let filteredResults = results;
    if (statusFilter && statusFilter !== 'all') {
      filteredResults = results.filter((r) => r.status === statusFilter);
    }

    // ── Aggregations ──────────────────────────────────────────────────────────
    const completedRows = filteredResults.filter((r) => r.percentage !== null);
    const onlineCompleted = completedRows.filter((r) => r.type === 'online');
    const offlineCompleted = completedRows.filter((r) => r.type === 'offline');

    const avg = (rows: ResultRow[]) =>
      rows.length ? Math.round(rows.reduce((s, r) => s + (r.percentage || 0), 0) / rows.length) : 0;
    const best = (rows: ResultRow[]) =>
      rows.length ? Math.max(...rows.map((r) => r.percentage || 0)) : 0;
    const avgAccuracy = (rows: ResultRow[]) => {
      const withAcc = rows.filter((r) => typeof r.accuracy === 'number');
      return withAcc.length ? Math.round(withAcc.reduce((s, r) => s + (r.accuracy || 0), 0) / withAcc.length) : 0;
    };

    const trend = [...completedRows]
      .filter((r) => r.date)
      .sort((a, b) => new Date(a.date as string).getTime() - new Date(b.date as string).getTime())
      .map((r) => ({ date: r.date, percentage: r.percentage, type: r.type, label: r.title }));

    const subjectPerformance = Object.entries(subjectAgg)
      .map(([subject, v]) => ({ subject, count: v.count, avgPercentage: Math.round(v.pctSum / v.count) }))
      .sort((a, b) => b.count - a.count);

    const topicPerformance = Object.entries(topicAgg)
      .map(([topic, v]) => ({ topic, subject: v.subject, total: v.total, correct: v.correct, accuracy: pct(v.correct, v.total) }))
      .sort((a, b) => b.total - a.total);

    const statusBreakdown = {
      completed: filteredResults.filter((r) => r.status === 'completed').length,
      incomplete: filteredResults.filter((r) => r.status === 'incomplete').length,
      absent: filteredResults.filter((r) => r.status === 'absent').length,
      missed: filteredResults.filter((r) => r.status === 'missed').length,
    };

    // Detailed report: newest first.
    filteredResults.sort((a, b) => {
      const ta = a.date ? new Date(a.date).getTime() : 0;
      const tb = b.date ? new Date(b.date).getTime() : 0;
      return tb - ta;
    });

    return res.json({
      student: {
        id: String(student._id),
        name: student.name,
        email: student.email,
        classLevel: student.classLevel || '',
        batch: student.batch || '',
      },
      filters: { mode, from, to, subject: subjectFilter, batch: batchFilter, status: statusFilter, examId: examIdFilter, testId: testIdFilter, topic: topicFilter },
      summary: {
        totalTests: filteredResults.length,
        online: {
          count: onlineCompleted.length,
          avgPercentage: avg(onlineCompleted),
          bestPercentage: best(onlineCompleted),
          avgAccuracy: avgAccuracy(onlineCompleted),
          totalTimeSpentSec: onlineTimeSpent,
          missedCount,
        },
        offline: {
          count: offlineCompleted.length,
          avgPercentage: avg(offlineCompleted),
          bestPercentage: best(offlineCompleted),
          absentCount: statusBreakdown.absent,
        },
        combined: {
          avgPercentage: avg(completedRows),
          bestPercentage: best(completedRows),
        },
      },
      trend,
      subjectPerformance,
      topicPerformance,
      statusBreakdown,
      results: filteredResults,
    });
  } catch (error: any) {
    console.error('[AdminAnalytics] getStudentReport error:', error);
    return res.status(500).json({ message: 'Failed to build student report', error: error.message });
  }
};
