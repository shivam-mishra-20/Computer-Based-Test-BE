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
        lectures: section.lectures.map(lecture => ({
          ...lecture,
          videoUrl: (isEnrolled || course.isFree) ? lecture.videoUrl : undefined
        }))
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

export default router;
