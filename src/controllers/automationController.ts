import { Request, Response } from 'express';
import { saveBatchValidatedQuestions, EnhancedQuestionData } from '../services/questionValidationService';
import { Types, Model } from 'mongoose';
import mongoose from 'mongoose';
import AutomationStatusModel, { IAutomationStatus } from '../models/AutomationStatus';
import { ChildProcess } from 'child_process';

// Track the current running process
let currentProcess: ChildProcess | null = null;

// Processing Stats Schema
interface IProcessingStats {
  fileName: string;
  filePath: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  startTime?: Date;
  endTime?: Date;
  totalQuestions: number;
  questionsWithDiagrams: number;
  questionsWithCorrectAnswers: number;
  questionsWithOptions: number;
  questionsImported: number;
  errors: string[];
  bookMetadata?: {
    title: string;
    author: string;
    subject: string;
    class: string;
    board: string;
  };
}

// MongoDB Schemas (ProcessingStats only - AutomationStatus imported from model)
const processingStatsSchema = new mongoose.Schema<IProcessingStats>({
  fileName: { type: String, required: true },
  filePath: { type: String, required: true },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  startTime: { type: Date },
  endTime: { type: Date },
  totalQuestions: { type: Number, default: 0 },
  questionsWithDiagrams: { type: Number, default: 0 },
  questionsWithCorrectAnswers: { type: Number, default: 0 },
  questionsWithOptions: { type: Number, default: 0 },
  questionsImported: { type: Number, default: 0 },
  errors: [{ type: String }],
  bookMetadata: {
    title: String,
    author: String,
    subject: String,
    class: String,
    board: String
  }
}, { timestamps: true });

// Properly type the model to avoid union type issues
const ProcessingStats: Model<IProcessingStats> = (mongoose.models.ProcessingStats as Model<IProcessingStats>) || 
  mongoose.model<IProcessingStats>('ProcessingStats', processingStatsSchema);

// Use the imported AutomationStatus model with proper typing
const AutomationStatus: Model<IAutomationStatus> = AutomationStatusModel;

/**
 * Bulk Import Questions (called by n8n or manual trigger)
 */
export const bulkImportQuestions = async (req: Request, res: Response) => {
  try {
    const { questions, userId, fileName, targetCollection } = req.body;
    
    if (!questions || !Array.isArray(questions)) {
      return res.status(400).json({ message: 'Questions array is required' });
    }

    console.log(`[Bulk Import] Importing ${questions.length} questions from ${fileName || 'unknown source'}`);

    // Determine the class to use - prioritize targetCollection (class_12 → "Class 12")
    const targetClass = targetCollection 
      ? targetCollection.replace('class_', 'Class ') 
      : undefined;

    // Convert to EnhancedQuestionData format
    const enhancedQuestions: EnhancedQuestionData[] = questions.map(q => ({
      text: q.text,
      type: q.type,
      options: q.options,
      correctAnswerText: q.correctAnswerText,
      integerAnswer: q.integerAnswer,
      assertion: q.assertion,
      reason: q.reason,
      diagramUrl: q.diagramUrl,
      diagramAlt: q.diagramAlt,
      
      // Flat structure - all at root level
      subject: q.subject,
      topic: q.topic,
      chapter: q.chapter,
      board: q.board,
      class: targetClass || q.class, // Use targetCollection class if provided
      section: q.section,
      difficulty: q.difficulty || 'medium',
      marks: q.marks || 1,
      explanation: q.explanation,
      
      createdBy: new Types.ObjectId(userId || (req as any).user?.id),
      source: 'Smart Import',
      isActive: true
    }));

    // Save using existing validation service
    const savedQuestions = await saveBatchValidatedQuestions(enhancedQuestions);

    console.log(`[Bulk Import] Successfully imported ${savedQuestions.length}/${questions.length} questions`);

    res.status(201).json({
      success: true,
      count: savedQuestions.length,
      totalAttempted: questions.length,
      questionIds: savedQuestions.map(q => q._id)
    });

  } catch (error) {
    console.error('[Bulk Import] Error:', error);
    res.status(500).json({ 
      success: false,
      message: error instanceof Error ? error.message : 'Import failed' 
    });
  }
};

/**
 * Get Automation Status
 */
export const getAutomationStatus = async (req: Request, res: Response) => {
  try {
    let status = await AutomationStatus.findOne();
    
    if (!status) {
      status = await AutomationStatus.create({
        isEnabled: true,
        currentlyRunning: false,
        totalRuns: 0,
        successfulRuns: 0,
        failedRuns: 0
      });
    }

    res.json({ success: true, status });
  } catch (error) {
    console.error('[Automation Status] Error:', error);
    res.status(500).json({ 
      success: false,
      message: error instanceof Error ? error.message : 'Failed to get status' 
    });
  }
};

/**
 * Toggle Automation On/Off
 */
export const toggleAutomation = async (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    
    let status = await AutomationStatus.findOne();
    
    if (!status) {
      status = await AutomationStatus.create({
        isEnabled: enabled,
        currentlyRunning: false,
        totalRuns: 0,
        successfulRuns: 0,
        failedRuns: 0
      });
    } else {
      status.isEnabled = enabled;
      await status.save();
    }

    console.log(`[Automation] Automation ${enabled ? 'ENABLED' : 'DISABLED'}`);

    res.json({ 
      success: true, 
      message: `Automation ${enabled ? 'enabled' : 'disabled'}`,
      status 
    });
  } catch (error) {
    console.error('[Automation Toggle] Error:', error);
    res.status(500).json({ 
      success: false,
      message: error instanceof Error ? error.message : 'Failed to toggle automation' 
    });
  }
};

/**
 * Get Processing Statistics
 */
export const getProcessingStats = async (req: Request, res: Response) => {
  try {
    const { limit = 20, status, fileName } = req.query;
    
    const query: any = {};
    if (status) query.status = status;
    if (fileName) query.fileName = new RegExp(fileName as string, 'i');
    
    const stats = await ProcessingStats.find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit));
    
    // Aggregate statistics
    const totalStats = await ProcessingStats.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalBooks: { $sum: 1 },
          totalQuestions: { $sum: '$totalQuestions' },
          totalImported: { $sum: '$questionsImported' },
          withDiagrams: { $sum: '$questionsWithDiagrams' },
          withCorrectAnswers: { $sum: '$questionsWithCorrectAnswers' },
          withOptions: { $sum: '$questionsWithOptions' },
          completed: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          },
          failed: {
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
          }
        }
      }
    ]);

    res.json({ 
      success: true, 
      stats,
      summary: totalStats[0] || {
        totalBooks: 0,
        totalQuestions: 0,
        totalImported: 0,
        withDiagrams: 0,
        withCorrectAnswers: 0,
        withOptions: 0,
        completed: 0,
        failed: 0
      }
    });
  } catch (error) {
    console.error('[Processing Stats] Error:', error);
    res.status(500).json({ 
      success: false,
      message: error instanceof Error ? error.message : 'Failed to get stats' 
    });
  }
};

/**
 * Get Detailed Book Processing Info
 */
export const getBookProcessingDetails = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const stats = await ProcessingStats.findById(id);
    
    if (!stats) {
      return res.status(404).json({ 
        success: false,
        message: 'Processing record not found' 
      });
    }

    res.json({ success: true, details: stats });
  } catch (error) {
    console.error('[Book Details] Error:', error);
    res.status(500).json({ 
      success: false,
      message: error instanceof Error ? error.message : 'Failed to get details' 
    });
  }
};

/**
 * Create Processing Record (called at start of extraction)
 */
export const createProcessingRecord = async (req: Request, res: Response) => {
  try {
    const { fileName, filePath, bookMetadata } = req.body;
    
    const record = await ProcessingStats.create({
      fileName,
      filePath,
      status: 'processing',
      startTime: new Date(),
      bookMetadata,
      totalQuestions: 0,
      questionsImported: 0,
      questionsWithDiagrams: 0,
      questionsWithCorrectAnswers: 0,
      questionsWithOptions: 0,
      errors: []
    });

    res.status(201).json({ success: true, recordId: record._id });
  } catch (error) {
    console.error('[Create Record] Error:', error);
    res.status(500).json({ 
      success: false,
      message: error instanceof Error ? error.message : 'Failed to create record' 
    });
  }
};

/**
 * Update Processing Record (called after extraction)
 */
export const updateProcessingRecord = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { 
      status, 
      totalQuestions, 
      questionsImported,
      questionsWithDiagrams,
      questionsWithCorrectAnswers,
      questionsWithOptions,
      errors 
    } = req.body;
    
    const record = await ProcessingStats.findById(id);
    
    if (!record) {
      return res.status(404).json({ 
        success: false,
        message: 'Processing record not found' 
      });
    }

    if (status) record.status = status;
    if (totalQuestions !== undefined) record.totalQuestions = totalQuestions;
    if (questionsImported !== undefined) record.questionsImported = questionsImported;
    if (questionsWithDiagrams !== undefined) record.questionsWithDiagrams = questionsWithDiagrams;
    if (questionsWithCorrectAnswers !== undefined) record.questionsWithCorrectAnswers = questionsWithCorrectAnswers;
    if (questionsWithOptions !== undefined) record.questionsWithOptions = questionsWithOptions;
    if (errors) record.errors.push(...errors);
    
    if (status === 'completed' || status === 'failed') {
      record.endTime = new Date();
    }

    await record.save();

    // Update automation status
    if (status === 'completed' || status === 'failed') {
      const automationStatus = await AutomationStatus.findOne();
      if (automationStatus) {
        automationStatus.currentlyRunning = false;
        automationStatus.lastRun = new Date();
        automationStatus.totalRuns += 1;
        if (status === 'completed') {
          automationStatus.successfulRuns += 1;
        } else {
          automationStatus.failedRuns += 1;
        }
        await automationStatus.save();
      }
    }

    res.json({ success: true, record });
  } catch (error) {
    console.error('[Update Record] Error:', error);
    res.status(500).json({ 
      success: false,
      message: error instanceof Error ? error.message : 'Failed to update record' 
    });
  }
};

/**
 * Manual Trigger - Start Processing Immediately
 */
export const triggerProcessing = async (req: Request, res: Response) => {
  try {
    const { folder = 'class_12', selectedFiles } = req.body;

    const normalizedSelectedFiles = Array.isArray(selectedFiles)
      ? Array.from(
          new Set(
            selectedFiles
              .filter((file: unknown): file is string => typeof file === 'string' && file.trim().length > 0)
              .map((file: string) => file.trim())
          )
        )
      : [];
    
    // Extract token from request
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    const automationStatus = await AutomationStatus.findOne();
    
    if (!automationStatus?.isEnabled) {
      return res.status(400).json({ 
        success: false,
        message: 'Automation is disabled. Enable it first.' 
      });
    }

    if (automationStatus.currentlyRunning) {
      return res.status(400).json({ 
        success: false,
        message: 'Processing is already running. Please wait for it to complete.' 
      });
    }

    // Verify folder exists
    const fs = require('fs');
    const path = require('path');
    const folderPath = path.join(process.cwd(), folder);
    
    if (!fs.existsSync(folderPath)) {
      return res.status(404).json({ 
        success: false,
        message: `Folder '${folder}' not found in project directory` 
      });
    }

    const folderEntries = fs.readdirSync(folderPath);
    const availableBookFiles = folderEntries.filter((fileName: string) => /\.(epub|pdf)$/i.test(fileName));

    if (normalizedSelectedFiles.length > 0) {
      const invalidFileNames = normalizedSelectedFiles.filter(
        (fileName: string) =>
          !availableBookFiles.includes(fileName) ||
          /[/\\]/.test(fileName)
      );

      if (invalidFileNames.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid file selection: ${invalidFileNames.join(', ')}`,
        });
      }
    }

    // Update status to running
    automationStatus.currentlyRunning = true;
    await automationStatus.save();

    // Trigger the processing script
    const { spawn } = require('child_process');
    const scriptPath = path.join(process.cwd(), 'scripts', 'automation-runner.js');
    
    console.log(`[Manual Trigger] Starting processing for folder: ${folder}`);
    console.log(`[Manual Trigger] Folder path: ${folderPath}`);
    console.log(`[Manual Trigger] Script path: ${scriptPath}`);
    if (normalizedSelectedFiles.length > 0) {
      console.log(`[Manual Trigger] Selected files (${normalizedSelectedFiles.length}): ${normalizedSelectedFiles.join(', ')}`);
    }

    // Spawn the automation runner script
    const child = spawn('node', [scriptPath], {
      env: {
        ...process.env,
        TARGET_FOLDER: folder,
        SELECTED_FILES: JSON.stringify(normalizedSelectedFiles),
        EPUB_BASE_PATH: process.cwd(),
        BACKEND_API_KEY: token, // Pass the admin token
        BACKEND_API_URL: process.env.BACKEND_URL || 'http://localhost:5000',
        // Resolve to absolute path so child processes can locate the key file regardless of cwd
        GOOGLE_APPLICATION_CREDENTIALS: path.resolve(
          process.env.GOOGLE_APPLICATION_CREDENTIALS || './vision-key.json'
        ),
      },
      detached: false,
      stdio: 'inherit' // Show logs in terminal
    });

    // Track the current process globally
    currentProcess = child;

    child.on('error', (error: Error) => {
      console.error(`[Manual Trigger] Failed to start script:`, error);
      currentProcess = null;
    });

    child.on('exit', async (code: number | null) => {
      console.log(`[Manual Trigger] Script exited with code ${code}`);
      // Reset running status
      const status = await AutomationStatus.findOne();
      if (status) {
        status.currentlyRunning = false;
        await status.save();
      }
      currentProcess = null;
    });

    res.json({ 
      success: true, 
      message: 'Processing started',
      folder,
      selectedFiles: normalizedSelectedFiles,
      scriptPath 
    });

    // Note: Actual processing should be done asynchronously
    // You can use a job queue (Bull, BullMQ) or spawn a child process
    
  } catch (error) {
    console.error('[Manual Trigger] Error:', error);
    res.status(500).json({ 
      success: false,
      message: error instanceof Error ? error.message : 'Failed to trigger processing' 
    });
  }
};

/**
 * Reset Automation Status - Fix stuck "running" state
 */
export const resetAutomationStatus = async (req: Request, res: Response) => {
  try {
    const automationStatus = await AutomationStatus.findOne();
    
    if (automationStatus) {
      automationStatus.currentlyRunning = false;
      await automationStatus.save();
    }

    // Clear current process reference
    currentProcess = null;

    res.json({ 
      success: true, 
      message: 'Automation status reset successfully' 
    });
  } catch (error) {
    console.error('[Reset Status] Error:', error);
    res.status(500).json({ 
      success: false,
      message: error instanceof Error ? error.message : 'Failed to reset status' 
    });
  }
};

/**
 * Stop Running Automation - Kill the current process
 */
export const stopAutomation = async (req: Request, res: Response) => {
  try {
    const automationStatus = await AutomationStatus.findOne();
    
    if (!automationStatus?.currentlyRunning) {
      return res.status(400).json({ 
        success: false,
        message: 'No automation is currently running' 
      });
    }

    if (currentProcess) {
      console.log('[Stop Automation] Killing current process...');
      currentProcess.kill('SIGTERM');
      
      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (currentProcess && !currentProcess.killed) {
          console.log('[Stop Automation] Force killing process...');
          currentProcess.kill('SIGKILL');
        }
      }, 5000);
      
      // Reset status
      automationStatus.currentlyRunning = false;
      await automationStatus.save();
      currentProcess = null;

      res.json({ 
        success: true, 
        message: 'Automation stopped successfully' 
      });
    } else {
      // No process found but status says running - fix inconsistency
      automationStatus.currentlyRunning = false;
      await automationStatus.save();
      
      res.json({ 
        success: true, 
        message: 'Automation status reset' 
      });
    }
  } catch (error) {
    console.error('[Stop Automation] Error:', error);
    res.status(500).json({ 
      success: false,
      message: error instanceof Error ? error.message : 'Failed to stop automation' 
    });
  }
};

/**
 * Get available class folders for processing
 */
export const getAvailableFolders = async (req: Request, res: Response) => {
  try {
    const fs = require('fs');
    const path = require('path');
    
    const rootDir = process.cwd();
    const folders: Array<{
      name: string;
      path: string;
      fileCount: number;
      files: Array<{ name: string; path: string; size: number; type: 'epub' | 'pdf' }>;
    }> = [];
    
    // Check for class folders
    const classFolderPattern = /^class_\d+$/;
    const allItems = fs.readdirSync(rootDir);
    
    for (const item of allItems) {
      if (classFolderPattern.test(item)) {
        const folderPath = path.join(rootDir, item);
        const stats = fs.statSync(folderPath);
        
        if (stats.isDirectory()) {
          // Count EPUB and PDF files
          const files = fs.readdirSync(folderPath);
          const bookFiles = files
            .filter((f: string) => /\.(epub|pdf)$/i.test(f))
            .sort((a: string, b: string) => a.localeCompare(b))
            .map((f: string) => {
              const absoluteFilePath = path.join(folderPath, f);
              const fileStats = fs.statSync(absoluteFilePath);

              return {
                name: f,
                path: absoluteFilePath,
                size: fileStats.size,
                type: f.toLowerCase().endsWith('.epub') ? 'epub' as const : 'pdf' as const,
              };
            });
          
          folders.push({
            name: item,
            path: folderPath,
            fileCount: bookFiles.length,
            files: bookFiles,
          });
        }
      }
    }
    
    res.json({
      success: true,
      folders
    });
  } catch (error) {
    console.error('[Get Folders] Error:', error);
    res.status(500).json({ 
      success: false,
      message: error instanceof Error ? error.message : 'Failed to get folders' 
    });
  }
};

// Schedule management removed as it's manual only now

export { AutomationStatus, ProcessingStats };
