import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Doubt from './src/models/Doubt';
import User from './src/models/User';

dotenv.config();

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/cbt_exam');
        console.log('MongoDB Connected');
    } catch (err) {
        console.error('Connection error:', err);
        process.exit(1);
    }
};

const checkDoubtsTeacher = async () => {
    await connectDB();
    
    console.log('Checking all doubts for teacher field...\n');

    const doubts = await Doubt.find({})
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();
    
    console.log(`Found ${doubts.length} doubts\n`);

    for (const doubt of doubts) {
        console.log(`=== Doubt ${doubt._id} ===`);
        console.log(`  Teacher field: ${doubt.teacher ? doubt.teacher : 'NULL/UNDEFINED'}`);
        console.log(`  Status: ${doubt.status}`);
        console.log(`  Messages: ${doubt.messages?.length || 0}`);
        
        // Check if teacher exists in DB
        if (doubt.teacher) {
            const teacher = await User.findById(doubt.teacher).lean();
            console.log(`  Teacher in DB: ${teacher ? teacher.name : 'NOT FOUND (deleted?)'}`);
        }
        
        // Check messages for teacher/admin senders
        const teacherMessages = doubt.messages?.filter(
            (m: any) => m.senderRole === 'teacher' || m.senderRole === 'admin'
        ) || [];
        console.log(`  Teacher/Admin messages: ${teacherMessages.length}`);
        
        for (const msg of teacherMessages) {
            const sender = await User.findById(msg.sender).lean();
            console.log(`    - Sender ${msg.sender}: ${sender ? sender.name : 'NOT FOUND'}`);
        }
        
        console.log('');
    }
    
    process.exit(0);
};

checkDoubtsTeacher();
