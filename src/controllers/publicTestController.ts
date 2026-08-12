import { Request, Response } from 'express';
import mongoose from 'mongoose';
import PublicAttempt from '../models/PublicAttempt';
import PublicTest from '../models/PublicTest';
import PublicTestSeries from '../models/PublicTestSeries';
import User from '../models/User';
import { applyPublishedFloor, isTestStartable } from '../utils/publicAssessment';
import { escapeRegex } from '../utils/publicResourceVisibility';

/**
 * Public assessment discovery.
 *
 * Browsing is open to guests — they can see everything a learner can, and are
 * only stopped at the point of starting an attempt (which needs somewhere to
 * persist answers). So every handler here uses `optionalAuthMiddleware` and
 * treats an absent session as "no personalisation", never as "no access".
 *
 * The published floor is applied on the LOOKUP, so a draft or archived test is
 * a 404 for a learner rather than a document that was fetched and then hidden.
 */

const MAX_LIMIT = 40;

const clampLimit = (v: unknown, fallback = 20) =>
  Math.min(Math.max(Number(v) || fallback, 1), MAX_LIMIT);

/**
 * Fields the discovery list renders. Sections are never sent to a list view.
 *
 * `markingScheme` is included deliberately: negative marking is the single fact
 * a student most needs BEFORE committing to a paper, so the card has to be able
 * to show it without a second request.
 */
const LIST_FIELDS =
  'title description kind classLevel subject exam examType difficulty board durationMins questionCount totalMarks markingScheme status schedule seriesId orderInSeries createdAt';

/**
 * Multi-value filters arrive as `?subject=Physics&subject=Chemistry` or
 * `?subject=Physics,Chemistry`. Both are accepted so the client can use
 * whichever is convenient.
 */
const toList = (value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return raw.map((v) => String(v).trim()).filter(Boolean);
};

const SORTS: Record<string, Record<string, 1 | -1>> = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  shortest: { durationMins: 1 },
  longest: { durationMins: -1 },
  questions: { questionCount: -1 },
  title: { title: 1 },
};

/**
 * GET /api/public/tests
 *
 * Search + filters + sort + pagination, all applied in the DATABASE. Nothing is
 * over-fetched and filtered in memory: with a real catalogue that would mean
 * shipping the whole collection to trim it client-side.
 *
 * Filters: q, kind, classLevel, board, subject, exam, examType, difficulty,
 * durationMin/durationMax, status (learner-scoped), seriesId.
 */
export const listPublicTests = async (req: Request, res: Response) => {
  try {
    const {
      q,
      kind,
      classLevel,
      board,
      subject,
      exam,
      examType,
      difficulty,
      durationMin,
      durationMax,
      seriesId,
      sort,
      limit,
      skip,
    } = req.query;

    const query: any = {};
    applyPublishedFloor(query, req);

    if (q && String(q).trim().length >= 2) {
      const rx = new RegExp(escapeRegex(String(q).trim()), 'i');
      query.$or = [{ title: rx }, { description: rx }, { subject: rx }, { exam: rx }];
    }

    const kinds = toList(kind);
    if (kinds.length) query.kind = { $in: kinds };

    const subjects = toList(subject);
    if (subjects.length) query.subject = { $in: subjects };

    const exams = toList(exam);
    if (exams.length) query.exam = { $in: exams };

    const examTypes = toList(examType);
    if (examTypes.length) query.examType = { $in: examTypes };

    const difficulties = toList(difficulty);
    if (difficulties.length) query.difficulty = { $in: difficulties };

    if (classLevel)
      query.classLevel = String(classLevel)
        .replace(/^class\s*/i, '')
        .trim();

    /**
     * Board is a soft filter by design. A test with an empty `board` array is
     * board-agnostic and must stay visible to every learner — filtering it out
     * would hide most of the catalogue from anyone who picked a board.
     */
    const boards = toList(board);
    if (boards.length) {
      query.$and = [
        ...(query.$and ?? []),
        {
          $or: [{ board: { $in: boards } }, { board: { $size: 0 } }, { board: { $exists: false } }],
        },
      ];
    }

    const min = Number(durationMin);
    const max = Number(durationMax);
    if (!Number.isNaN(min) || !Number.isNaN(max)) {
      query.durationMins = {};
      if (!Number.isNaN(min)) query.durationMins.$gte = min;
      if (!Number.isNaN(max)) query.durationMins.$lte = max;
    }

    if (seriesId && mongoose.Types.ObjectId.isValid(String(seriesId))) {
      query.seriesId = new mongoose.Types.ObjectId(String(seriesId));
    }

    const parsedLimit = clampLimit(limit);
    const parsedSkip = Math.max(Number(skip) || 0, 0);
    const sortSpec = SORTS[String(sort || 'newest')] ?? SORTS.newest;

    const [rows, total] = await Promise.all([
      PublicTest.find(query)
        .select(LIST_FIELDS)
        .sort(sortSpec)
        .skip(parsedSkip)
        .limit(parsedLimit)
        .lean(),
      PublicTest.countDocuments(query),
    ]);

    // A signed-in learner's own attempt state, resolved in ONE query for the
    // whole page rather than one per card.
    const attemptState = await attemptStateFor(
      req,
      rows.map((r: any) => r._id),
    );

    return res.json({
      items: rows.map((t: any) => decorate(t, attemptState)),
      total,
      skip: parsedSkip,
      limit: parsedLimit,
      hasMore: parsedSkip + rows.length < total,
    });
  } catch (error) {
    console.error('Error listing public tests:', error);
    return res.status(500).json({ message: 'Unable to load tests right now.' });
  }
};

/**
 * GET /api/public/tests/filters
 *
 * The values that actually exist in the published catalogue, so the filter UI
 * only ever offers options that lead somewhere. One aggregation, not six.
 */
export const getTestFilterOptions = async (req: Request, res: Response) => {
  try {
    const match: any = {};
    applyPublishedFloor(match, req);

    const [facets] = await PublicTest.aggregate([
      { $match: match },
      {
        $facet: {
          subject: [{ $group: { _id: '$subject', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
          exam: [{ $group: { _id: '$exam', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
          examType: [{ $group: { _id: '$examType', count: { $sum: 1 } } }],
          classLevel: [
            { $group: { _id: '$classLevel', count: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ],
          kind: [{ $group: { _id: '$kind', count: { $sum: 1 } } }],
          difficulty: [{ $group: { _id: '$difficulty', count: { $sum: 1 } } }],
          board: [{ $unwind: '$board' }, { $group: { _id: '$board', count: { $sum: 1 } } }],
          duration: [
            {
              $group: {
                _id: null,
                min: { $min: '$durationMins' },
                max: { $max: '$durationMins' },
              },
            },
          ],
        },
      },
    ]);

    const clean = (rows: any[] = []) =>
      rows
        .filter((r) => r._id !== null && r._id !== undefined && r._id !== '')
        .map((r) => ({ value: r._id, count: r.count }));

    return res.json({
      subject: clean(facets?.subject),
      exam: clean(facets?.exam),
      examType: clean(facets?.examType),
      classLevel: clean(facets?.classLevel),
      kind: clean(facets?.kind),
      difficulty: clean(facets?.difficulty),
      board: clean(facets?.board),
      duration: facets?.duration?.[0]
        ? { min: facets.duration[0].min, max: facets.duration[0].max }
        : { min: 0, max: 0 },
      sorts: Object.keys(SORTS),
    });
  } catch (error) {
    console.error('Error building filter options:', error);
    return res.status(500).json({ message: 'Unable to load filters right now.' });
  }
};

/**
 * GET /api/public/tests/:id
 *
 * Detail for the pre-attempt screen. Deliberately returns NO questions — the
 * paper is only ever served through the attempt endpoints, so the content
 * cannot be harvested without starting.
 */
export const getPublicTest = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Test not found' });
    }

    const criteria: any = { _id: req.params.id };
    applyPublishedFloor(criteria, req);

    const test = await PublicTest.findOne(criteria)
      .select(`${LIST_FIELDS} instructions sections`)
      .lean();
    if (!test) return res.status(404).json({ message: 'Test not found' });

    // Section shape only — titles and counts, never question ids.
    const sections = (test.sections || []).map((s: any) => ({
      title: s.title,
      questionCount: (s.questionIds || []).length,
      durationMins: s.durationMins,
    }));

    const attemptState = await attemptStateFor(req, [test._id]);
    const { startable, reason } = isTestStartable(test as any);

    const series = test.seriesId
      ? await PublicTestSeries.findById(test.seriesId).select('title paperCount').lean()
      : null;

    return res.json({
      ...decorate({ ...test, sections: undefined }, attemptState),
      sections,
      instructions: test.instructions,
      startable,
      notStartableReason: reason,
      series,
    });
  } catch (error) {
    console.error('Error loading public test:', error);
    return res.status(500).json({ message: 'Unable to load this test right now.' });
  }
};

/** GET /api/public/series — series discovery. */
export const listPublicSeries = async (req: Request, res: Response) => {
  try {
    const { q, classLevel, subject, exam, limit, skip, sort } = req.query;

    const query: any = {};
    applyPublishedFloor(query, req);

    if (q && String(q).trim().length >= 2) {
      const rx = new RegExp(escapeRegex(String(q).trim()), 'i');
      query.$or = [{ title: rx }, { description: rx }];
    }
    if (classLevel)
      query.classLevel = String(classLevel)
        .replace(/^class\s*/i, '')
        .trim();
    const subjects = toList(subject);
    if (subjects.length) query.subject = { $in: subjects };
    const exams = toList(exam);
    if (exams.length) query.exam = { $in: exams };

    const parsedLimit = clampLimit(limit);
    const parsedSkip = Math.max(Number(skip) || 0, 0);

    const [rows, total] = await Promise.all([
      PublicTestSeries.find(query)
        .sort(SORTS[String(sort || 'newest')] ?? SORTS.newest)
        .skip(parsedSkip)
        .limit(parsedLimit)
        .lean(),
      PublicTestSeries.countDocuments(query),
    ]);

    return res.json({
      items: rows,
      total,
      skip: parsedSkip,
      limit: parsedLimit,
      hasMore: parsedSkip + rows.length < total,
    });
  } catch (error) {
    console.error('Error listing series:', error);
    return res.status(500).json({ message: 'Unable to load test series right now.' });
  }
};

/** GET /api/public/series/:id — a series and its ordered papers. */
export const getPublicSeries = async (req: Request, res: Response) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Series not found' });
    }

    const criteria: any = { _id: req.params.id };
    applyPublishedFloor(criteria, req);

    const series = await PublicTestSeries.findOne(criteria).lean();
    if (!series) return res.status(404).json({ message: 'Series not found' });

    const paperQuery: any = { seriesId: series._id };
    applyPublishedFloor(paperQuery, req);

    const papers = await PublicTest.find(paperQuery)
      .select(LIST_FIELDS)
      .sort({ orderInSeries: 1, createdAt: 1 })
      .lean();

    const attemptState = await attemptStateFor(
      req,
      papers.map((p: any) => p._id),
    );

    return res.json({
      ...series,
      papers: papers.map((p: any) => decorate(p, attemptState)),
    });
  } catch (error) {
    console.error('Error loading series:', error);
    return res.status(500).json({ message: 'Unable to load this series right now.' });
  }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

type AttemptState = Map<string, { status: string; attemptId: string; percentage?: number }>;

/**
 * The caller's own attempt state for a page of tests.
 *
 * Guests get an empty map — browse-only means no attempt state exists for
 * them, and asking is not an error. One query covers the whole page.
 */
async function attemptStateFor(req: Request, testIds: any[]): Promise<AttemptState> {
  const empty: AttemptState = new Map();
  const userId = (req as any).user?.id;
  if (!userId || testIds.length === 0) return empty;

  const user = await User.findById(userId).select('accountType').lean();
  if (user?.accountType !== 'PUBLIC_LEARNER') return empty;

  const attempts = await PublicAttempt.find({
    learnerId: new mongoose.Types.ObjectId(userId),
    testId: { $in: testIds },
  })
    .select('testId status percentage createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const map: AttemptState = new Map();
  for (const a of attempts) {
    // Sorted newest-first, so the first entry per test is the latest attempt.
    const key = String(a.testId);
    if (!map.has(key)) {
      map.set(key, {
        status: a.status,
        attemptId: String(a._id),
        percentage: a.percentage,
      });
    }
  }
  return map;
}

/** Attach the caller's attempt state and startability to a list row. */
function decorate(test: any, attemptState: AttemptState) {
  const mine = attemptState.get(String(test._id));
  const { startable, reason } = isTestStartable(test);
  return {
    ...test,
    startable,
    notStartableReason: reason,
    myAttempt: mine ?? null,
  };
}
