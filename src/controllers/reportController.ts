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
  // Sort by per-test rank so the export mirrors the published standings, and
  // include the effective (post-review) score, percentage and publish state.
  const attempts = await Attempt.find({ examId })
    .populate('userId', 'name email classLevel batch profileImage')
    .sort({ rankInTest: 1, totalScore: -1 });

  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const rows = [
    ['rank', 'name', 'email', 'class', 'batch', 'status', 'published', 'totalScore', 'maxScore', 'percentage', 'submittedAt'],
  ];
  for (const a of attempts) {
    const u = a.userId as any;
    const pct =
      typeof a.percentage === 'number'
        ? a.percentage
        : a.maxScore && a.maxScore > 0
        ? Math.round(((a.totalScore || 0) / a.maxScore) * 10000) / 100
        : '';
    rows.push([
      String(a.rankInTest ?? ''),
      u?.name || String(a.userId),
      u?.email || '',
      u?.classLevel || '',
      u?.batch || '',
      a.status,
      a.resultPublished ? 'yes' : 'no',
      String(a.totalScore ?? ''),
      String(a.maxScore ?? ''),
      String(pct),
      a.submittedAt ? a.submittedAt.toISOString() : '',
    ]);
  }
  const csv = rows.map((r) => r.map(esc).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=exam-${exam._id}-results.csv`);
  res.send(csv);
};
