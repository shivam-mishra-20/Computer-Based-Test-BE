/**
 * The subject(s) of an online exam, from the questions it is made of.
 *
 * ── Why from the questions ──────────────────────────────────────────────────
 * An exam has no subject field. Clients guessed from section titles, but real
 * papers are built with sections called "Section 1", so a result row read
 * "Section 1 · 16/20" or had no subject at all. The subject a question belongs
 * to is recorded on the question (`tags.subject`, or the class banks' top-level
 * `subject` — the same pair aiService and examService read), and an exam's
 * subjects are simply the distinct subjects of the questions in it, in paper
 * order. A multi-subject paper therefore reads "Physics, Chemistry".
 *
 * ── When the questions say nothing ──────────────────────────────────────────
 * An explicit `subject` / `meta.subject` on the exam, then section titles that
 * are not generic ("Physics", not "Section 1" / "Part A"). Otherwise null —
 * the honest answer, and what every client already shows as "no subject".
 *
 * Questions are read exactly as the grader reads them (findExamQuestions: the
 * class bank, then the general bank) and inside the caller's tenant scope, so
 * a deleted question or another organization's question contributes nothing.
 */

import { findExamQuestions } from '../utils/questionSource';

export interface SubjectExam {
  _id: unknown;
  classLevel?: string | null;
  subject?: string | null;
  meta?: { subject?: unknown } | null;
  sections?: Array<{ title?: string | null; questionIds?: unknown[] }> | null;
}

const GENERIC_SECTION = /^(section|part|paper|set)\s*[\w-]{0,3}$/i;

/** Distinct, trimmed, in first-seen order, joined. Null when there are none. */
export function subjectLabel(values: Iterable<unknown>): string | null {
  const seen = new Map<string, string>();
  for (const raw of values) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    const key = value.toLowerCase();
    if (!seen.has(key)) seen.set(key, value);
  }
  return seen.size ? [...seen.values()].join(', ') : null;
}

/** What the exam document itself says, when its questions say nothing. */
export function declaredSubject(exam: SubjectExam): string | null {
  const explicit = subjectLabel([
    exam.subject,
    (exam.meta as { subject?: unknown } | null | undefined)?.subject,
  ]);
  if (explicit) return explicit;
  return subjectLabel(
    (exam.sections ?? [])
      .map((s) => s?.title)
      .filter((t) => typeof t === 'string' && !GENERIC_SECTION.test(t.trim())),
  );
}

/** A question's subject, as the rest of the codebase reads it. */
export function questionSubject(
  q:
    | { tags?: { subject?: unknown } | null; subject?: unknown }
    | null
    | undefined,
): string | null {
  const tagged =
    typeof q?.tags?.subject === 'string' ? q.tags.subject.trim() : '';
  if (tagged) return tagged;
  const top = typeof q?.subject === 'string' ? q.subject.trim() : '';
  return top || null;
}

/** Subject labels for many exams at once — one question read per class bank. */
export async function subjectsForExams(
  exams: SubjectExam[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const byClass = new Map<string, { exams: SubjectExam[]; ids: Set<string> }>();
  for (const exam of exams) {
    if (!exam?._id) continue;
    const key = String(exam.classLevel ?? '').trim();
    const group = byClass.get(key) ?? { exams: [], ids: new Set<string>() };
    group.exams.push(exam);
    for (const section of exam.sections ?? [])
      for (const id of section?.questionIds ?? []) group.ids.add(String(id));
    byClass.set(key, group);
  }
  for (const [classLevel, group] of byClass) {
    let subjectOf = new Map<string, string | null>();
    try {
      const ids = [...group.ids];
      const questions = ids.length
        ? await findExamQuestions(classLevel || null, ids, {
            select: 'tags.subject subject',
            lean: true,
          })
        : [];
      subjectOf = new Map(
        questions.map((q: { _id: unknown }) => [
          String(q._id),
          questionSubject(q as never),
        ]),
      );
    } catch (error) {
      // A missing bank or a read error leaves the exam's own declaration to speak.
      console.warn(
        '[examSubjects] question lookup failed:',
        (error as Error)?.message ?? error,
      );
    }
    for (const exam of group.exams) {
      const ordered = (exam.sections ?? []).flatMap((s) =>
        (s?.questionIds ?? []).map((id) => subjectOf.get(String(id))),
      );
      out.set(String(exam._id), subjectLabel(ordered) ?? declaredSubject(exam));
    }
  }
  return out;
}
