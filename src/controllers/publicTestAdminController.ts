import { Request, Response } from 'express';
import mongoose from 'mongoose';
import PublicAttempt from '../models/PublicAttempt';
import PublicTest from '../models/PublicTest';
import PublicTestSeries from '../models/PublicTestSeries';
import {
  duplicatePublicTest,
  normalizePublicClass,
  promoteExamToPublicTest,
} from '../services/publicAssessmentService';
import { GRADABILITY_FIELDS, isAutoGradable } from '../utils/publicAssessment';
import { escapeRegex } from '../utils/publicResourceVisibility';
import { findQuestionsByIds } from '../utils/questionSource';

/**
 * Authoring surface for the public assessment catalogue.
 *
 * Mounted behind `requireRole('admin', 'teacher')`, so nothing here is reachable
 * by a learner or a guest. This is the ONLY place a public test's `status` can
 * become 'published' — discovery and attempt endpoints treat the published floor
 * as read-only.
 *
 * Two things this file deliberately does NOT do:
 *   • It never writes to Exam, Attempt or any institute collection. Promotion
 *     reads an exam and writes a new PublicTest; the source is untouched.
 *   • It never edits a test's questions in place once attempts exist beyond
 *     warning the author, because an in-flight attempt's snapshot is frozen and
 *     silently diverging content would produce results nobody can explain.
 */

const oid = (v: string) => new mongoose.Types.ObjectId(v);
const actor = (req: Request) => String((req as any).user?.id);

/** Fields an author may set. Anything else in the body is ignored. */
const WRITABLE = [
  'title',
  'description',
  'kind',
  'sections',
  'markingScheme',
  'durationMins',
  'board',
  'subject',
  'exam',
  'examType',
  'difficulty',
  'seriesId',
  'orderInSeries',
  'schedule',
  'instructions',
  // Which per-class collection the chosen question ids live in.
  'questionBank',
] as const;

function pickWritable(body: any) {
  const out: any = {};
  for (const key of WRITABLE) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  // classLevel is normalised rather than copied — the public side stores digits
  // only, so it can never accidentally match an institute class label.
  if (body.classLevel !== undefined) out.classLevel = normalizePublicClass(body.classLevel);
  if (out.seriesId === '' || out.seriesId === null) out.seriesId = undefined;
  return out;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

/** GET /api/admin-assessments/public-tests — the authoring list, drafts included. */
export const adminListTests = async (req: Request, res: Response) => {
  try {
    const { q, status, kind, seriesId } = req.query;
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const skip = Math.max(Number(req.query.skip) || 0, 0);

    const query: any = {};
    if (status) query.status = String(status);
    if (kind) query.kind = String(kind);
    if (seriesId && mongoose.Types.ObjectId.isValid(String(seriesId))) {
      query.seriesId = oid(String(seriesId));
    }
    if (q && String(q).trim().length >= 2) {
      const rx = new RegExp(escapeRegex(String(q).trim()), 'i');
      query.$or = [{ title: rx }, { description: rx }];
    }

    const [rows, total] = await Promise.all([
      PublicTest.find(query)
        .select('-sections')
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PublicTest.countDocuments(query),
    ]);

    // Attempt counts tell an author whether a paper is safe to edit.
    const counts = await PublicAttempt.aggregate([
      { $match: { testId: { $in: rows.map((r: any) => r._id) } } },
      { $group: { _id: '$testId', attempts: { $sum: 1 } } },
    ]);
    const byTest = new Map(counts.map((c: any) => [String(c._id), c.attempts]));

    return res.json({
      items: rows.map((r: any) => ({
        ...r,
        attemptCount: byTest.get(String(r._id)) ?? 0,
      })),
      total,
      skip,
      limit,
      hasMore: skip + rows.length < total,
    });
  } catch (error) {
    console.error('Error listing public tests (admin):', error);
    return res.status(500).json({ message: 'Unable to load tests.' });
  }
};

/** GET /api/admin-assessments/public-tests/:id — full test, sections and all. */
export const adminGetTest = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Test not found' });
    }
    const test = await PublicTest.findById(req.params.id).lean();
    if (!test) return res.status(404).json({ message: 'Test not found' });

    const attemptCount = await PublicAttempt.countDocuments({
      testId: test._id,
    });
    return res.json({ ...test, attemptCount });
  } catch (error) {
    console.error('Error loading public test (admin):', error);
    return res.status(500).json({ message: 'Unable to load this test.' });
  }
};

/** POST /api/admin-assessments/public-tests — author a test from scratch. */
export const adminCreateTest = async (req: Request, res: Response) => {
  try {
    const payload = pickWritable(req.body || {});
    if (!payload.title || !String(payload.title).trim()) {
      return res.status(400).json({ message: 'A title is required.' });
    }

    // New tests are always drafts. Publishing is a separate, explicit action so
    // a half-built paper can never go live by accident.
    const created = await PublicTest.create({
      ...payload,
      status: 'draft',
      createdBy: oid(actor(req)),
    });

    await syncSeriesCount(created.seriesId);
    return res.status(201).json(created);
  } catch (error: any) {
    console.error('Error creating public test:', error);
    return res.status(500).json({ message: error?.message || 'Unable to create this test.' });
  }
};

/**
 * PATCH /api/admin-assessments/public-tests/:id
 *
 * Editing questions on a test that already has attempts is allowed but
 * reported: existing attempts keep their frozen snapshot, so their results stay
 * internally consistent while new attempts get the new paper.
 */
export const adminUpdateTest = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Test not found' });
    }

    const test = await PublicTest.findById(req.params.id);
    if (!test) return res.status(404).json({ message: 'Test not found' });

    const payload = pickWritable(req.body || {});
    const previousSeries = test.seriesId;
    Object.assign(test, payload);
    // .save() (not findByIdAndUpdate) so the pre-save hook recomputes
    // questionCount and totalMarks.
    await test.save();

    if (String(previousSeries) !== String(test.seriesId)) {
      await syncSeriesCount(previousSeries);
    }
    await syncSeriesCount(test.seriesId);

    const attemptCount = payload.sections
      ? await PublicAttempt.countDocuments({ testId: test._id })
      : 0;

    return res.json({
      test,
      warning:
        attemptCount > 0
          ? `${attemptCount} attempt(s) already exist. They keep the paper they started with; only new attempts use these questions.`
          : undefined,
    });
  } catch (error: any) {
    console.error('Error updating public test:', error);
    return res.status(500).json({ message: error?.message || 'Unable to update this test.' });
  }
};

/**
 * POST /api/admin-assessments/public-tests/:id/status   { status }
 *
 * The publish gate. A test cannot be published empty or without an
 * auto-gradable question, because either would give every learner a broken
 * result and there is no way to fix it after the fact.
 */
export const adminSetTestStatus = async (req: Request, res: Response) => {
  try {
    const status = String(req.body?.status || '');
    if (!['draft', 'published', 'archived'].includes(status)) {
      return res.status(400).json({ message: 'status must be draft, published or archived.' });
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Test not found' });
    }

    const test = await PublicTest.findById(req.params.id);
    if (!test) return res.status(404).json({ message: 'Test not found' });

    if (status === 'published') {
      const problems = await publishBlockers(test);
      if (problems.length > 0) {
        return res.status(422).json({ message: 'This test is not ready to publish.', problems });
      }
    }

    test.status = status as any;
    await test.save();

    console.log(`[PublicTest] ${test._id} status -> ${status} by=${actor(req)}`);
    return res.json({ _id: test._id, status: test.status });
  } catch (error) {
    console.error('Error changing test status:', error);
    return res.status(500).json({ message: 'Unable to change the status.' });
  }
};

/**
 * DELETE /api/admin-assessments/public-tests/:id
 *
 * Refused once attempts exist — deleting the test would orphan real learner
 * results. Archiving removes it from discovery while keeping those results
 * readable, which is what the author actually wants.
 */
export const adminDeleteTest = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Test not found' });
    }
    const test = await PublicTest.findById(req.params.id);
    if (!test) return res.status(404).json({ message: 'Test not found' });

    const attemptCount = await PublicAttempt.countDocuments({
      testId: test._id,
    });
    if (attemptCount > 0) {
      return res.status(409).json({
        message: `This test has ${attemptCount} attempt(s) and cannot be deleted. Archive it instead — learners keep their results and it disappears from discovery.`,
        code: 'HAS_ATTEMPTS',
        attemptCount,
      });
    }

    const seriesId = test.seriesId;
    await test.deleteOne();
    await syncSeriesCount(seriesId);

    console.log(`[PublicTest] ${req.params.id} deleted by=${actor(req)}`);
    return res.json({ message: 'Test deleted.' });
  } catch (error) {
    console.error('Error deleting public test:', error);
    return res.status(500).json({ message: 'Unable to delete this test.' });
  }
};

/** POST /api/admin-assessments/public-tests/:id/duplicate — an independent draft copy. */
export const adminDuplicateTest = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Test not found' });
    }
    const copy = await duplicatePublicTest(req.params.id, actor(req));
    return res.status(201).json(copy);
  } catch (error: any) {
    console.error('Error duplicating public test:', error);
    const notFound = error?.message === 'Test not found';
    return res.status(notFound ? 404 : 500).json({
      message: error?.message || 'Unable to duplicate this test.',
    });
  }
};

/**
 * POST /api/admin-assessments/public-tests/promote   { examId, overrides }
 *
 * Copies an institute exam into a public DRAFT. The exam itself is never
 * modified — see promoteExamToPublicTest for why this is a copy and not a flag.
 */
export const adminPromoteExam = async (req: Request, res: Response) => {
  try {
    const examId = String(req.body?.examId || '');
    if (!mongoose.Types.ObjectId.isValid(examId)) {
      return res.status(400).json({ message: 'A valid examId is required.' });
    }

    const created = await promoteExamToPublicTest({
      examId,
      actorId: actor(req),
      overrides: req.body?.overrides,
    });

    return res.status(201).json({
      test: created,
      message: 'Promoted as a draft. Review it, then publish when you are ready.',
    });
  } catch (error: any) {
    console.error('Error promoting exam:', error);
    /**
     * 422 means "the exam is not promotable", 500 means "we broke".
     *
     * Matching on exact strings went stale the moment the messages gained
     * counts, silently reclassifying real refusals as server errors. Matching
     * on a marker the thrower sets keeps the two in step.
     */
    const refusal = error?.isPromotionRefusal === true;
    return res.status(refusal ? 422 : 500).json({
      message: error?.message || 'Unable to promote this exam.',
    });
  }
};

// ─── Series ──────────────────────────────────────────────────────────────────

/** GET /api/admin-assessments/public-series */
export const adminListSeries = async (_req: Request, res: Response) => {
  try {
    const items = await PublicTestSeries.find({}).sort({ updatedAt: -1 }).lean();
    return res.json({ items, total: items.length });
  } catch (error) {
    console.error('Error listing series (admin):', error);
    return res.status(500).json({ message: 'Unable to load series.' });
  }
};

/** POST /api/admin-assessments/public-series */
export const adminCreateSeries = async (req: Request, res: Response) => {
  try {
    const { title, description, board, classLevel, subject, exam } = req.body || {};
    if (!title || !String(title).trim()) {
      return res.status(400).json({ message: 'A title is required.' });
    }
    const created = await PublicTestSeries.create({
      title,
      description,
      board: Array.isArray(board) ? board : [],
      classLevel: normalizePublicClass(classLevel),
      subject,
      exam,
      status: 'draft',
      createdBy: oid(actor(req)),
    });
    return res.status(201).json(created);
  } catch (error: any) {
    console.error('Error creating series:', error);
    return res.status(500).json({ message: error?.message || 'Unable to create this series.' });
  }
};

/** PATCH /api/admin-assessments/public-series/:id */
export const adminUpdateSeries = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Series not found' });
    }
    const series = await PublicTestSeries.findById(req.params.id);
    if (!series) return res.status(404).json({ message: 'Series not found' });

    const { title, description, board, classLevel, subject, exam, status } = req.body || {};
    if (title !== undefined) series.title = title;
    if (description !== undefined) series.description = description;
    if (board !== undefined) series.board = Array.isArray(board) ? board : [];
    if (classLevel !== undefined) series.classLevel = normalizePublicClass(classLevel);
    if (subject !== undefined) series.subject = subject;
    if (exam !== undefined) series.exam = exam;

    if (status !== undefined) {
      if (!['draft', 'published', 'archived'].includes(String(status))) {
        return res.status(400).json({ message: 'Invalid status.' });
      }
      // A series with no published paper is an empty shelf to a learner.
      if (status === 'published') {
        const published = await PublicTest.countDocuments({
          seriesId: series._id,
          status: 'published',
        });
        if (published === 0) {
          return res.status(422).json({
            message: 'Publish at least one paper in this series first.',
          });
        }
      }
      series.status = status as any;
    }

    await series.save();
    return res.json(series);
  } catch (error: any) {
    console.error('Error updating series:', error);
    return res.status(500).json({ message: error?.message || 'Unable to update this series.' });
  }
};

/** DELETE /api/admin-assessments/public-series/:id — papers survive, detached. */
export const adminDeleteSeries = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Series not found' });
    }
    const series = await PublicTestSeries.findById(req.params.id);
    if (!series) return res.status(404).json({ message: 'Series not found' });

    // Detach rather than cascade: the papers are real content with real
    // attempts, and deleting a shelf must not destroy the books on it.
    const detached = await PublicTest.updateMany(
      { seriesId: series._id },
      { $unset: { seriesId: '', orderInSeries: '' }, $set: { kind: 'TEST' } },
    );
    await series.deleteOne();

    console.log(
      `[PublicSeries] ${req.params.id} deleted by=${actor(req)}, ${detached.modifiedCount} paper(s) detached`,
    );
    return res.json({
      message: 'Series deleted. Its papers were kept as standalone tests.',
      detached: detached.modifiedCount,
    });
  } catch (error) {
    console.error('Error deleting series:', error);
    return res.status(500).json({ message: 'Unable to delete this series.' });
  }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Everything standing between this test and a learner seeing it. Returned as a
 * list so an author fixes all of it in one pass instead of one error at a time.
 */
async function publishBlockers(test: any): Promise<string[]> {
  const problems: string[] = [];

  const ids = (test.sections || []).flatMap((s: any) => s.questionIds || []);
  if (ids.length === 0) problems.push('The test has no questions.');
  if (!test.durationMins || test.durationMins <= 0) {
    problems.push('The test needs a duration in minutes.');
  }
  if (test.schedule?.startAt && test.schedule?.endAt) {
    if (new Date(test.schedule.startAt) >= new Date(test.schedule.endAt)) {
      problems.push('The availability window ends before it starts.');
    }
  }
  if (test.kind === 'SERIES_PAPER' && !test.seriesId) {
    problems.push('A series paper must belong to a series.');
  }

  if (ids.length > 0) {
    // Read from the test's OWN bank — questions live in per-class collections,
    // so the shared `Question` collection finds nothing for a class_11 paper
    // and would report every question as deleted.
    //
    // GRADABILITY_FIELDS, not just `type`: gradability is a property of the
    // answer key, and a projection of `type` alone makes every question look
    // ungradable. Same predicate the promotion gate and the grader use.
    const found = await findQuestionsByIds(ids, test.questionBank, GRADABILITY_FIELDS);
    const missing = ids.length - found.length;
    if (missing > 0) {
      problems.push(`${missing} question(s) no longer exist in the question bank.`);
    }
    const gradable = found.filter(isAutoGradable);
    if (found.length > 0 && gradable.length === 0) {
      problems.push(
        'No question has an answer key, so the test cannot be graded automatically.',
      );
    }
    // A PARTIALLY gradable paper is deliberately not blocked: the grader
    // excludes keyless questions from the score and the maximum alike, so the
    // paper stays fair. Pushing a note here would have blocked publishing,
    // because any entry in `problems` is a blocker.
    
  }

  return problems;
}

/** Keep the denormalised `paperCount` truthful after any membership change. */
async function syncSeriesCount(seriesId?: mongoose.Types.ObjectId | null) {
  if (!seriesId) return;
  const count = await PublicTest.countDocuments({ seriesId });
  await PublicTestSeries.updateOne({ _id: seriesId }, { $set: { paperCount: count } });
}
