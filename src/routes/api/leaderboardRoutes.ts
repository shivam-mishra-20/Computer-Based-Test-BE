import { Router, Request, Response } from 'express';
import Attempt from '../../models/Attempt';
import User from '../../models/User';
import { authMiddleware } from '../../middlewares/authMiddleware';

const router = Router();

// Get leaderboard
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { classLevel, batch, limit = 50, mode = 'online' } = req.query;
    
    // Get students by class/batch
    const studentQuery: any = { role: 'student', status: 'approved' };
    if (classLevel) studentQuery.classLevel = classLevel;
    else if (user.classLevel) studentQuery.classLevel = user.classLevel;
    if (batch) studentQuery.batch = batch;
    
    // Fetch users first
    const students = await User.find(studentQuery).select('_id name email classLevel batch').lean();
    const studentIds = students.map(s => s._id);
    const studentMap = new Map(students.map(s => [s._id.toString(), s]));
    
    let result: any[] = [];
    let matchStage: any = {
      status: { $in: ['submitted', 'auto-submitted', 'graded'] },
      userId: { $in: studentIds }
    };

    if (mode === 'online') {
      // Aggregate attempts by user
      const leaderboard = await Attempt.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: '$userId',
            totalScore: { $sum: '$totalScore' },
            maxPossibleScore: { $sum: '$maxScore' },
            examsTaken: { $sum: 1 },
            avgPercentage: {
              $avg: {
                $cond: [
                  { $gt: ['$maxScore', 0] },
                  { $multiply: [{ $divide: ['$totalScore', '$maxScore'] }, 100] },
                  0
                ]
              }
            }
          }
        },
        { $sort: { avgPercentage: -1, examsTaken: -1 } },
        { $limit: Number(limit) }
      ]);
      
      result = leaderboard.map((entry: any, index: number) => {
        const student = studentMap.get(entry._id.toString());
        return {
          rank: index + 1,
          userId: entry._id,
          name: student?.name || 'Unknown',
          classLevel: student?.classLevel,
          batch: student?.batch,
          totalScore: entry.totalScore,
          maxPossibleScore: entry.maxPossibleScore,
          examsTaken: entry.examsTaken,
          avgPercentage: Math.round(entry.avgPercentage || 0)
        };
      });

    } else {
      // Offline implementation
      // Since structure is Name-based, we have to iterate students and find their results
      // This is less efficient but necessary given schemas
      const OfflineResult = require('../../models/OfflineResult').default;
      
      const leaderboardData = [];
      
      for (const student of students) {
        const emailUsername = student.email ? student.email.split('@')[0] : '';
        const nameRegex = new RegExp(`^${student.name.trim()}$`, 'i');
        const usernameRegex = new RegExp(`^${emailUsername}$`, 'i');

        const query: any = {
          class: student.classLevel,
          $or: [
            { name: nameRegex },
            { name: usernameRegex },
            { name: /^student$/i }
          ]
        };
        // Optional: match batch if data quality is good
         // if (student.batch) query.batch = student.batch;

        const results = await OfflineResult.find(query).lean();
        
        if (results.length > 0) {
          let totalScore = 0;
          let maxPossibleScore = 0;
          let percentageSum = 0;
          
          results.forEach((r: any) => {
             totalScore += r.marks;
             maxPossibleScore += r.outOf;
             percentageSum += r.outOf > 0 ? (r.marks / r.outOf) * 100 : 0;
          });
          
          const avgPercentage = percentageSum / results.length;
          
          leaderboardData.push({
            userId: student._id,
            name: student.name,
            classLevel: student.classLevel,
            batch: student.batch,
            totalScore,
            maxPossibleScore,
            examsTaken: results.length,
            avgPercentage: Math.round(avgPercentage),
            rawAvg: avgPercentage
          });
        }
      }
      
      // Sort in-memory
      leaderboardData.sort((a, b) => {
        if (b.avgPercentage !== a.avgPercentage) return b.avgPercentage - a.avgPercentage;
        return b.examsTaken - a.examsTaken;
      });
      
      // Slice
      result = leaderboardData.slice(0, Number(limit)).map((entry, index) => ({
        ...entry,
        rank: index + 1
      }));
    }
    
    // Find current user's rank
    const myRank = result.find(r => r.userId.toString() === user.id);
    let myRankData = null;
    
    // Fallback if not in top N (implement basic version for Offline if needed, skipping for brevity/complexity)
    
    res.json({
      leaderboard: result,
      myRank: myRank || myRankData,
      totalParticipants: studentIds.length
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
