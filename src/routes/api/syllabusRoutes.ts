import { Router, Request, Response } from 'express';
import Syllabus from '../../models/Syllabus';
import User from '../../models/User';
import { authMiddleware } from '../../middlewares/authMiddleware';

const router = Router();

// Get all syllabi (Teachers: their own, Students: their class/batch)
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { classLevel, subject, batch, academicYear } = req.query;

    let query: any = { isActive: true };

    if (user.role === 'teacher') {
      // Teachers see only their syllabi
      query.$or = [
        { teacherId: user.id },
        { teacherId: user._id?.toString() },
        { teacherId: user.firebaseUid }
      ];
    } else if (user.role === 'student') {
      // Students see syllabi for their class
      const student = await User.findById(user.id);
      if (student && student.classLevel) {
        // Construct class variants for flexible matching
        const rawClass = student.classLevel.toString();
        // Normalize: remove "Class", "class", and suffixes like "th", "st", "nd", "rd"
        const normalizedClass = rawClass.replace(/class\s*/i, '').replace(/(?:st|nd|rd|th)$/i, '').trim();
        const classVariants = [
          rawClass,
          normalizedClass,
          `Class ${normalizedClass}`,
          `class ${normalizedClass}`
        ];
        
        // Remove duplicates and empty strings
        const uniqueClasses = [...new Set(classVariants)].filter(c => c);
        
        query.classLevel = { $in: uniqueClasses };

        if (student.batch) {
          query.$or = [
            { batch: student.batch },
            { batch: { $exists: false } },
            { batch: null },
            { batch: "" }
          ];
        }
      }
    }

    // Apply filters
    if (classLevel) query.classLevel = classLevel;
    if (subject) query.subject = subject;
    if (batch) query.batch = batch;
    if (academicYear) query.academicYear = academicYear;

    const syllabi = await Syllabus.find(query)
      .sort({ createdAt: -1 });

    res.json(syllabi);
  } catch (error: any) {
    console.error('Error fetching syllabi:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get metadata (subjects, classes, batches)
router.get('/metadata', authMiddleware, async (req: Request, res: Response) => {
  try {
    // parallel fetch
    const [
      distinctSubjects,
      distinctClasses,
      distinctBatches
    ] = await Promise.all([
      Syllabus.distinct('subject'),
      User.distinct('classLevel', { role: 'student' }),
      User.distinct('batch', { role: 'student' })
    ]);
    
    // Add default subjects if list is empty or small
    const defaultSubjects = [
      "Mathematics", "Physics", "Chemistry", "Biology", 
      "English", "Hindi", "Computer Science", "Economics", 
      "Business Studies", "Accountancy", "History", 
      "Geography", "Political Science", "Sociology"
    ];
    
    const subjects = [...new Set([...defaultSubjects, ...distinctSubjects])].sort();
    
    // Clean and sort classes
    const classes = distinctClasses
      .filter((c: any) => c)
      .map((c: any) => c.toString().replace(/class\s*/i, '').trim())
      .filter((c: string) => c)
      .sort((a: string, b: string) => {
        const numA = parseInt(a);
        const numB = parseInt(b);
        if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
        return a.localeCompare(b);
      });
      
    // Clean and sort batches
    const batches = distinctBatches
      .filter((b: any) => b)
      .sort();
      
    res.json({
      subjects,
      classes: classes.length > 0 ? classes : ['11', '12'],
      batches: batches.length > 0 ? batches : ['A', 'B', 'C']
    });
  } catch (error: any) {
    console.error('Error fetching metadata:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get a specific syllabus by ID
router.get('/:syllabusId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const syllabus = await Syllabus.findById(req.params.syllabusId);

    if (!syllabus) {
      return res.status(404).json({ error: 'Syllabus not found' });
    }

    res.json(syllabus);
  } catch (error: any) {
    console.error('Error fetching syllabus:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create a new syllabus
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    if (user.role !== 'teacher') {
      return res.status(403).json({ error: 'Only teachers can create syllabi' });
    }

    // Fetch teacher details
    const teacher = await User.findById(user.id);
    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    const { subject, classLevel, batch, academicYear, items, chapters } = req.body;

    // Validate required fields
    if (!subject || !classLevel || !academicYear) {
      return res.status(400).json({ error: 'Subject, class level, and academic year are required' });
    }

    // Check if syllabus already exists
    const existing = await Syllabus.findOne({
      teacherId: teacher.firebaseUid || teacher._id?.toString(),
      subject,
      classLevel,
      batch: batch || null,
      academicYear,
      isActive: true
    });

    if (existing) {
      return res.status(400).json({ 
        error: 'A syllabus for this subject, class, and academic year already exists',
        existingId: existing._id
      });
    }

    const syllabus = new Syllabus({
      teacherId: teacher.firebaseUid || teacher._id?.toString(),
      teacherName: teacher.name,
      subject,
      classLevel,
      batch: batch || null,
      academicYear,
      chapters: chapters || [], // New structure
      items: items || [] // Legacy support
    });

    await syllabus.save();

    // Fetch the saved syllabus to ensure all calculated fields are included
    const savedSyllabus = await Syllabus.findById(syllabus._id);

    res.status(201).json(savedSyllabus);
  } catch (error: any) {
    console.error('Error creating syllabus:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update syllabus
router.put('/:syllabusId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    if (user.role !== 'teacher') {
      return res.status(403).json({ error: 'Only teachers can update syllabi' });
    }

    const syllabus = await Syllabus.findById(req.params.syllabusId);

    if (!syllabus) {
      return res.status(404).json({ error: 'Syllabus not found' });
    }

    // Check ownership
    const isOwner = 
      syllabus.teacherId === user.id ||
      syllabus.teacherId === user._id?.toString() ||
      syllabus.teacherId === user.firebaseUid;

    if (!isOwner) {
      return res.status(403).json({ error: 'Not authorized to update this syllabus' });
    }

    const { subject, classLevel, batch, academicYear, items, chapters } = req.body;

    if (subject) syllabus.subject = subject;
    if (classLevel) syllabus.classLevel = classLevel;
    if (batch !== undefined) syllabus.batch = batch;
    if (academicYear) syllabus.academicYear = academicYear;
    if (items) syllabus.items = items; // Legacy support
    if (chapters) syllabus.chapters = chapters; // New structure

    await syllabus.save();

    // Fetch the updated syllabus to ensure all calculated fields are included
    const updatedSyllabus = await Syllabus.findById(syllabus._id);

    res.json(updatedSyllabus);
  } catch (error: any) {
    console.error('Error updating syllabus:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark topic as completed/incomplete
router.patch('/:syllabusId/topics/:topicId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    if (user.role !== 'teacher') {
      return res.status(403).json({ error: 'Only teachers can update topic status' });
    }

    const syllabus = await Syllabus.findById(req.params.syllabusId);

    if (!syllabus) {
      return res.status(404).json({ error: 'Syllabus not found' });
    }

    // Check ownership
    const isOwner = 
      syllabus.teacherId === user.id ||
      syllabus.teacherId === user._id?.toString() ||
      syllabus.teacherId === user.firebaseUid;

    if (!isOwner) {
      return res.status(403).json({ error: 'Not authorized to update this syllabus' });
    }

    // Support both legacy items and new chapters structure
    let topic: any = null;
    
    if (syllabus.items && syllabus.items.length > 0) {
      topic = syllabus.items.find((item: any) => item._id?.toString() === req.params.topicId);
    } else if (syllabus.chapters && syllabus.chapters.length > 0) {
      // Search in chapters
      for (const chapter of syllabus.chapters) {
        if (chapter.topics) {
          topic = chapter.topics.find((t: any) => t._id?.toString() === req.params.topicId);
          if (topic) break;
        }
      }
    }

    if (!topic) {
      return res.status(404).json({ error: 'Topic not found' });
    }

    const { completed } = req.body;

    topic.completed = completed;
    if (completed) {
      topic.completedDate = new Date();
    } else {
      topic.completedDate = undefined;
    }

    await syllabus.save();

    res.json(syllabus);
  } catch (error: any) {
    console.error('Error updating topic:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete syllabus (soft delete)
router.delete('/:syllabusId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    if (user.role !== 'teacher') {
      return res.status(403).json({ error: 'Only teachers can delete syllabi' });
    }

    const syllabus = await Syllabus.findById(req.params.syllabusId);

    if (!syllabus) {
      return res.status(404).json({ error: 'Syllabus not found' });
    }

    // Check ownership
    const isOwner = 
      syllabus.teacherId === user.id ||
      syllabus.teacherId === user._id?.toString() ||
      syllabus.teacherId === user.firebaseUid;

    if (!isOwner) {
      return res.status(403).json({ error: 'Not authorized to delete this syllabus' });
    }

    syllabus.isActive = false;
    await syllabus.save();

    res.json({ success: true, message: 'Syllabus deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting syllabus:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
