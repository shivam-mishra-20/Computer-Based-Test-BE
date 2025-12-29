import { Router, Request, Response } from 'express';
import Lecture, { ILecture } from '../../models/Lecture';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { IUser } from '../../models/User';

interface AuthRequest extends Request {
  user?: IUser & { _id: any };
}

const router = Router();

// GET - Fetch lectures (filtered by teacher, subject, class)
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { subject, classLevel, chapter, status, instructorId, page = 1, limit = 20 } = req.query;

    const filter: any = {};

    // Teachers can only see their own lectures
    if (req.user?.role === 'teacher') {
      filter.instructor = req.user._id;
    } else if (instructorId) {
      filter.instructor = instructorId;
    }

    if (subject) filter.subject = subject;
    if (classLevel) filter.classLevel = classLevel;
    if (chapter) filter.chapter = chapter;
    if (status) filter.status = status;

    const skip = (Number(page) - 1) * Number(limit);

    const [lectures, total] = await Promise.all([
      Lecture.find(filter)
        .populate('instructor', 'name email')
        .sort({ classLevel: 1, subject: 1, chapter: 1, order: 1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Lecture.countDocuments(filter)
    ]);

    // Get unique subjects and chapters for filters
    const filterOptions = await Lecture.aggregate([
      { $match: req.user?.role === 'teacher' ? { instructor: req.user._id } : {} },
      {
        $group: {
          _id: null,
          subjects: { $addToSet: '$subject' },
          classLevels: { $addToSet: '$classLevel' },
          chapters: { $addToSet: '$chapter' }
        }
      }
    ]);

    return res.json({
      lectures,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / Number(limit)),
      filters: filterOptions[0] || { subjects: [], classLevels: [], chapters: [] }
    });
  } catch (error) {
    console.error('Error fetching lectures:', error);
    return res.status(500).json({ error: 'Failed to fetch lectures' });
  }
});

// GET - Hierarchical content structure (Class → Subject → Chapter → Lectures)
router.get('/hierarchy', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const filter: any = {};
    
    if (req.user?.role === 'teacher') {
      filter.instructor = req.user._id;
    }

    const hierarchy = await Lecture.aggregate([
      { $match: filter },
      {
        $group: {
          _id: { classLevel: '$classLevel', subject: '$subject', chapter: '$chapter' },
          lectures: {
            $push: {
              _id: '$_id',
              title: '$title',
              youtubeVideoId: '$youtubeVideoId',
              duration: '$duration',
              status: '$status',
              order: '$order',
              topic: '$topic'
            }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.classLevel': 1, '_id.subject': 1, '_id.chapter': 1 } },
      {
        $group: {
          _id: { classLevel: '$_id.classLevel', subject: '$_id.subject' },
          chapters: {
            $push: {
              chapter: '$_id.chapter',
              lectures: '$lectures',
              count: '$count'
            }
          },
          totalLectures: { $sum: '$count' }
        }
      },
      {
        $group: {
          _id: '$_id.classLevel',
          subjects: {
            $push: {
              subject: '$_id.subject',
              chapters: '$chapters',
              totalLectures: '$totalLectures'
            }
          },
          grandTotal: { $sum: '$totalLectures' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    return res.json(hierarchy);
  } catch (error) {
    console.error('Error fetching hierarchy:', error);
    return res.status(500).json({ error: 'Failed to fetch content hierarchy' });
  }
});

// GET - Single lecture
router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const lecture = await Lecture.findById(req.params.id)
      .populate('instructor', 'name email');

    if (!lecture) {
      return res.status(404).json({ error: 'Lecture not found' });
    }

    return res.json(lecture);
  } catch (error) {
    console.error('Error fetching lecture:', error);
    return res.status(500).json({ error: 'Failed to fetch lecture' });
  }
});

// POST - Create lecture (teacher/admin)
router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.role !== 'teacher' && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only teachers can create lectures' });
    }

    const { title, description, youtubeVideoId, duration, subject, classLevel, chapter, topic, tags, status } = req.body;

    if (!title || !youtubeVideoId || !subject || !classLevel) {
      return res.status(400).json({ error: 'Title, YouTube Video ID, subject, and class level are required' });
    }

    // Get the next order number for this chapter
    const lastLecture = await Lecture.findOne({ 
      instructor: req.user._id, 
      classLevel, 
      subject, 
      chapter 
    }).sort({ order: -1 });

    const lecture = new Lecture({
      title,
      description,
      youtubeVideoId,
      duration,
      subject,
      classLevel,
      chapter,
      topic,
      tags: tags || [],
      instructor: req.user._id,
      status: status || 'draft',
      order: lastLecture ? lastLecture.order + 1 : 0
    });

    await lecture.save();

    const populated = await Lecture.findById(lecture._id)
      .populate('instructor', 'name email');

    return res.status(201).json(populated);
  } catch (error) {
    console.error('Error creating lecture:', error);
    return res.status(500).json({ error: 'Failed to create lecture' });
  }
});

// PUT - Update lecture
router.put('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const lecture = await Lecture.findById(req.params.id);

    if (!lecture) {
      return res.status(404).json({ error: 'Lecture not found' });
    }

    // Only owner or admin can update
    if (req.user?.role !== 'admin' && lecture.instructor.toString() !== req.user?._id?.toString()) {
      return res.status(403).json({ error: 'You can only edit your own lectures' });
    }

    const { title, description, youtubeVideoId, duration, subject, classLevel, chapter, topic, tags, status } = req.body;

    const updated = await Lecture.findByIdAndUpdate(
      req.params.id,
      { title, description, youtubeVideoId, duration, subject, classLevel, chapter, topic, tags, status },
      { new: true }
    ).populate('instructor', 'name email');

    return res.json(updated);
  } catch (error) {
    console.error('Error updating lecture:', error);
    return res.status(500).json({ error: 'Failed to update lecture' });
  }
});

// PUT - Reorder lectures
router.put('/reorder/batch', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { lectureOrders } = req.body; // Array of { id, order }

    if (!Array.isArray(lectureOrders)) {
      return res.status(400).json({ error: 'lectureOrders must be an array' });
    }

    const updates = lectureOrders.map(({ id, order }) => 
      Lecture.findByIdAndUpdate(id, { order })
    );

    await Promise.all(updates);

    return res.json({ message: 'Lectures reordered successfully' });
  } catch (error) {
    console.error('Error reordering lectures:', error);
    return res.status(500).json({ error: 'Failed to reorder lectures' });
  }
});

// DELETE - Delete lecture
router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const lecture = await Lecture.findById(req.params.id);

    if (!lecture) {
      return res.status(404).json({ error: 'Lecture not found' });
    }

    // Only owner or admin can delete
    if (req.user?.role !== 'admin' && lecture.instructor.toString() !== req.user?._id?.toString()) {
      return res.status(403).json({ error: 'You can only delete your own lectures' });
    }

    await Lecture.findByIdAndDelete(req.params.id);

    return res.json({ message: 'Lecture deleted successfully' });
  } catch (error) {
    console.error('Error deleting lecture:', error);
    return res.status(500).json({ error: 'Failed to delete lecture' });
  }
});

export default router;
