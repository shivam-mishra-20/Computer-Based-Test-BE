import { Router, Request, Response } from 'express';
import Attempt from '../../models/Attempt';
import User from '../../models/User';
import { authMiddleware } from '../../middlewares/authMiddleware';

const router = Router();

// Get leaderboard
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { classLevel, batch, limit = 50 } = req.query;
    
    // Build match stage
    const matchStage: any = {
      status: { $in: ['submitted', 'auto-submitted', 'graded'] }
    };
    
    // Get students by class/batch
    const studentQuery: any = { role: 'student', status: 'approved' };
    if (classLevel) studentQuery.classLevel = classLevel;
    else if (user.classLevel) studentQuery.classLevel = user.classLevel;
    if (batch) studentQuery.batch = batch;
    
    const students = await User.find(studentQuery).select('_id name classLevel batch').lean();
    const studentIds = students.map(s => s._id);
    const studentMap = new Map(students.map(s => [s._id.toString(), s]));
    
    matchStage.userId = { $in: studentIds };
    
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
    
    // Combine with user info
    const result = leaderboard.map((entry: any, index: number) => {
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
    
    // Find current user's rank
    const myRank = result.find(r => r.userId.toString() === user.id);
    let myRankData = null;
    
    if (!myRank && user.role === 'student') {
      // Calculate user's stats even if not in top N
      const myStats = await Attempt.aggregate([
        { $match: { userId: user.id, ...matchStage } },
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
        }
      ]);
      
      if (myStats.length > 0) {
        // Count students with higher average
        const higherCount = await Attempt.aggregate([
          { $match: matchStage },
          {
            $group: {
              _id: '$userId',
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
          { $match: { avgPercentage: { $gt: myStats[0].avgPercentage } } },
          { $count: 'count' }
        ]);
        
        myRankData = {
          rank: (higherCount[0]?.count || 0) + 1,
          userId: user.id,
          name: user.name,
          classLevel: user.classLevel,
          batch: user.batch,
          totalScore: myStats[0].totalScore,
          maxPossibleScore: myStats[0].maxPossibleScore,
          examsTaken: myStats[0].examsTaken,
          avgPercentage: Math.round(myStats[0].avgPercentage || 0)
        };
      }
    }
    
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
