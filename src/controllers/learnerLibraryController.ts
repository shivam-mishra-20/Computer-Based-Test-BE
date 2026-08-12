import { Request, Response } from 'express';
import mongoose from 'mongoose';
import LearnerProgress, { COMPLETION_THRESHOLD } from '../models/LearnerProgress';
import LearnerSave from '../models/LearnerSave';
import StudyResource from '../models/StudyResource';
import User from '../models/User';
import { withContentCategory } from '../utils/resourceCategory';
import { publicClassClause } from '../utils/publicResourceVisibility';

/**
 * Public learner library: personalized home, saves and progress.
 *
 * Every handler is gated on `accountType === 'PUBLIC_LEARNER'` (see
 * requireLearner) so an institute student's token can never create learner
 * state, and learner state can never be read into institute analytics.
 *
 * All content reads go through the SAME public visibility floor as the guest
 * endpoints — signing in grants personalization, never access to more content.
 */

const LIST_FIELDS =
  'title type subject classLevel chapter board thumbnailUrl youtubeVideoId duration pageCount fileSize viewCount downloadCount isFeatured createdAt contentCategory resourceUrl';

/** The public floor, expressed for handlers that build their own queries. */
const PUBLIC_FLOOR = { status: 'published', isPublic: true } as const;

type LearnerCtx = { id: string; classLevel?: string; subjects: string[] };

/**
 * Resolve the caller as a public learner, or send the right error.
 * Returns null when the response has already been sent.
 */
async function requireLearner(req: Request, res: Response): Promise<LearnerCtx | null> {
  const current = (req as any).user as { id: string } | undefined;
  if (!current) {
    res.status(401).json({ message: 'Unauthorized' });
    return null;
  }

  const user = await User.findById(current.id).select('accountType learnerProfile').lean();
  if (!user) {
    res.status(404).json({ message: 'Account not found' });
    return null;
  }
  if (user.accountType !== 'PUBLIC_LEARNER') {
    res.status(403).json({ message: 'Not a public learner account' });
    return null;
  }

  return {
    id: current.id,
    classLevel: (user as any).learnerProfile?.classLevel,
    subjects: ((user as any).learnerProfile?.subjects || []) as string[],
  };
}

const toObjectId = (value: string) =>
  mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;

// ─── Home ────────────────────────────────────────────────────────────────────

/**
 * GET /api/learner/home
 *
 * The personalized home in one round trip.
 *
 * Deliberately honest about what it can and cannot know:
 *  - `continueLearning` is real playback state, so it is only non-empty when
 *    the learner has actually started something. The client shows discovery
 *    instead of an empty "Continue" shelf.
 *  - `subjectShelves` are the learner's OWN chosen subjects. There is no
 *    recommendation model in this system, so nothing is presented as
 *    "recommended for you" — that would be fabricated intelligence.
 *  - No streaks, scores or achievements: there is no data behind them.
 */
export const getLearnerHome = async (req: Request, res: Response) => {
  try {
    const learner = await requireLearner(req, res);
    if (!learner) return;

    const classClause = publicClassClause(learner.classLevel);
    const scoped: any = { ...PUBLIC_FLOOR, ...(classClause || {}) };

    // 1. Continue learning — started, not finished, most recent first.
    const inProgress = await LearnerProgress.find({
      learnerId: learner.id,
      completed: false,
      positionSec: { $gt: 0 },
    })
      .sort({ lastAccessedAt: -1 })
      .limit(6)
      .lean();

    const progressByResource = new Map(
      inProgress.map((p) => [String(p.resourceId), p]),
    );

    // Resources may have been unpublished or deleted since the learner watched
    // them; the public floor here is what drops those from the shelf.
    const continueResources = inProgress.length
      ? await StudyResource.find({
          _id: { $in: inProgress.map((p) => p.resourceId) },
          ...PUBLIC_FLOOR,
        })
          .select(LIST_FIELDS)
          .lean()
      : [];

    const continueLearning = continueResources
      .map((r: any) => {
        const p = progressByResource.get(String(r._id));
        return {
          ...withContentCategory(r),
          progress: p
            ? { positionSec: p.positionSec, percent: p.percent, lastAccessedAt: p.lastAccessedAt }
            : undefined,
        };
      })
      .sort(
        (a: any, b: any) =>
          new Date(b.progress?.lastAccessedAt || 0).getTime() -
          new Date(a.progress?.lastAccessedAt || 0).getTime(),
      );

    // 2. The learner's chosen subjects, with counts, in their own order.
    const subjectShelves = learner.subjects.length
      ? await StudyResource.aggregate([
          { $match: { ...scoped, subject: { $in: learner.subjects } } },
          { $group: { _id: '$subject', total: { $sum: 1 } } },
        ])
      : [];

    const shelfOrder = new Map(learner.subjects.map((s, i) => [s, i]));

    // 3. New in the learner's class + subjects. Falls back to class-only when
    //    they picked no subjects, so the shelf is never empty for that reason.
    const recentQuery: any = { ...scoped };
    if (learner.subjects.length) recentQuery.subject = { $in: learner.subjects };

    let recent = await StudyResource.find(recentQuery)
      .select(LIST_FIELDS)
      .sort({ createdAt: -1 })
      .limit(12)
      .lean();

    if (recent.length === 0 && learner.subjects.length) {
      recent = await StudyResource.find(scoped)
        .select(LIST_FIELDS)
        .sort({ createdAt: -1 })
        .limit(12)
        .lean();
    }

    return res.json({
      classLevel: learner.classLevel || null,
      subjects: learner.subjects,
      continueLearning,
      subjectShelves: subjectShelves
        .filter((s) => s._id)
        .map((s) => ({ subject: s._id as string, total: s.total as number }))
        .sort((a, b) => (shelfOrder.get(a.subject) ?? 99) - (shelfOrder.get(b.subject) ?? 99)),
      recent: recent.map((r) => withContentCategory(r)),
    });
  } catch (error) {
    console.error('Error building learner home:', error);
    return res.status(500).json({ message: 'Unable to load your home right now.' });
  }
};

// ─── Saves ───────────────────────────────────────────────────────────────────

/** GET /api/learner/saves — the learner's saved resources, newest first. */
export const listSaves = async (req: Request, res: Response) => {
  try {
    const learner = await requireLearner(req, res);
    if (!learner) return;

    const saves = await LearnerSave.find({ learnerId: learner.id })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    if (saves.length === 0) return res.json({ items: [] });

    // The floor applies here too: a resource unpublished after being saved
    // simply stops appearing rather than 404-ing when opened.
    const resources = await StudyResource.find({
      _id: { $in: saves.map((s) => s.resourceId) },
      ...PUBLIC_FLOOR,
    })
      .select(LIST_FIELDS)
      .lean();

    const savedAt = new Map(saves.map((s) => [String(s.resourceId), s.createdAt]));

    return res.json({
      items: resources
        .map((r: any) => ({ ...withContentCategory(r), savedAt: savedAt.get(String(r._id)) }))
        .sort(
          (a: any, b: any) => new Date(b.savedAt || 0).getTime() - new Date(a.savedAt || 0).getTime(),
        ),
    });
  } catch (error) {
    console.error('Error listing saves:', error);
    return res.status(500).json({ message: 'Unable to load your saved items.' });
  }
};

/**
 * POST /api/learner/saves  { resourceId }
 * Idempotent: saving twice is a no-op, which makes the client's optimistic
 * toggle safe to retry.
 */
export const addSave = async (req: Request, res: Response) => {
  try {
    const learner = await requireLearner(req, res);
    if (!learner) return;

    const resourceId = toObjectId(String(req.body?.resourceId || ''));
    if (!resourceId) return res.status(400).json({ message: 'A valid resourceId is required.' });

    // Only genuinely public content can be saved — this stops a crafted id from
    // creating a save row pointing at institute-only material.
    const exists = await StudyResource.exists({ _id: resourceId, ...PUBLIC_FLOOR });
    if (!exists) return res.status(404).json({ message: 'Content not found.' });

    await LearnerSave.updateOne(
      { learnerId: learner.id, itemType: 'RESOURCE', resourceId },
      { $setOnInsert: { learnerId: learner.id, itemType: 'RESOURCE', resourceId } },
      { upsert: true },
    );

    return res.status(201).json({ saved: true, resourceId: String(resourceId) });
  } catch (error) {
    console.error('Error adding save:', error);
    return res.status(500).json({ message: 'Unable to save that right now.' });
  }
};

/** DELETE /api/learner/saves/:resourceId — also idempotent. */
export const removeSave = async (req: Request, res: Response) => {
  try {
    const learner = await requireLearner(req, res);
    if (!learner) return;

    const resourceId = toObjectId(String(req.params.resourceId || ''));
    if (!resourceId) return res.status(400).json({ message: 'A valid resourceId is required.' });

    await LearnerSave.deleteOne({ learnerId: learner.id, resourceId });
    return res.json({ saved: false, resourceId: String(resourceId) });
  } catch (error) {
    console.error('Error removing save:', error);
    return res.status(500).json({ message: 'Unable to update that right now.' });
  }
};

// ─── Progress ────────────────────────────────────────────────────────────────

/**
 * GET /api/learner/progress?resourceIds=a,b,c
 *
 * Batch read so a list screen resolves every row's progress in one request
 * instead of one per card. Without `resourceIds` it returns the full library
 * state (capped), which is what My Stuff needs.
 */
export const getProgress = async (req: Request, res: Response) => {
  try {
    const learner = await requireLearner(req, res);
    if (!learner) return;

    const query: any = { learnerId: learner.id };
    const raw = String(req.query.resourceIds || '').trim();
    if (raw) {
      const ids = raw
        .split(',')
        .map((s) => toObjectId(s.trim()))
        .filter(Boolean);
      if (ids.length === 0) return res.json({ items: [] });
      query.resourceId = { $in: ids };
    }

    const rows = await LearnerProgress.find(query)
      .sort({ lastAccessedAt: -1 })
      .limit(500)
      .lean();

    return res.json({
      items: rows.map((r) => ({
        resourceId: String(r.resourceId),
        positionSec: r.positionSec,
        durationSec: r.durationSec,
        percent: r.percent,
        completed: r.completed,
        lastAccessedAt: r.lastAccessedAt,
      })),
    });
  } catch (error) {
    console.error('Error reading progress:', error);
    return res.status(500).json({ message: 'Unable to load your progress.' });
  }
};

/**
 * PUT /api/learner/progress  { resourceId, positionSec, durationSec, completed? }
 *
 * Upsert-per-resource. Completion is derived from the 90% threshold rather than
 * trusted from the client, but an explicit `completed: true` is honoured so a
 * "Mark as finished" action works. Completion is sticky — re-watching a
 * finished lecture does not un-finish it, which is what a learner expects.
 */
export const upsertProgress = async (req: Request, res: Response) => {
  try {
    const learner = await requireLearner(req, res);
    if (!learner) return;

    const resourceId = toObjectId(String(req.body?.resourceId || ''));
    if (!resourceId) return res.status(400).json({ message: 'A valid resourceId is required.' });

    const exists = await StudyResource.exists({ _id: resourceId, ...PUBLIC_FLOOR });
    if (!exists) return res.status(404).json({ message: 'Content not found.' });

    const positionSec = Math.max(Number(req.body?.positionSec) || 0, 0);
    const durationSec = Math.max(Number(req.body?.durationSec) || 0, 0);
    const percent = durationSec > 0 ? Math.min(positionSec / durationSec, 1) : 0;

    const existing = await LearnerProgress.findOne({ learnerId: learner.id, resourceId }).lean();
    const reachedThreshold = percent >= COMPLETION_THRESHOLD;
    const completed =
      existing?.completed === true || req.body?.completed === true || reachedThreshold;

    const update: any = {
      positionSec,
      durationSec,
      percent,
      completed,
      lastAccessedAt: new Date(),
    };
    if (completed && !existing?.completedAt) update.completedAt = new Date();

    const saved = await LearnerProgress.findOneAndUpdate(
      { learnerId: learner.id, resourceId },
      { $set: update, $setOnInsert: { learnerId: learner.id, resourceId } },
      { upsert: true, new: true },
    ).lean();

    return res.json({
      resourceId: String(resourceId),
      positionSec: saved?.positionSec ?? positionSec,
      durationSec: saved?.durationSec ?? durationSec,
      percent: saved?.percent ?? percent,
      completed: saved?.completed ?? completed,
    });
  } catch (error) {
    console.error('Error saving progress:', error);
    return res.status(500).json({ message: 'Unable to save your progress.' });
  }
};

/**
 * GET /api/learner/library?status=continue|saved|finished
 * Backs My Stuff's three segments from one endpoint.
 */
export const getLibrary = async (req: Request, res: Response) => {
  try {
    const learner = await requireLearner(req, res);
    if (!learner) return;

    const status = String(req.query.status || 'continue');

    if (status === 'saved') {
      return listSaves(req, res);
    }

    const query: any = { learnerId: learner.id };
    if (status === 'finished') {
      query.completed = true;
    } else {
      query.completed = false;
      query.positionSec = { $gt: 0 };
    }

    const rows = await LearnerProgress.find(query)
      .sort({ lastAccessedAt: -1 })
      .limit(100)
      .lean();

    if (rows.length === 0) return res.json({ items: [] });

    const resources = await StudyResource.find({
      _id: { $in: rows.map((r) => r.resourceId) },
      ...PUBLIC_FLOOR,
    })
      .select(LIST_FIELDS)
      .lean();

    const byId = new Map(rows.map((r) => [String(r.resourceId), r]));

    return res.json({
      items: resources
        .map((r: any) => {
          const p = byId.get(String(r._id));
          return {
            ...withContentCategory(r),
            progress: p
              ? {
                  positionSec: p.positionSec,
                  percent: p.percent,
                  completed: p.completed,
                  lastAccessedAt: p.lastAccessedAt,
                }
              : undefined,
          };
        })
        .sort(
          (a: any, b: any) =>
            new Date(b.progress?.lastAccessedAt || 0).getTime() -
            new Date(a.progress?.lastAccessedAt || 0).getTime(),
        ),
    });
  } catch (error) {
    console.error('Error loading library:', error);
    return res.status(500).json({ message: 'Unable to load your library.' });
  }
};
