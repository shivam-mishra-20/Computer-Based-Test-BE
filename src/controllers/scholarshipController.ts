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
} from '../services/scholarshipService';

export async function createAttemptCtrl(req: Request, res: Response) {
  try {
    const { name, phone, classLevel, testId } = req.body;

    if (!name || !phone || !classLevel) {
      return res.status(400).json({ error: 'Name, phone, and classLevel are required' });
    }

    if (classLevel < 7 || classLevel > 12) {
      return res.status(400).json({ error: 'ClassLevel must be between 7 and 12' });
    }

    const attempt = await createScholarshipAttempt(name, phone, classLevel, testId);
    res.status(201).json(attempt);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create attempt' });
  }
}

export async function getAttemptCtrl(req: Request, res: Response) {
  try {
    const { attemptId } = req.params;
    const attempt = await getScholarshipAttempt(attemptId);
    res.json(attempt);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to fetch attempt' });
  }
}

export async function saveAnswerCtrl(req: Request, res: Response) {
  try {
    const { attemptId } = req.params;
    const { questionId, answer } = req.body;

    if (!questionId || !answer) {
      return res.status(400).json({ error: 'questionId and answer are required' });
    }

    const result = await saveScholarshipAnswer(attemptId, questionId, answer);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to save answer' });
  }
}

export async function submitTestCtrl(req: Request, res: Response) {
  try {
    const { attemptId } = req.params;
    const { answers } = req.body;

    const result = await submitScholarshipTest(attemptId, answers || []);
    
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

    const { classLevel } = req.body;
    const result = await publishScholarshipResults(classLevel);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to publish results' });
  }
}
