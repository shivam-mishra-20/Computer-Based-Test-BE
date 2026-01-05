import { Request, Response } from 'express';
import OfflineResult from '../models/OfflineResult';

// Add a single result
export const addResult = async (req: Request, res: Response) => {
  try {
    const { class: className, name, batch, subject, marks, outOf, remarks, testDate } = req.body;

    // Validation
    if (!className || !name || !subject || marks === undefined || !outOf || !testDate) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: class, name, subject, marks, outOf, testDate' 
      });
    }

    // Validate marks
    if (marks < 0 || outOf < 1) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid marks: marks must be >= 0 and outOf must be >= 1' 
      });
    }

    // Validate date format (yyyy-mm-dd)
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(testDate)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid date format. Use yyyy-mm-dd' 
      });
    }

    const result = new OfflineResult({
      class: className,
      name,
      batch: batch || '',
      subject,
      marks: Number(marks),
      outOf: Number(outOf),
      remarks: remarks || '',
      testDate,
      createdAt: new Date()
    });

    await result.save();

    return res.status(201).json({ 
      success: true, 
      message: 'Result added successfully', 
      data: result 
    });
  } catch (error) {
    console.error('Error adding result:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to add result', 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
};

// Add bulk results
export const addBulkResults = async (req: Request, res: Response) => {
  try {
    const { class: className, batch, subject, testDate, results } = req.body;

    // Validation
    if (!className || !subject || !testDate || !results || !Array.isArray(results)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: class, subject, testDate, results (array)' 
      });
    }

    // Validate date format
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(testDate)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid date format. Use yyyy-mm-dd' 
      });
    }

    // Filter valid results
    const validResults = results.filter((r: any) => 
      r.name && r.marks !== undefined && r.outOf && Number(r.marks) >= 0 && Number(r.outOf) >= 1
    );

    if (validResults.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No valid results to add' 
      });
    }

    // Create documents
    const documents = validResults.map((r: any) => ({
      class: className,
      name: r.name,
      batch: batch || '',
      subject,
      marks: Number(r.marks),
      outOf: Number(r.outOf),
      remarks: r.remarks || '',
      testDate,
      createdAt: new Date()
    }));

    const savedResults = await OfflineResult.insertMany(documents);

    return res.status(201).json({ 
      success: true, 
      message: `${savedResults.length} results added successfully`, 
      data: savedResults 
    });
  } catch (error) {
    console.error('Error adding bulk results:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to add bulk results', 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
};

// Get results for a specific student
export const getStudentResults = async (req: Request, res: Response) => {
  try {
    const { name, class: className } = req.query;

    if (!name || !className) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required query parameters: name, class' 
      });
    }

    const results = await OfflineResult.find({ 
      name: name as string, 
      class: className as string 
    }).sort({ createdAt: -1 }); // Latest first

    return res.status(200).json({ 
      success: true, 
      data: results,
      count: results.length 
    });
  } catch (error) {
    console.error('Error fetching student results:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch results', 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
};

// Get all results with filters (for teachers/admin)
export const getAllResults = async (req: Request, res: Response) => {
  try {
    const { class: className, name, batch, subject, startDate, endDate, limit = 100 } = req.query;

    const filter: any = {};
    
    if (className) filter.class = className;
    if (name) filter.name = name;
    if (batch) filter.batch = batch;
    if (subject) filter.subject = subject;
    
    // Date range filter
    if (startDate || endDate) {
      filter.testDate = {};
      if (startDate) filter.testDate.$gte = startDate;
      if (endDate) filter.testDate.$lte = endDate;
    }

    const results = await OfflineResult.find(filter)
      .sort({ createdAt: -1 })
      .limit(Number(limit));

    return res.status(200).json({ 
      success: true, 
      data: results,
      count: results.length 
    });
  } catch (error) {
    console.error('Error fetching all results:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch results', 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
};

// Update a result
export const updateResult = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    // Remove fields that shouldn't be updated via this endpoint
    delete updateData._id;
    delete updateData.__v;
    delete updateData.createdAt;

    // Add updatedAt timestamp
    updateData.updatedAt = new Date();

    // Validate marks if provided
    if (updateData.marks !== undefined && updateData.marks < 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Marks must be >= 0' 
      });
    }

    if (updateData.outOf !== undefined && updateData.outOf < 1) {
      return res.status(400).json({ 
        success: false, 
        message: 'OutOf must be >= 1' 
      });
    }

    // Validate date format if provided
    if (updateData.testDate) {
      const datePattern = /^\d{4}-\d{2}-\d{2}$/;
      if (!datePattern.test(updateData.testDate)) {
        return res.status(400).json({ 
          success: false, 
          message: 'Invalid date format. Use yyyy-mm-dd' 
        });
      }
    }

    const result = await OfflineResult.findByIdAndUpdate(
      id, 
      updateData, 
      { new: true, runValidators: true }
    );

    if (!result) {
      return res.status(404).json({ 
        success: false, 
        message: 'Result not found' 
      });
    }

    return res.status(200).json({ 
      success: true, 
      message: 'Result updated successfully', 
      data: result 
    });
  } catch (error) {
    console.error('Error updating result:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to update result', 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
};

// Delete a result
export const deleteResult = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await OfflineResult.findByIdAndDelete(id);

    if (!result) {
      return res.status(404).json({ 
        success: false, 
        message: 'Result not found' 
      });
    }

    return res.status(200).json({ 
      success: true, 
      message: 'Result deleted successfully',
      data: result 
    });
  } catch (error) {
    console.error('Error deleting result:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to delete result', 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
};

// Get statistics (optional - useful for dashboard)
export const getResultStats = async (req: Request, res: Response) => {
  try {
    const { class: className, batch, subject } = req.query;

    const filter: any = {};
    if (className) filter.class = className;
    if (batch) filter.batch = batch;
    if (subject) filter.subject = subject;

    const stats = await OfflineResult.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalResults: { $sum: 1 },
          averageMarks: { $avg: '$marks' },
          averagePercentage: { 
            $avg: { 
              $multiply: [{ $divide: ['$marks', '$outOf'] }, 100] 
            } 
          },
          highestMarks: { $max: '$marks' },
          lowestMarks: { $min: '$marks' }
        }
      }
    ]);

    return res.status(200).json({ 
      success: true, 
      data: stats[0] || { 
        totalResults: 0, 
        averageMarks: 0, 
        averagePercentage: 0,
        highestMarks: 0,
        lowestMarks: 0 
      } 
    });
  } catch (error) {
    console.error('Error fetching result stats:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch statistics', 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
};
