/**
 * Firebase Sync Controller
 * Handles admin requests to sync Firebase data with MongoDB
 */

import { Request, Response } from 'express';
import {
  syncAllFirebaseData,
  syncFirebaseStudentsToMongoDB,
  syncFirebaseTeachersToMongoDB,
  syncFirebaseBatchesToMongoDB,
  getSyncStats,
  fetchFirebaseUsers,
  fetchFirebaseBatches,
  fetchFirebaseClasses
} from '../services/firebaseSyncService';

/**
 * GET /api/admin/firebase/stats
 * Get Firebase vs MongoDB sync statistics
 */
export const getFirebaseSyncStats = async (_req: Request, res: Response) => {
  try {
    const stats = await getSyncStats();
    res.json(stats);
  } catch (error: any) {
    console.error('Error getting sync stats:', error);
    res.status(500).json({ message: 'Failed to get sync stats', error: error.message });
  }
};

/**
 * GET /api/admin/firebase/users
 * Fetch all users from Firebase (without syncing to MongoDB)
 */
export const getFirebaseUsers = async (req: Request, res: Response) => {
  try {
    const { role, classLevel, batch } = req.query;
    
    const users = await fetchFirebaseUsers(
      role as string,
      classLevel as string,
      batch as string
    );
    
    res.json({ users, count: users.length });
  } catch (error: any) {
    console.error('Error fetching Firebase users:', error);
    res.status(500).json({ message: 'Failed to fetch Firebase users', error: error.message });
  }
};

/**
 * GET /api/admin/firebase/batches
 * Fetch all batches from Firebase
 */
export const getFirebaseBatches = async (_req: Request, res: Response) => {
  try {
    const batches = await fetchFirebaseBatches();
    res.json({ batches, count: batches.length });
  } catch (error: any) {
    console.error('Error fetching Firebase batches:', error);
    res.status(500).json({ message: 'Failed to fetch Firebase batches', error: error.message });
  }
};

/**
 * GET /api/admin/firebase/classes
 * Fetch all class levels from Firebase
 */
export const getFirebaseClasses = async (_req: Request, res: Response) => {
  try {
    const classes = await fetchFirebaseClasses();
    res.json({ classes, count: classes.length });
  } catch (error: any) {
    console.error('Error fetching Firebase classes:', error);
    res.status(500).json({ message: 'Failed to fetch Firebase classes', error: error.message });
  }
};

/**
 * POST /api/admin/firebase/sync/students
 * Sync Firebase students to MongoDB
 */
export const syncStudents = async (req: Request, res: Response) => {
  try {
    const { classLevel, batch, dryRun } = req.body;
    
    const result = await syncFirebaseStudentsToMongoDB({
      classLevel,
      batch,
      dryRun: dryRun === true
    });
    
    res.json(result);
  } catch (error: any) {
    console.error('Error syncing students:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to sync students', 
      error: error.message 
    });
  }
};

/**
 * POST /api/admin/firebase/sync/teachers
 * Sync Firebase teachers to MongoDB
 */
export const syncTeachers = async (req: Request, res: Response) => {
  try {
    const { dryRun } = req.body;
    
    const result = await syncFirebaseTeachersToMongoDB({
      dryRun: dryRun === true
    });
    
    res.json(result);
  } catch (error: any) {
    console.error('Error syncing teachers:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to sync teachers', 
      error: error.message 
    });
  }
};

/**
 * POST /api/admin/firebase/sync/batches
 * Sync Firebase batches to MongoDB
 */
export const syncBatches = async (_req: Request, res: Response) => {
  try {
    const result = await syncFirebaseBatchesToMongoDB();
    res.json(result);
  } catch (error: any) {
    console.error('Error syncing batches:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to sync batches', 
      error: error.message 
    });
  }
};

/**
 * POST /api/admin/firebase/sync/all
 * Sync all Firebase data (students, teachers, batches) to MongoDB
 */
export const syncAllData = async (req: Request, res: Response) => {
  try {
    const { classLevel, batch, dryRun } = req.body;
    
    const results = await syncAllFirebaseData({
      classLevel,
      batch,
      dryRun: dryRun === true
    });
    
    const overallSuccess = results.students.success && results.teachers.success && results.batches.success;
    
    res.json({
      success: overallSuccess,
      message: overallSuccess ? 'All data synced successfully' : 'Sync completed with some errors',
      results
    });
  } catch (error: any) {
    console.error('Error syncing all data:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to sync all data', 
      error: error.message 
    });
  }
};
