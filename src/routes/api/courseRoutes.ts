import { Router, Request, Response } from 'express';
import Course from '../../models/Course';
import CourseProgress from '../../models/CourseProgress';
import { authMiddleware } from '../../middlewares/authMiddleware';

const router = Router();

// Get all published courses (for students)
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { classLevel, subject, batch } = req.query;
    
    const query: any = { status: 'published' };
    
    // Filter by class level
    if (classLevel) {
      query.classLevel = classLevel;
    } else if (user.classLevel) {
      query.classLevel = user.classLevel;
    }
    
    if (subject) query.subject = subject;
    if (batch) query.batch = batch;
    
    const courses = await Course.find(query)
      .populate('instructor', 'name')
      .select('-syllabus.lectures.videoUrl')
      .sort({ createdAt: -1 })
      .lean();
    
    // Add enrollment status for current user
    const coursesWithStatus = await Promise.all(courses.map(async (course) => {
      const isEnrolled = course.enrolledStudents?.some(
        (id: any) => id.toString() === user.id
      );
      
      const progress = await CourseProgress.findOne({
        studentId: user.id,
        courseId: course._id
      }).lean();
      
      return {
        ...course,
        isEnrolled,
        progressPercent: progress?.progressPercent || 0,
        enrolledStudents: undefined // Remove from response
      };
    }));
    
    res.json(coursesWithStatus);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get course details
router.get('/:courseId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const course = await Course.findById(req.params.courseId)
      .populate('instructor', 'name email')
      .lean();
    
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }
    
    const isEnrolled = course.enrolledStudents?.some(
      (id: any) => id.toString() === user.id
    );
    
    const progress = await CourseProgress.findOne({
      studentId: user.id,
      courseId: course._id
    }).lean();
    
    // If not enrolled or free, hide video URLs
    const courseFinal = {
      ...course,
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

// Enroll in a course
router.post('/:courseId/enroll', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const course = await Course.findById(req.params.courseId);
    
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }
    
    if (course.enrolledStudents?.includes(user.id)) {
      return res.status(400).json({ error: 'Already enrolled' });
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

// Update lecture progress
router.post('/:courseId/progress', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { lectureId, timeSpent } = req.body;
    
    const course = await Course.findById(req.params.courseId);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
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

// Get video position for a lecture
router.get('/:courseId/lectures/:lectureId/position', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { courseId, lectureId } = req.params;
    
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

// Get enrolled courses with progress
router.get('/my/enrolled', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    
    const progress = await CourseProgress.find({ studentId: user.id })
      .populate({
        path: 'courseId',
        select: 'title subject classLevel thumbnail lectureCount duration syllabus'
      })
      .sort({ lastAccessedAt: -1 })
      .lean();
    
    const enrolledCourses = progress
      .filter(p => p.courseId)
      .map(p => ({
        ...(p.courseId as any),
        progressPercent: p.progressPercent,
        lastAccessedAt: p.lastAccessedAt,
        completedLectures: p.completedLectures,
        timeSpent: p.timeSpent,
        lastWatchedLectureId: p.lastWatchedLectureId,
        lecturePositions: p.lecturePositions
      }));
    
    res.json(enrolledCourses);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Create course
router.post('/', authMiddleware, async (req: Request, res: Response) => {
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

// Admin: Update course
router.put('/:courseId', authMiddleware, async (req: Request, res: Response) => {
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

// Admin: Delete course
router.delete('/:courseId', authMiddleware, async (req: Request, res: Response) => {
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
router.post('/:courseId/modules', authMiddleware, async (req: Request, res: Response) => {
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
router.put('/:courseId/modules/:moduleIndex', authMiddleware, async (req: Request, res: Response) => {
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
router.delete('/:courseId/modules/:moduleIndex', authMiddleware, async (req: Request, res: Response) => {
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
router.post('/:courseId/modules/:moduleIndex/lectures', authMiddleware, async (req: Request, res: Response) => {
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
router.put('/:courseId/modules/:moduleIndex/lectures/:lectureIndex', authMiddleware, async (req: Request, res: Response) => {
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
router.delete('/:courseId/modules/:moduleIndex/lectures/:lectureIndex', authMiddleware, async (req: Request, res: Response) => {
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

