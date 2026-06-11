import { Router, Request, Response } from 'express';
import Course from '../../models/Course';
import CourseProgress from '../../models/CourseProgress';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { cacheMiddleware, invalidateCacheOn } from '../../utils/cacheHelpers';

const router = Router();

function normalizeClassLevel(input?: string): string {
  if (!input) return '';
  const match = String(input).match(/(\d{1,2})/);
  if (match) return String(Number(match[1]));
  return String(input).trim().toLowerCase();
}

function classFilterQuery(classLevel?: string): any {
  if (!classLevel) return undefined;
  const normalized = normalizeClassLevel(classLevel);
  if (/^\d{1,2}$/.test(normalized)) {
    return { $regex: new RegExp(`^(Class\\s*)?${normalized}$`, 'i') };
  }
  return classLevel;
}

function classesMatch(studentClass?: string, courseClass?: string): boolean {
  if (!studentClass || !courseClass) return false;
  return normalizeClassLevel(studentClass) === normalizeClassLevel(courseClass);
}

function ensureStudentClassAccess(user: any, courseClassLevel?: string): boolean {
  return Boolean(user?.classLevel && courseClassLevel && classesMatch(user.classLevel, courseClassLevel));
}

function extractYouTubeId(input?: string): string | null {
  if (!input) return null;
  const value = String(input).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;

  const patterns = [
    /(?:youtube\.com\/watch\?.*?[?&]v=|youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[1];
  }

  return null;
}

function getFirstLectureThumbnail(syllabus?: any[]): string | undefined {
  const firstLecture = syllabus?.[0]?.lectures?.[0];
  if (!firstLecture) return undefined;

  if (firstLecture.youtubeMeta?.thumbnail) {
    return firstLecture.youtubeMeta.thumbnail;
  }

  const videoId = extractYouTubeId(firstLecture.youtubeVideoId || firstLecture.videoUrl);
  if (videoId) {
    return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
  }

  return undefined;
}

// Get all courses (admin/teacher sees all; students see only published) - Cached for 5 minutes
router.get('/', authMiddleware, cacheMiddleware({ ttl: 300, keyFn: (req) => `courses:list:user:${(req as any).user?.id}:${JSON.stringify(req.query)}` }), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { classLevel, subject, batch, status } = req.query;
    const isAdmin = ['admin', 'teacher'].includes(user.role);
    const requestedClassLevel = typeof classLevel === 'string' ? classLevel : '';

    const query: any = {};

    // Admins can see all statuses; students only see published
    if (isAdmin) {
      if (status) query.status = status; // allow filtering by status for admin
    } else {
      query.status = 'published';
    }

    // Filter by class level
    if (isAdmin) {
      if (requestedClassLevel) {
        query.classLevel = classFilterQuery(requestedClassLevel);
      }
    } else {
      if (!user.classLevel) {
        return res.status(403).json({ error: 'Student class is not assigned. Contact admin.' });
      }

      if (requestedClassLevel && !classesMatch(user.classLevel, requestedClassLevel)) {
        return res.status(403).json({ error: 'Students can only access courses for their own class' });
      }

      query.classLevel = classFilterQuery(user.classLevel);
    }

    if (typeof subject === 'string' && subject.trim()) query.subject = subject.trim();
    if (typeof batch === 'string' && batch.trim()) query.batch = batch.trim();

    const courses = await Course.find(query)
      .populate('instructor', 'name')
      .sort({ createdAt: -1 })
      .lean();

    if (isAdmin) {
      // Admins get full data including syllabus and lectureCount
      res.json(courses.map(c => ({ ...c, enrolledStudents: undefined })));
      return;
    }

    // Students: strip video URLs and add enrollment status
    const coursesWithStatus = await Promise.all(courses.map(async (course) => {
      const isEnrolled = course.enrolledStudents?.some(
        (id: any) => id.toString() === user.id
      );
      const resolvedThumbnail = course.thumbnail || getFirstLectureThumbnail(course.syllabus as any[]);

      const progress = await CourseProgress.findOne({
        studentId: user.id,
        courseId: course._id
      }).lean();

      return {
        ...course,
        thumbnail: resolvedThumbnail,
        isEnrolled,
        progressPercent: progress?.progressPercent || 0,
        enrolledStudents: undefined,
        syllabus: (course.syllabus || []).map((section: any) => ({
          ...section,
          lectures: section.lectures.map((lecture: any) => ({
            ...lecture,
            videoUrl: undefined,
            youtubeVideoId: undefined,
          }))
        }))
      };
    }));

    res.json(coursesWithStatus);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get course details - Cached per user for 5 minutes
router.get('/:courseId', authMiddleware, cacheMiddleware({ ttl: 300, keyFn: (req) => `course:${req.params.courseId}:user:${(req as any).user.id}` }), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const isAdmin = ['admin', 'teacher'].includes(user.role);
    const course = await Course.findById(req.params.courseId)
      .populate('instructor', 'name email')
      .lean();

    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    if (!isAdmin && !ensureStudentClassAccess(user, course.classLevel)) {
      return res.status(403).json({ error: 'You can only access courses for your own class' });
    }

    // Admins and teachers get full course data
    if (isAdmin) {
      res.json({ ...course, enrolledStudents: undefined });
      return;
    }

    const isEnrolled = course.enrolledStudents?.some(
      (id: any) => id.toString() === user.id
    );

    const progress = await CourseProgress.findOne({
      studentId: user.id,
      courseId: course._id
    }).lean();
    const resolvedThumbnail = course.thumbnail || getFirstLectureThumbnail(course.syllabus as any[]);

    // If not enrolled or free, hide video URLs
    const courseFinal = {
      ...course,
      thumbnail: resolvedThumbnail,
      isEnrolled,
      progressPercent: progress?.progressPercent || 0,
      completedLectures: progress?.completedLectures || [],
      enrolledStudents: undefined,
      syllabus: course.syllabus?.map(section => ({
        ...section,
        lectures: section.lectures.map(lecture => {
           const hasAccess = isEnrolled || course.isFree;
           return {
             ...lecture,
             videoUrl: hasAccess ? lecture.videoUrl : undefined,
             youtubeVideoId: hasAccess ? lecture.youtubeVideoId : undefined
           };
        })
      }))
    };

    res.json(courseFinal);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Enroll in a course - Invalidates course cache and enrolled list
router.post('/:courseId/enroll', authMiddleware, invalidateCacheOn(['courses', 'course:', 'enrolled']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    if (user.role !== 'student') {
      return res.status(403).json({ error: 'Only students can enroll in courses' });
    }

    const course = await Course.findById(req.params.courseId);
    
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    if (!ensureStudentClassAccess(user, course.classLevel)) {
      return res.status(403).json({ error: 'You can only enroll in courses for your own class' });
    }
    
    const alreadyEnrolled = course.enrolledStudents?.some(
      (id: any) => String(id) === String(user.id)
    );

    // Enrollment is idempotent: if the client's enrolled-state is stale and
    // the student taps Enroll again, treat it as success (and self-heal the
    // progress record) instead of a 400 that would strand them — unable to
    // enroll yet still shown as not-enrolled, so content looks locked.
    if (alreadyEnrolled) {
      await CourseProgress.findOneAndUpdate(
        { studentId: user.id, courseId: course._id },
        { studentId: user.id, courseId: course._id },
        { upsert: true, setDefaultsOnInsert: true }
      );
      return res.json({ success: true, message: 'Already enrolled', alreadyEnrolled: true });
    }

    // Add student to enrolled list
    await Course.findByIdAndUpdate(course._id, {
      $addToSet: { enrolledStudents: user.id }
    });

    // Create progress record
    await CourseProgress.findOneAndUpdate(
      { studentId: user.id, courseId: course._id },
      {
        studentId: user.id,
        courseId: course._id,
        enrolledAt: new Date()
      },
      { upsert: true }
    );

    res.json({ success: true, message: 'Enrolled successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update lecture progress - Invalidates enrolled courses cache
router.post('/:courseId/progress', authMiddleware, invalidateCacheOn(['enrolled', 'course:']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { lectureId, timeSpent } = req.body;

    if (user.role !== 'student') {
      return res.status(403).json({ error: 'Only students can update course progress' });
    }
    
    const course = await Course.findById(req.params.courseId);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    if (!ensureStudentClassAccess(user, course.classLevel)) {
      return res.status(403).json({ error: 'You can only track progress for your own class courses' });
    }
    
    // Calculate total lectures
    let totalLectures = 0;
    course.syllabus?.forEach(section => {
      totalLectures += section.lectures.length;
    });
    
    const progress = await CourseProgress.findOneAndUpdate(
      { studentId: user.id, courseId: course._id },
      {
        $addToSet: { completedLectures: lectureId },
        $set: { lastAccessedAt: new Date() },
        $inc: { timeSpent: timeSpent || 0 }
      },
      { new: true, upsert: true }
    );
    
    // Update progress percentage
    const completedCount = progress.completedLectures.length;
    const progressPercent = totalLectures > 0 
      ? Math.round((completedCount / totalLectures) * 100)
      : 0;
    
    progress.progressPercent = progressPercent;
    if (progressPercent === 100 && !progress.completedAt) {
      progress.completedAt = new Date();
    }
    await progress.save();
    
    res.json(progress);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Save video position for a lecture
router.post('/:courseId/lectures/:lectureId/position', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { courseId, lectureId } = req.params;
    const { position } = req.body; // position in seconds

    if (user.role !== 'student') {
      return res.status(403).json({ error: 'Only students can save lecture positions' });
    }

    const course = await Course.findById(courseId).select('classLevel').lean();
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    if (!ensureStudentClassAccess(user, (course as any).classLevel)) {
      return res.status(403).json({ error: 'You can only access lecture videos for your own class' });
    }
    
    if (typeof position !== 'number') {
      return res.status(400).json({ error: 'Position (in seconds) is required' });
    }
    
    const progress = await CourseProgress.findOneAndUpdate(
      { studentId: user.id, courseId },
      { 
        $set: { 
          [`lecturePositions.${lectureId}`]: position,
          lastWatchedLectureId: lectureId,
          lastAccessedAt: new Date()
        }
      },
      { new: true, upsert: true }
    );
    
    res.json({ success: true, position, lectureId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get video position for a lecture - Cached per user and lecture for 1 hour
router.get('/:courseId/lectures/:lectureId/position', authMiddleware, cacheMiddleware({ ttl: 3600, keyFn: (req) => `lecture-position:${req.params.courseId}:${req.params.lectureId}:user:${(req as any).user.id}` }), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { courseId, lectureId } = req.params;

    if (user.role !== 'student') {
      return res.status(403).json({ error: 'Only students can fetch lecture positions' });
    }

    const course = await Course.findById(courseId).select('classLevel').lean();
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    if (!ensureStudentClassAccess(user, (course as any).classLevel)) {
      return res.status(403).json({ error: 'You can only access lecture videos for your own class' });
    }
    
    const progress = await CourseProgress.findOne({ studentId: user.id, courseId }).lean();
    
    // Handle Map-like or plain object structure for lecturePositions
    const positions = progress?.lecturePositions;
    const position = positions instanceof Map 
      ? positions.get(lectureId) || 0
      : (positions as any)?.[lectureId] || 0;
    
    res.json({ position, lectureId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get enrolled courses with progress - Cached per user for 5 minutes
router.get('/my/enrolled', authMiddleware, cacheMiddleware({ ttl: 300, keyFn: (req) => `enrolled:user:${(req as any).user.id}` }), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    if (user.role !== 'student') {
      return res.status(403).json({ error: 'Only students can access enrolled courses' });
    }
    
    const progress = await CourseProgress.find({ studentId: user.id })
      .populate({
        path: 'courseId',
        select: 'title subject classLevel thumbnail lectureCount duration syllabus'
      })
      .sort({ lastAccessedAt: -1 })
      .lean();
    
    const enrolledCourses = progress
      .filter(p => p.courseId)
      .map(p => {
        const courseData = p.courseId as any;
        const resolvedThumbnail =
          courseData?.thumbnail || getFirstLectureThumbnail(courseData?.syllabus);

        return {
          ...courseData,
          thumbnail: resolvedThumbnail,
          progressPercent: p.progressPercent,
          lastAccessedAt: p.lastAccessedAt,
          completedLectures: p.completedLectures,
          timeSpent: p.timeSpent,
          lastWatchedLectureId: p.lastWatchedLectureId,
          lecturePositions: p.lecturePositions
        };
      })
      .filter((course: any) => ensureStudentClassAccess(user, course.classLevel));
    
    res.json(enrolledCourses);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Create course - Invalidates all course caches
router.post('/', authMiddleware, invalidateCacheOn(['courses', 'course:']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const course = new Course({
      ...req.body,
      instructor: user.id
    });
    
    await course.save();
    res.status(201).json(course);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Update course - Invalidates course and enrolled caches
router.put('/:courseId', authMiddleware, invalidateCacheOn(['courses', 'course:', 'enrolled']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const course = await Course.findByIdAndUpdate(
      req.params.courseId,
      req.body,
      { new: true }
    );
    
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }
    
    res.json(course);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Delete course - Invalidates all course caches
router.delete('/:courseId', authMiddleware, invalidateCacheOn(['courses', 'course:', 'enrolled']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const course = await Course.findByIdAndDelete(req.params.courseId);
    
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }
    
    res.json({ success: true, message: 'Course deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Module Management ============

// Add module to course
router.post('/:courseId/modules', authMiddleware, invalidateCacheOn(['course:', 'courses:']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { title, description } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'Module title is required' });
    }
    
    const course = await Course.findById(req.params.courseId);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }
    
    if (!course.syllabus) {
      course.syllabus = [];
    }
    
    course.syllabus.push({
      title,
      description,
      lectures: []
    });
    
    await course.save();
    res.status(201).json(course);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update module
router.put('/:courseId/modules/:moduleIndex', authMiddleware, invalidateCacheOn(['course:', 'courses:']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { title, description } = req.body;
    const moduleIndex = parseInt(req.params.moduleIndex);
    
    const course = await Course.findById(req.params.courseId);
    if (!course || !course.syllabus || !course.syllabus[moduleIndex]) {
      return res.status(404).json({ error: 'Module not found' });
    }
    
    if (title) course.syllabus[moduleIndex].title = title;
    if (description !== undefined) course.syllabus[moduleIndex].description = description;
    
    await course.save();
    res.json(course);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete module
router.delete('/:courseId/modules/:moduleIndex', authMiddleware, invalidateCacheOn(['course:', 'courses:']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const moduleIndex = parseInt(req.params.moduleIndex);
    
    const course = await Course.findById(req.params.courseId);
    if (!course || !course.syllabus || !course.syllabus[moduleIndex]) {
      return res.status(404).json({ error: 'Module not found' });
    }
    
    course.syllabus.splice(moduleIndex, 1);
    await course.save();
    
    res.json({ success: true, message: 'Module deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Lecture Management ============

import youtubeService from '../../services/youtubeService';

// Add lecture to module
router.post('/:courseId/modules/:moduleIndex/lectures', authMiddleware, invalidateCacheOn(['course:', 'courses:']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { title, videoUrl, youtubeVideoId } = req.body;
    const moduleIndex = parseInt(req.params.moduleIndex);
    
    if (!title) {
      return res.status(400).json({ error: 'Lecture title is required' });
    }
    
    const course = await Course.findById(req.params.courseId);
    if (!course || !course.syllabus || !course.syllabus[moduleIndex]) {
      return res.status(404).json({ error: 'Module not found' });
    }
    
    // Extract YouTube ID from URL or use provided ID
    const ytId = youtubeVideoId || youtubeService.extractYouTubeId(videoUrl || '');
    
    const lectureIndex = course.syllabus[moduleIndex].lectures.length;
    
    course.syllabus[moduleIndex].lectures.push({
      title,
      videoUrl,
      youtubeVideoId: ytId || undefined,
      order: lectureIndex,
      duration: undefined
    });
    
    await course.save();
    
    // Update lecture count
    let totalLectures = 0;
    course.syllabus.forEach(m => { totalLectures += m.lectures.length; });
    course.lectureCount = totalLectures;
    await course.save();
    
    // Enqueue YouTube meta fetch job if we have a video ID
    if (ytId) {
      youtubeService.enqueueYouTubeMetaJob(
        ytId,
        String(course._id),
        moduleIndex,
        lectureIndex
      );
    }
    
    res.status(201).json(course);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update lecture
router.put('/:courseId/modules/:moduleIndex/lectures/:lectureIndex', authMiddleware, invalidateCacheOn(['course:', 'courses:']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { title, videoUrl, youtubeVideoId } = req.body;
    const moduleIndex = parseInt(req.params.moduleIndex);
    const lectureIndex = parseInt(req.params.lectureIndex);
    
    const course = await Course.findById(req.params.courseId);
    if (!course || !course.syllabus?.[moduleIndex]?.lectures?.[lectureIndex]) {
      return res.status(404).json({ error: 'Lecture not found' });
    }
    
    const lecture = course.syllabus[moduleIndex].lectures[lectureIndex];
    const oldYtId = lecture.youtubeVideoId;
    
    if (title) lecture.title = title;
    if (videoUrl !== undefined) lecture.videoUrl = videoUrl;
    
    // Handle YouTube ID update
    const newYtId = youtubeVideoId || youtubeService.extractYouTubeId(videoUrl || '');
    if (newYtId && newYtId !== oldYtId) {
      lecture.youtubeVideoId = newYtId;
      // Re-fetch metadata for new video
      youtubeService.enqueueYouTubeMetaJob(
        newYtId,
        String(course._id),
        moduleIndex,
        lectureIndex
      );
    }
    
    await course.save();
    res.json(course);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete lecture
router.delete('/:courseId/modules/:moduleIndex/lectures/:lectureIndex', authMiddleware, invalidateCacheOn(['course:', 'courses:']), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!['admin', 'teacher'].includes(user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const moduleIndex = parseInt(req.params.moduleIndex);
    const lectureIndex = parseInt(req.params.lectureIndex);
    
    const course = await Course.findById(req.params.courseId);
    if (!course || !course.syllabus?.[moduleIndex]?.lectures?.[lectureIndex]) {
      return res.status(404).json({ error: 'Lecture not found' });
    }
    
    course.syllabus[moduleIndex].lectures.splice(lectureIndex, 1);
    
    // Re-index orders
    course.syllabus[moduleIndex].lectures.forEach((lec, idx) => {
      lec.order = idx;
    });
    
    // Update lecture count
    let totalLectures = 0;
    course.syllabus.forEach(m => { totalLectures += m.lectures.length; });
    course.lectureCount = totalLectures;
    
    await course.save();
    res.json({ success: true, message: 'Lecture deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

