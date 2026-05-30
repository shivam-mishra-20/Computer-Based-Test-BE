import { Router, Request, Response } from 'express';
import Course from '../../models/Course';
import PlaylistImport from '../../models/PlaylistImport';
import StudyResource from '../../models/StudyResource';
import { authMiddleware, requireRole } from '../../middlewares/authMiddleware';
import {
  extractPlaylistId,
  fetchPlaylistMeta,
  fetchPlaylistVideos,
  PlaylistVideo,
} from '../../services/youtubeService';
import { logger } from '../../utils/logger';

const router = Router();
router.use(authMiddleware);

function isQuotaError(err: any): boolean {
  const msg = String(err?.response?.data?.error?.message || err?.message || '');
  return msg.toLowerCase().includes('quota');
}

// ─── Preview playlist (before import) ────────────────────────────────────────
// POST /api/playlist/preview
// Body: { playlistUrl: string }
router.post('/preview', requireRole('admin', 'teacher'), async (req: Request, res: Response) => {
  try {
    const { playlistUrl } = req.body;
    if (!playlistUrl?.trim()) {
      return res.status(400).json({ error: 'playlistUrl is required' });
    }

    const playlistId = extractPlaylistId(String(playlistUrl).trim());
    if (!playlistId) {
      return res.status(400).json({ error: 'Invalid YouTube playlist URL. Make sure the URL contains ?list= or is a valid playlist ID.' });
    }

    const [meta, videos] = await Promise.all([
      fetchPlaylistMeta(playlistId),
      fetchPlaylistVideos(playlistId),
    ]);

    if (videos.length === 0) {
      return res.status(400).json({ error: 'Playlist is empty or contains no publicly accessible videos.' });
    }

    return res.json({
      playlistId,
      meta,
      videos,
      totalVideos: videos.length,
    });
  } catch (err: any) {
    logger.error('Playlist preview failed', { error: err.message });
    if (isQuotaError(err)) {
      return res.status(429).json({ error: 'YouTube API quota exceeded. Please try again later.' });
    }
    return res.status(400).json({ error: err.message || 'Failed to fetch playlist' });
  }
});

// ─── Import playlist as a new course ─────────────────────────────────────────
// POST /api/playlist/import
// Body: { classLevel, subject, courseName, playlistUrl, isFree?, moduleName? }
router.post('/import', requireRole('admin', 'teacher'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const {
      classLevel,
      subject,
      courseName,
      playlistUrl,
      isFree = false,
      moduleName,
    } = req.body;

    if (!classLevel || !subject || !courseName?.trim() || !playlistUrl?.trim()) {
      return res.status(400).json({
        error: 'classLevel, subject, courseName, and playlistUrl are all required',
      });
    }

    const playlistId = extractPlaylistId(String(playlistUrl).trim());
    if (!playlistId) {
      return res.status(400).json({ error: 'Invalid YouTube playlist URL' });
    }

    // Guard: duplicate playlist import
    const existing = await PlaylistImport.findOne({ playlistId });
    if (existing) {
      const existingCourse = await Course.findById(existing.courseId).select('title').lean();
      if (existingCourse) {
        return res.status(409).json({
          error: 'This playlist has already been imported as a course',
          existingCourseId: existing.courseId,
          existingCourseTitle: (existingCourse as any).title,
        });
      }
      // Course was deleted — clean up stale record
      await PlaylistImport.deleteOne({ _id: existing._id });
    }

    // Fetch playlist data from YouTube
    const [meta, videos] = await Promise.all([
      fetchPlaylistMeta(playlistId),
      fetchPlaylistVideos(playlistId),
    ]);

    if (videos.length === 0) {
      return res.status(400).json({ error: 'Playlist is empty or contains no accessible videos' });
    }

    // Build the syllabus module (identical structure to manual course creation)
    const lectures = videos.map((v: PlaylistVideo, i: number) => ({
      title: v.title,
      videoUrl: `https://www.youtube.com/watch?v=${v.videoId}`,
      youtubeVideoId: v.videoId,
      duration: v.durationSec > 0 ? Math.ceil(v.durationSec / 60) : undefined,
      order: i,
      youtubeMeta: {
        durationSec: v.durationSec,
        thumbnail: v.thumbnail,
        title: v.title,
        fetchedAt: new Date(),
      },
    }));

    const course = new Course({
      title: String(courseName).trim(),
      description: meta.description || `Imported from YouTube playlist: ${meta.title}`,
      subject: String(subject).trim(),
      classLevel: String(classLevel).trim(),
      instructor: user.id,
      thumbnail: meta.thumbnail || undefined,
      isFree: Boolean(isFree),
      status: 'draft',
      lectureCount: lectures.length,
      syllabus: [
        {
          title: moduleName?.trim() || meta.title || 'All Lectures',
          description: `Imported from YouTube · ${meta.channelName}`,
          lectures,
        },
      ],
    });

    await course.save();

    await PlaylistImport.create({
      courseId: course._id,
      playlistId,
      playlistTitle: meta.title,
      playlistDescription: meta.description,
      playlistThumbnail: meta.thumbnail,
      channelId: meta.channelId,
      channelName: meta.channelName,
      totalVideos: meta.totalVideos,
      importedVideoCount: videos.length,
      lastSyncedAt: new Date(),
      syncStatus: 'idle',
    });

    logger.info('Playlist imported as course', {
      courseId: course._id,
      playlistId,
      lectures: lectures.length,
    });

    return res.status(201).json({
      courseId: course._id,
      courseTitle: course.title,
      lectureCount: lectures.length,
      message: `Successfully imported ${lectures.length} lectures from "${meta.title}"`,
    });
  } catch (err: any) {
    logger.error('Playlist import failed', { error: err.message });
    if (isQuotaError(err)) {
      return res.status(429).json({ error: 'YouTube API quota exceeded. Please try again later.' });
    }
    return res.status(500).json({ error: err.message || 'Import failed' });
  }
});

// ─── Get playlist info for a course ──────────────────────────────────────────
// GET /api/playlist/course/:courseId
router.get('/course/:courseId', async (req: Request, res: Response) => {
  try {
    const pi = await PlaylistImport.findOne({ courseId: req.params.courseId }).lean();
    if (!pi) return res.status(404).json({ error: 'No playlist linked to this course' });
    return res.json(pi);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Sync playlist with existing course ──────────────────────────────────────
// POST /api/playlist/course/:courseId/sync
router.post('/course/:courseId/sync', requireRole('admin', 'teacher'), async (req: Request, res: Response) => {
  const { courseId } = req.params;

  const pi = await PlaylistImport.findOne({ courseId });
  if (!pi) return res.status(404).json({ error: 'No playlist linked to this course' });

  const course = await Course.findById(courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });

  if (!course.syllabus || course.syllabus.length === 0) {
    return res.status(400).json({ error: 'Course has no modules to sync into' });
  }

  // Mark as syncing
  pi.syncStatus = 'syncing';
  pi.syncError = undefined;
  await pi.save();

  try {
    const latestVideos = await fetchPlaylistVideos(pi.playlistId);

    // Build lookup: youtubeVideoId → { moduleIdx, lectureIdx, snapshot }
    const existingMap = new Map<string, { mIdx: number; lIdx: number; lec: any }>();
    course.syllabus.forEach((mod: any, mIdx: number) => {
      mod.lectures.forEach((lec: any, lIdx: number) => {
        if (lec.youtubeVideoId) {
          existingMap.set(lec.youtubeVideoId, { mIdx, lIdx, lec });
        }
      });
    });

    const stats = { added: 0, updated: 0, unchanged: 0 };
    const newLectures: any[] = [];

    // Determine target module index for new videos (first module in the course)
    const targetModuleIdx = 0;

    for (let newPos = 0; newPos < latestVideos.length; newPos++) {
      const v = latestVideos[newPos];

      if (existingMap.has(v.videoId)) {
        // Existing lecture — update changed fields
        const { mIdx, lIdx, lec } = existingMap.get(v.videoId)!;
        const updates: Record<string, any> = {};
        const base = `syllabus.${mIdx}.lectures.${lIdx}`;

        if (lec.title !== v.title) updates[`${base}.title`] = v.title;
        if (lec.order !== newPos) updates[`${base}.order`] = newPos;
        if (v.durationSec > 0 && lec.youtubeMeta?.durationSec !== v.durationSec) {
          updates[`${base}.duration`] = Math.ceil(v.durationSec / 60);
          updates[`${base}.youtubeMeta.durationSec`] = v.durationSec;
          updates[`${base}.youtubeMeta.thumbnail`] = v.thumbnail;
          updates[`${base}.youtubeMeta.fetchedAt`] = new Date();
        }

        if (Object.keys(updates).length > 0) {
          await Course.findByIdAndUpdate(courseId, { $set: updates });
          stats.updated++;
        } else {
          stats.unchanged++;
        }
      } else {
        // New video — queue for bulk insert
        newLectures.push({
          title: v.title,
          videoUrl: `https://www.youtube.com/watch?v=${v.videoId}`,
          youtubeVideoId: v.videoId,
          duration: v.durationSec > 0 ? Math.ceil(v.durationSec / 60) : undefined,
          order: newPos,
          youtubeMeta: {
            durationSec: v.durationSec,
            thumbnail: v.thumbnail,
            title: v.title,
            fetchedAt: new Date(),
          },
        });
        stats.added++;
      }
    }

    // Bulk-insert new lectures in a single DB operation
    if (newLectures.length > 0) {
      await Course.findByIdAndUpdate(courseId, {
        $push: { [`syllabus.${targetModuleIdx}.lectures`]: { $each: newLectures } },
        $inc: { lectureCount: newLectures.length },
      });
    }

    pi.lastSyncedAt = new Date();
    pi.syncStatus = 'idle';
    pi.importedVideoCount = latestVideos.length;
    await pi.save();

    logger.info('Playlist synced', { courseId, stats });

    return res.json({
      message: 'Sync completed successfully',
      stats,
      syncedAt: pi.lastSyncedAt,
    });
  } catch (err: any) {
    pi.syncStatus = 'error';
    pi.syncError = err.message || 'Unknown sync error';
    await pi.save();

    logger.error('Playlist sync failed', { courseId, error: err.message });

    if (isQuotaError(err)) {
      return res.status(429).json({ error: 'YouTube API quota exceeded. Please try again later.' });
    }
    return res.status(500).json({ error: err.message || 'Sync failed' });
  }
});

// ─── Import playlist as bulk Study Resources (Videos) ────────────────────────
// POST /api/playlist/import-resources
// Body: { playlistUrl, subject, classLevel, category, tags?, batch?, isPublic? }
router.post('/import-resources', requireRole('admin', 'teacher'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const {
      playlistUrl,
      subject,
      classLevel,
      category,
      tags = [],
      batch,
      isPublic = true,
    } = req.body;

    if (!playlistUrl?.trim() || !subject?.trim() || !classLevel?.trim() || !category?.trim()) {
      return res.status(400).json({
        error: 'playlistUrl, subject, classLevel, and category are all required',
      });
    }

    const playlistId = extractPlaylistId(String(playlistUrl).trim());
    if (!playlistId) {
      return res.status(400).json({ error: 'Invalid YouTube playlist URL' });
    }

    const [meta, videos] = await Promise.all([
      fetchPlaylistMeta(playlistId),
      fetchPlaylistVideos(playlistId),
    ]);

    if (videos.length === 0) {
      return res.status(400).json({ error: 'Playlist is empty or contains no accessible videos' });
    }

    const normalizedTags: string[] = Array.isArray(tags)
      ? tags.map((t: string) => String(t).trim()).filter(Boolean)
      : String(tags).split(',').map((t: string) => t.trim()).filter(Boolean);

    // Build StudyResource documents (identical to what manual creation produces)
    const docs = videos.map((v: PlaylistVideo) => ({
      title: v.title,
      description: v.description || '',
      type: 'video' as const,
      resourceUrl: `https://www.youtube.com/watch?v=${v.videoId}`,
      thumbnailUrl:
        v.thumbnail || `https://img.youtube.com/vi/${v.videoId}/mqdefault.jpg`,
      category: category.trim(),
      subject: subject.trim(),
      classLevel: classLevel.trim(),
      batch: batch?.trim() || undefined,
      tags: normalizedTags,
      uploadedBy: user.id,
      status: 'published' as const,
      youtubeVideoId: v.videoId,
      duration: v.durationSec > 0 ? v.durationSec : undefined,
      isPublic: Boolean(isPublic),
      isFeatured: false,
    }));

    const inserted = await StudyResource.insertMany(docs, { ordered: false });

    logger.info('Playlist resources imported', {
      playlistId,
      count: inserted.length,
      subject,
      classLevel,
    });

    return res.status(201).json({
      imported: inserted.length,
      playlistTitle: meta.title,
      channelName: meta.channelName,
      message: `Successfully imported ${inserted.length} videos from "${meta.title}"`,
    });
  } catch (err: any) {
    logger.error('Resource playlist import failed', { error: err.message });
    if (isQuotaError(err)) {
      return res.status(429).json({ error: 'YouTube API quota exceeded. Please try again later.' });
    }
    return res.status(500).json({ error: err.message || 'Import failed' });
  }
});

export default router;
