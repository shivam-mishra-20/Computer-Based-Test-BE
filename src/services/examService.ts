import { Types } from 'mongoose';
import Exam, { IExam } from '../models/Exam';
import Question, { IQuestion } from '../models/Question';

export const createQuestion = async (payload: Partial<IQuestion> & { createdBy: Types.ObjectId }): Promise<IQuestion> => {
  const q = await Question.create(payload as IQuestion);
  return q;
};

export const listQuestions = async (filter: any = {}, limit = 50, skip = 0) => {
  const [items, total] = await Promise.all([
    Question.find(filter).limit(limit).skip(skip).sort({ createdAt: -1 }),
    Question.countDocuments(filter),
  ]);
  return { items, total };
};

export const updateQuestion = async (id: string, payload: Partial<IQuestion>) => {
  const q = await Question.findByIdAndUpdate(id, payload, { new: true });
  return q;
};

export const deleteQuestion = async (id: string) => {
  await Question.findByIdAndDelete(id);
};

export const createExam = async (payload: Partial<IExam>): Promise<IExam> => {
  const exam = await Exam.create(payload as IExam);
  return exam;
};

export const updateExam = async (id: string, payload: Partial<IExam>) => {
  return Exam.findByIdAndUpdate(id, payload, { new: true });
};

export const getExam = async (id: string) => Exam.findById(id);
export const listExams = async (filter: any = {}, limit = 50, skip = 0) => {
  const [items, total] = await Promise.all([
    Exam.find(filter).limit(limit).skip(skip).sort({ createdAt: -1 }),
    Exam.countDocuments(filter),
  ]);
  return { items, total };
};

export const deleteExam = async (id: string) => Exam.findByIdAndDelete(id);

export const assignExam = async (id: string, users?: string[], groups?: string[]) => {
  const exam = await Exam.findById(id);
  if (!exam) return null;
  exam.assignedTo = {
    users: users?.map((u) => new Types.ObjectId(u)),
    groups,
  };
  await exam.save();
  return exam;
};
