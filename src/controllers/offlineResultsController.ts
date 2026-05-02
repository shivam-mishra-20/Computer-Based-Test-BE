import { Request, Response } from 'express';
import TestResult, { ITestResult, IStudentResult } from '../models/TestResult';
import User from '../models/User';

// Create a new test
export const createTest = async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    const { testName, testDate, class: className, batch, subject, maxMarks, studentResults } = req.body;

    if (!testName || !testDate || !className || !subject || !maxMarks) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const newTest = new TestResult({
      testName,
      testDate,
      class: className,
      batch,
      subject,
      maxMarks,
      studentResults: studentResults || [],
      createdBy: authUser.id,
    });

    await newTest.save();
    console.log(`[TestResults] Created test: ${testName} for ${className}`);

    res.status(201).json(newTest);
  } catch (error: any) {
    console.error('[TestResults] Create error:', error);
    res.status(500).json({ message: 'Failed to create test', error: error.message });
  }
};

// Get all tests (with optional filters)
export const getAllTests = async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    const { class: className, batch, subject } = req.query;

    const query: any = {};
    if (authUser?.role === 'teacher') query.createdBy = authUser.id;
    if (className) query.class = className;
    if (batch) query.batch = batch;
    if (subject) query.subject = subject;

    const tests = await TestResult.find(query)
      .sort({ testDate: -1, createdAt: -1 })
      .lean();

    res.json(tests);
  } catch (error: any) {
    console.error('[TestResults] Get all error:', error);
    res.status(500).json({ message: 'Failed to fetch tests', error: error.message });
  }
};

// Get a specific test by ID
export const getTestById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const test = await TestResult.findById(id).lean();

    if (!test) {
      return res.status(404).json({ message: 'Test not found' });
    }

    res.json(test);
  } catch (error: any) {
    console.error('[TestResults] Get by ID error:', error);
    res.status(500).json({ message: 'Failed to fetch test', error: error.message });
  }
};

// Update test results (marks for students)
export const updateTestResults = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { studentResults } = req.body;

    if (!studentResults || !Array.isArray(studentResults)) {
      return res.status(400).json({ message: 'Invalid student results data' });
    }

    const test = await TestResult.findById(id);
    if (!test) {
      return res.status(404).json({ message: 'Test not found' });
    }

    test.studentResults = studentResults;
    await test.save();

    console.log(`[TestResults] Updated results for test: ${test.testName}`);
    res.json(test);
  } catch (error: any) {
    console.error('[TestResults] Update results error:', error);
    res.status(500).json({ message: 'Failed to update results', error: error.message });
  }
};

// Update test properties (name, date, maxMarks, class, subject)
export const updateTestProperties = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { testName, testDate, class: className, batch, subject, maxMarks } = req.body;

    if (!testName || !testDate || !className || !subject || !maxMarks) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const test = await TestResult.findById(id);
    if (!test) {
      return res.status(404).json({ message: 'Test not found' });
    }

    // If maxMarks changed, we should recalculate percentages for existing students
    const maxMarksChanged = test.maxMarks !== maxMarks;

    test.testName = testName;
    test.testDate = testDate;
    test.class = className;
    test.batch = batch;
    test.subject = subject;
    test.maxMarks = maxMarks;

    if (maxMarksChanged && test.studentResults && test.studentResults.length > 0) {
      test.studentResults = test.studentResults.map((result) => {
        const percentage = Math.round((result.marksObtained / maxMarks) * 100);
        let grade = 'F';
        if (percentage >= 90) grade = 'A+';
        else if (percentage >= 80) grade = 'A';
        else if (percentage >= 70) grade = 'B+';
        else if (percentage >= 60) grade = 'B';
        else if (percentage >= 50) grade = 'C';
        else if (percentage >= 40) grade = 'D';

        return {
          ...result,
          percentage,
          grade
        };
      });
    }

    await test.save();

    console.log(`[TestResults] Updated properties for test: ${test.testName}`);
    res.json(test);
  } catch (error: any) {
    console.error('[TestResults] Update properties error:', error);
    res.status(500).json({ message: 'Failed to update test properties', error: error.message });
  }
};

// Delete a test
export const deleteTest = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const test = await TestResult.findByIdAndDelete(id);

    if (!test) {
      return res.status(404).json({ message: 'Test not found' });
    }

    console.log(`[TestResults] Deleted test: ${test.testName}`);
    res.json({ message: 'Test deleted successfully' });
  } catch (error: any) {
    console.error('[TestResults] Delete error:', error);
    res.status(500).json({ message: 'Failed to delete test', error: error.message });
  }
};

// Get results for a specific student
export const getStudentResults = async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;
    const { studentId } = req.params;

    // Verify the request is for the authenticated user (students can only see their own results)
    // Teachers and admins can see any student's results
    if (authUser.role === 'student' && authUser.id !== studentId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const user = await User.findById(studentId);
    if (!user) {
      return res.status(404).json({ message: 'Student not found' });
    }

    // Find all tests for the student's class
    const tests = await TestResult.find({
      class: user.classLevel,
      $or: [{ batch: user.batch }, { batch: null }, { batch: '' }],
    })
      .sort({ testDate: -1 })
      .lean();

    // Extract only this student's results from each test
    const studentResults = tests.map((test: any) => {
      const studentResult = test.studentResults.find(
        (r: IStudentResult) => r.studentId === studentId || r.studentName === user.name
      );

      return {
        testId: test._id,
        testName: test.testName,
        testDate: test.testDate,
        subject: test.subject,
        maxMarks: test.maxMarks,
        ...studentResult,
      };
    }).filter((r: any) => r.studentId || r.studentName); // Only include tests where student has results

    res.json(studentResults);
  } catch (error: any) {
    console.error('[TestResults] Get student results error:', error);
    res.status(500).json({ message: 'Failed to fetch student results', error: error.message });
  }
};

// Get leaderboard for a class
export const getLeaderboard = async (req: Request, res: Response) => {
  try {
    const { classLevel } = req.params;
    const { subject, limit } = req.query;

    const query: any = { class: classLevel };
    if (subject) query.subject = subject;

    const tests = await TestResult.find(query)
      .sort({ testDate: -1 })
      .lean();

    if (tests.length === 0) {
      return res.json([]);
    }

    // Aggregate student performance across all tests
    const studentPerformance: any = {};

    tests.forEach((test: any) => {
      test.studentResults.forEach((result: IStudentResult) => {
        const studentId = result.studentId;
        if (!studentPerformance[studentId]) {
          studentPerformance[studentId] = {
            studentId,
            studentName: result.studentName,
            totalMarks: 0,
            totalMaxMarks: 0,
            testsCount: 0,
            grades: [],
          };
        }

        studentPerformance[studentId].totalMarks += result.marksObtained || 0;
        studentPerformance[studentId].totalMaxMarks += test.maxMarks;
        studentPerformance[studentId].testsCount += 1;
        studentPerformance[studentId].grades.push(result.grade);
      });
    });

    // Convert to array and calculate averages
    const leaderboard = Object.values(studentPerformance).map((student: any) => ({
      ...student,
      averagePercentage: (student.totalMarks / student.totalMaxMarks) * 100,
      averageMarks: student.totalMarks / student.testsCount,
    }));

    // Sort by average percentage (descending)
    leaderboard.sort((a: any, b: any) => b.averagePercentage - a.averagePercentage);

    // Add rank
    leaderboard.forEach((student: any, index) => {
      student.rank = index + 1;
    });

    // Apply limit if specified
    const limitNum = limit ? parseInt(limit as string) : leaderboard.length;
    res.json(leaderboard.slice(0, limitNum));
  } catch (error: any) {
    console.error('[TestResults] Get leaderboard error:', error);
    res.status(500).json({ message: 'Failed to fetch leaderboard', error: error.message });
  }
};
