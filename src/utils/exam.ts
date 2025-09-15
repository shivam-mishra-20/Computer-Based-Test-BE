import { Types } from 'mongoose';
import { IExam } from '../models/Exam';
import { IQuestion } from '../models/Question';

export function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function sanitizeQuestion(q: IQuestion) {
  // Remove isCorrect flags and correct answers
  const options = q.options?.map((o) => ({ _id: o._id, text: o.text })) ?? undefined;
  return {
    _id: (q as any)._id as Types.ObjectId,
    text: q.text,
    type: q.type,
    options,
    tags: q.tags,
    explanation: undefined,
  };
}

export function computeMaxScoreForExam(exam: IExam, questionMap: Map<string, IQuestion>): number {
  // Each question default 1 point for now
  let total = 0;
  for (const sec of exam.sections) {
    for (const qid of sec.questionIds) {
      const q = questionMap.get(qid.toString());
      if (!q) continue;
      total += 1;
    }
  }
  return total;
}
