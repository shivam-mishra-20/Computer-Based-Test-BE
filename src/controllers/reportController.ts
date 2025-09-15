import { Request, Response } from 'express';
import Attempt from '../models/Attempt';
import Exam from '../models/Exam';

export const attendanceReport = async (req: Request, res: Response) => {
  const { examId } = req.params;
  const attempts = await Attempt.find({ examId });
  const attended = attempts.map((a) => ({ userId: a.userId, startedAt: a.startedAt, submittedAt: a.submittedAt, status: a.status }));
  res.json({ count: attended.length, attended });
};

export const suspiciousLogs = async (req: Request, res: Response) => {
  const { examId } = req.params;
  const attempts = await Attempt.find({ examId, activityLogs: { $exists: true, $ne: [] } }).select('userId activityLogs');
  res.json(attempts);
};

export const resultsCsv = async (req: Request, res: Response) => {
  const { examId } = req.params;
  const exam = await Exam.findById(examId);
  if (!exam) return res.status(404).json({ message: 'Exam not found' });
  const attempts = await Attempt.find({ examId });
  const rows = [['userId', 'status', 'totalScore', 'maxScore', 'submittedAt']];
  for (const a of attempts) {
    rows.push([String(a.userId), a.status, String(a.totalScore ?? ''), String(a.maxScore ?? ''), a.submittedAt ? a.submittedAt.toISOString() : '']);
  }
  const csv = rows.map((r) => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=exam-${exam._id}-results.csv`);
  res.send(csv);
};
