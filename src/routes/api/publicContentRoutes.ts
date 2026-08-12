import { Router, Request, Response } from 'express';
import StudyResource from '../../models/StudyResource';
import { optionalAuthMiddleware } from '../../middlewares/authMiddleware';
import { withContentCategory } from '../../utils/resourceCategory';
import {
  PUBLIC_RESOURCE_PROJECTION,
  applyPublicVisibilityFloor,
  escapeRegex,
  isStaffRequest,
  publicClassClause,
} from '../../utils/publicResourceVisibility';

/**
 * Public learning content — the read surface for guests and public learners.
 *
 * SECURITY: every handler runs `applyPublicVisibilityFloor` on the LOOKUP, so a
 * non-staff caller can only ever reach `status: 'published' && isPublic: true`
 * StudyResources. Nothing here touches Lecture, Material, Course, Homework or
 * any institute-scoped collection — those remain auth-gated and institute-only,
 * and are deliberately NOT exposed to make the public UI richer.
 *
 * Everything is served from StudyResource, which is the only genuinely public
 * content collection in the system.
 */

const router = Router();

/** Cap on any single page of results. */
const MAX_LIMIT = 60;
const clampLimit = (value: unknown, fallback: number) =>
  Math.min(Math.max(Number(value) || fallback, 1), MAX_LIMIT);

/**
 * Fields the public list UIs actually render. Kept narrow so a list of 60 rows
 * doesn't ship descriptions and tag arrays the cards never show.
 */
const LIST_FIELDS =
  'title type subject classLevel chapter board thumbnailUrl youtubeVideoId duration pageCount fileSize viewCount downloadCount isFeatured createdAt contentCategory resourceUrl';

/**
 * GET /api/public/subjects?classLevel=10
 *
 * The subjects that actually have public content, with real counts. Powers both
 * the Explore entry point and Home's subject shortcuts.
 *
 * Counts come from the data — a subject with no public content never appears,
 * so Explore cannot show a subject that leads to an empty screen.
 */
router.get('/subjects', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const match: any = {};
    applyPublicVisibilityFloor(match, req);

    const classClause = publicClassClause(req.query.classLevel as string | undefined);
    if (classClause) Object.assign(match, classClause);

    const rows = await StudyResource.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$subject',
          total: { $sum: 1 },
          lectures: { $sum: { $cond: [{ $eq: ['$type', 'video'] }, 1, 0] } },
          materials: { $sum: { $cond: [{ $eq: ['$type', 'pdf'] }, 1, 0] } },
          // Whether this subject can be browsed by chapter at all. Drives the
          // adaptive Subject screen — no empty chapter scaffolding is ever shown.
          chapters: { $addToSet: '$chapter' },
        },
      },
      { $sort: { total: -1, _id: 1 } },
    ]);

    res.json(
      rows
        .filter((r) => r._id) // skip resources with no subject at all
        .map((r) => ({
          subject: r._id as string,
          total: r.total as number,
          lectures: r.lectures as number,
          materials: r.materials as number,
          chapterCount: (r.chapters || []).filter(Boolean).length,
        })),
    );
  } catch (error: any) {
    console.error('Error fetching public subjects:', error);
    res.status(500).json({ message: 'Unable to load subjects right now.' });
  }
});

/**
 * GET /api/public/subject-content?subject=Physics&classLevel=10&type=&limit=&skip=
 *
 * Everything public in one subject, grouped by chapter WHEN chapter data
 * exists. The response tells the client which shape it is (`chaptered`), so the
 * UI adapts to the data instead of rendering an empty hierarchy.
 *
 * Chapter grouping happens server-side because the client would otherwise need
 * the whole subject in memory to group it — which is exactly what we're trying
 * to stop doing.
 */
router.get('/subject-content', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const subject = String(req.query.subject || '').trim();
    if (!subject) return res.status(400).json({ message: 'A subject is required.' });

    const limit = clampLimit(req.query.limit, 40);
    const skip = Math.max(Number(req.query.skip) || 0, 0);
    const type = req.query.type === 'video' || req.query.type === 'pdf' ? req.query.type : null;

    const query: any = { subject };
    applyPublicVisibilityFloor(query, req);
    const classClause = publicClassClause(req.query.classLevel as string | undefined);
    if (classClause) Object.assign(query, classClause);
    if (type) query.type = type;

    const [rows, total] = await Promise.all([
      StudyResource.find(query)
        .select(isStaffRequest(req) ? LIST_FIELDS : LIST_FIELDS)
        .sort({ chapter: 1, isFeatured: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StudyResource.countDocuments(query),
    ]);

    const items = rows.map((r) => withContentCategory(r));

    // A subject is "chaptered" only if real chapter data exists on this page.
    const chapterNames = Array.from(
      new Set(items.map((i: any) => (i.chapter || '').trim()).filter(Boolean)),
    ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const chaptered = chapterNames.length > 0;

    return res.json({
      subject,
      chaptered,
      // Present only in the chaptered shape. Untagged items land in a trailing
      // group rather than being hidden.
      chapters: chaptered
        ? [
            ...chapterNames.map((name) => ({
              name,
              items: items.filter((i: any) => (i.chapter || '').trim() === name),
            })),
            ...(items.some((i: any) => !(i.chapter || '').trim())
              ? [{ name: null, items: items.filter((i: any) => !(i.chapter || '').trim()) }]
              : []),
          ]
        : undefined,
      // Always present, so a client can render a flat list regardless of shape.
      items,
      total,
      skip,
      limit,
      hasMore: skip + rows.length < total,
    });
  } catch (error: any) {
    console.error('Error fetching subject content:', error);
    res.status(500).json({ message: 'Unable to load this subject right now.' });
  }
});

/**
 * GET /api/public/search?q=motion&classLevel=10&limit=
 *
 * One typed result list — subjects, chapters and resources — rather than a
 * filtering interface. Search exists to REDUCE navigation, so it returns
 * navigable destinations (a subject, a chapter) alongside content.
 *
 * Ranking is deliberately simple and honest: title matches beat description
 * matches, featured beats non-featured, newer beats older. There is no
 * relevance score to fabricate.
 */
router.get('/search', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ query: q, results: [] });

    const limit = clampLimit(req.query.limit, 30);
    const rx = new RegExp(escapeRegex(q), 'i');

    const base: any = {};
    applyPublicVisibilityFloor(base, req);
    const classClause = publicClassClause(req.query.classLevel as string | undefined);

    // Class is a RANKING boundary, not a hard filter: a learner searching for
    // something outside their class should still find it rather than be told
    // nothing exists. In-class results are surfaced first.
    const contentQuery: any = {
      ...base,
      $or: [{ title: rx }, { description: rx }, { tags: rx }, { chapter: rx }],
    };

    const [resources, subjectRows, chapterRows] = await Promise.all([
      StudyResource.find(contentQuery)
        .select(LIST_FIELDS)
        .sort({ isFeatured: -1, createdAt: -1 })
        .limit(limit)
        .lean(),
      // Subjects whose NAME matches — a navigable destination, not a document.
      StudyResource.aggregate([
        { $match: { ...base, subject: rx } },
        { $group: { _id: '$subject', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
      // Chapters whose name matches, scoped to their subject.
      StudyResource.aggregate([
        { $match: { ...base, chapter: rx } },
        { $group: { _id: { chapter: '$chapter', subject: '$subject' }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
    ]);

    const inClass = (item: any) => {
      if (!classClause) return 0;
      const variants: string[] = (classClause as any).classLevel.$in;
      return variants.includes(String(item.classLevel || '').trim()) ? -1 : 0;
    };

    const results = [
      ...subjectRows
        .filter((s) => s._id)
        .map((s) => ({
          kind: 'subject' as const,
          subject: s._id as string,
          count: s.count as number,
        })),
      ...chapterRows
        .filter((c) => c._id?.chapter)
        .map((c) => ({
          kind: 'chapter' as const,
          chapter: c._id.chapter as string,
          subject: c._id.subject as string,
          count: c.count as number,
        })),
      ...resources
        .map((r) => withContentCategory(r))
        .sort((a: any, b: any) => inClass(a) - inClass(b))
        .map((r: any) => ({ kind: 'resource' as const, ...r })),
    ];

    return res.json({ query: q, results });
  } catch (error: any) {
    console.error('Error running public search:', error);
    res.status(500).json({ message: 'Search is unavailable right now.' });
  }
});

/**
 * GET /api/public/home?classLevel=10
 *
 * The guest/unpersonalized home in ONE round trip. Composing this client-side
 * would cost 3 sequential requests on a mobile network before anything renders.
 *
 * Sections are only returned when they have content, so the client never has to
 * decide whether to hide an empty container.
 */
router.get('/home', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const base: any = {};
    applyPublicVisibilityFloor(base, req);
    const classClause = publicClassClause(req.query.classLevel as string | undefined);
    const scoped = { ...base, ...(classClause || {}) };

    const [featured, recent, subjectRows] = await Promise.all([
      StudyResource.find({ ...scoped, isFeatured: true })
        .select(LIST_FIELDS)
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
      StudyResource.find(scoped)
        .select(LIST_FIELDS)
        .sort({ createdAt: -1 })
        .limit(12)
        .lean(),
      StudyResource.aggregate([
        { $match: scoped },
        { $group: { _id: '$subject', total: { $sum: 1 } } },
        { $sort: { total: -1, _id: 1 } },
        { $limit: 12 },
      ]),
    ]);

    return res.json({
      classLevel: (req.query.classLevel as string) || null,
      subjects: subjectRows
        .filter((s) => s._id)
        .map((s) => ({ subject: s._id as string, total: s.total as number })),
      featured: featured.map((r) => withContentCategory(r)),
      recent: recent.map((r) => withContentCategory(r)),
    });
  } catch (error: any) {
    console.error('Error building public home:', error);
    res.status(500).json({ message: 'Unable to load content right now.' });
  }
});

export default router;
