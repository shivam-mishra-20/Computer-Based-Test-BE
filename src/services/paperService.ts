import { Types } from 'mongoose';
import Paper, { IPaper } from '../models/Paper';

export async function createPaper(owner: Types.ObjectId, payload: Partial<IPaper>) {
  return Paper.create({ ...payload, owner } as IPaper);
}

export async function listPapers(owner?: Types.ObjectId | null, limit = 50, skip = 0) {
  const filter = owner ? { owner } : {};
  const [items, total] = await Promise.all([
    Paper.find(filter as any).sort({ createdAt: -1 }).limit(limit).skip(skip),
    Paper.countDocuments(filter as any),
  ]);
  return { items, total };
}

export async function getPaper(owner: Types.ObjectId | null, id: string) {
  if (owner) return Paper.findOne({ _id: id, owner });
  return Paper.findById(id);
}

export async function updatePaper(owner: Types.ObjectId | null, id: string, payload: Partial<IPaper>) {
  if (owner) return Paper.findOneAndUpdate({ _id: id, owner }, payload, { new: true });
  return Paper.findByIdAndUpdate(id, payload, { new: true });
}

export async function deletePaper(owner: Types.ObjectId | null, id: string) {
  if (owner) {
    await Paper.findOneAndDelete({ _id: id, owner });
  } else {
    await Paper.findByIdAndDelete(id);
  }
}

export async function setPaperSolutions(owner: Types.ObjectId | null, id: string, sections: IPaper['solutions'] extends infer S ? (S extends { sections: infer Sec } ? Sec : never) : never) {
  const update = { solutions: { generatedAt: new Date(), sections } } as any;
  if (owner) {
    return Paper.findOneAndUpdate(
      { _id: id, owner },
      update,
      { new: true }
    );
  }
  return Paper.findByIdAndUpdate(
    id,
    update,
    { new: true }
  );
}
