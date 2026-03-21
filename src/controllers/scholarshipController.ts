import { Request, Response } from 'express';
import {
  createScholarshipAttempt,
  getScholarshipAttempt,
  saveScholarshipAnswer,
  submitScholarshipTest,
  gradeScholarshipAttempt,
  getScholarshipResults,
  publishScholarshipResults,
  createScholarshipTest,
  getActiveScholarshipTests,
  getScholarshipTestById,
  deleteScholarshipTest,
  getTestShareLink,
  getScholarshipTestPreview,
  getScholarshipAttemptReview,
  updateScholarshipAttemptReview,
} from '../services/scholarshipService';

export async function createAttemptCtrl(req: Request, res: Response) {
  try {
    const { name, phone, classLevel, testId } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }

    const parsedClassLevel =
      classLevel !== undefined && classLevel !== null && String(classLevel).trim() !== ''
        ? parseInt(String(classLevel), 10)
        : undefined;

    // If no testId is provided, classLevel must be explicitly selected.
    if (!testId && !parsedClassLevel) {
      return res.status(400).json({ error: 'classLevel is required' });
    }

    if (parsedClassLevel && (parsedClassLevel < 7 || parsedClassLevel > 12)) {
      return res.status(400).json({ error: 'ClassLevel must be between 7 and 12' });
    }

    const attempt = await createScholarshipAttempt(name, phone, parsedClassLevel, testId);
    const statusCode = (attempt as any)?.created ? 201 : 200;
    res.status(statusCode).json(attempt);
  } catch (err: any) {
    const message = err?.message || 'Failed to create attempt';
    // Most failures here are user/input/test-selection issues, not server crashes.
    if (
      /required|valid phone|classlevel|eligible|not available|no valid subjects/i.test(message)
    ) {
      return res.status(400).json({ error: message });
    }
    res.status(500).json({ error: message });
  }
}

export async function getAttemptCtrl(req: Request, res: Response) {
  try {
    const { attemptId } = req.params;
    const accessKey =
      (req.header('x-scholarship-attempt-key') || req.header('x-attempt-key') || '').trim();
    const attempt = await getScholarshipAttempt(attemptId, accessKey);
    res.json(attempt);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to fetch attempt' });
  }
}

export async function saveAnswerCtrl(req: Request, res: Response) {
  try {
    const { attemptId } = req.params;
    const { questionId, answer } = req.body;

    if (!questionId || answer === undefined || answer === null) {
      return res.status(400).json({ error: 'questionId and answer are required' });
    }

    const accessKey =
      (req.header('x-scholarship-attempt-key') || req.header('x-attempt-key') || '').trim();

    const result = await saveScholarshipAnswer(attemptId, questionId, answer, accessKey);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to save answer' });
  }
}

export async function submitTestCtrl(req: Request, res: Response) {
  try {
    const { attemptId } = req.params;
    const { answers } = req.body;

    const accessKey =
      (req.header('x-scholarship-attempt-key') || req.header('x-attempt-key') || '').trim();

    const result = await submitScholarshipTest(attemptId, answers || [], accessKey);
    
    // Auto-grade the test
    await gradeScholarshipAttempt(attemptId);

    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to submit test' });
  }
}

export async function getResultsCtrl(req: Request, res: Response) {
  try {
    const filters = {
      classLevel: req.query.classLevel ? parseInt(String(req.query.classLevel)) : undefined,
      publishedOnly: req.query.publishedOnly === 'true',
      submittedOnly:
        req.query.submittedOnly !== undefined
          ? req.query.submittedOnly === 'true'
          : true,
      testId: req.query.testId ? String(req.query.testId) : undefined,
    };

    const results = await getScholarshipResults(filters);
    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch results' });
  }
}

// Test Management Controllers
export async function createTestCtrl(req: Request, res: Response) {
  try {
    const testData = req.body;

    if (!testData.testName || !testData.eligibleClasses || !testData.subjects) {
      return res.status(400).json({ error: 'Test name, eligible classes, and subjects are required' });
    }

    const test = await createScholarshipTest(testData);
    res.status(201).json(test);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create test' });
  }
}

export async function getTestsCtrl(req: Request, res: Response) {
  try {
    const tests = await getActiveScholarshipTests();
    res.json(tests);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch tests' });
  }
}

export async function getTestCtrl(req: Request, res: Response) {
  try {
    const { testId } = req.params;
    const test = await getScholarshipTestById(testId);

    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }

    res.json(test);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch test' });
  }
}

export async function deleteTestCtrl(req: Request, res: Response) {
  try {
    const { testId } = req.params;
    await deleteScholarshipTest(testId);
    res.json({ message: 'Test deleted successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to delete test' });
  }
}

export async function getShareLinkCtrl(req: Request, res: Response) {
  try {
    const { testId } = req.params;
    const link = await getTestShareLink(testId);
    res.json(link);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to generate share link' });
  }
}

export async function getTestPreviewCtrl(req: Request, res: Response) {
  try {
    const { testId } = req.params;
    const classLevel = req.query.classLevel
      ? parseInt(String(req.query.classLevel), 10)
      : undefined;

    const preview = await getScholarshipTestPreview(testId, classLevel);
    res.json(preview);
  } catch (err: any) {
    const message = err?.message || 'Failed to load test preview';
    if (
      /Not enough Scholarship-board questions|Invalid class for preview|Test not found/i.test(
        message
      )
    ) {
      return res.status(400).json({ error: message });
    }
    res.status(500).json({ error: message });
  }
}

export async function publishResultsCtrl(req: Request, res: Response) {
  try {
    // Check if user is admin
    const userRole = (req as any).user?.role;
    if (userRole !== 'admin') {
      return res.status(403).json({ error: 'Only admins can publish results' });
    }

    const { classLevel, testId, batch, batchAssignedBy } = req.body || {};
    const result = await publishScholarshipResults({
      classLevel,
      testId,
      batch,
      batchAssignedBy: batchAssignedBy || (req as any).user?.email || 'admin',
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to publish results' });
  }
}

export async function getAttemptReviewCtrl(req: Request, res: Response) {
  try {
    const userRole = (req as any).user?.role;
    if (userRole !== 'admin') {
      return res.status(403).json({ error: 'Only admins can view attempt review details' });
    }

    const { attemptId } = req.params;
    const data = await getScholarshipAttemptReview(attemptId);
    res.json(data);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to fetch attempt review details' });
  }
}

export async function updateAttemptReviewCtrl(req: Request, res: Response) {
  try {
    const userRole = (req as any).user?.role;
    if (userRole !== 'admin') {
      return res.status(403).json({ error: 'Only admins can update attempt review details' });
    }

    const { attemptId } = req.params;
    const payload = req.body || {};
    const reviewedBy = (req as any).user?.name || (req as any).user?.email || 'admin';
    const result = await updateScholarshipAttemptReview(attemptId, payload, reviewedBy);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to update attempt review details' });
  }
}

export async function updateAttemptBatchCtrl(req: Request, res: Response) {
  try {
    const userRole = (req as any).user?.role;
    if (userRole !== 'admin') {
      return res.status(403).json({ error: 'Only admins can update attempt batch' });
    }

    const { attemptId } = req.params;
    const { batch } = req.body || {};
    
    if (!batch || batch.trim() === '') {
      return res.status(400).json({ error: 'Batch name is required' });
    }

    const result = await ScholarshipAttempt.findOneAndUpdate(
      { attemptId },
      {
        batch: batch.trim(),
        batchAssignedAt: new Date(),
        batchAssignedBy: (req as any).user?.email || 'admin',
      },
      { new: true }
    );

    if (!result) {
      return res.status(404).json({ error: 'Attempt not found' });
    }

    res.json({
      success: true,
      message: `Batch "${batch.trim()}" assigned successfully`,
      batch: result.batch,
      batchAssignedAt: result.batchAssignedAt,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to update attempt batch' });
  }
}
