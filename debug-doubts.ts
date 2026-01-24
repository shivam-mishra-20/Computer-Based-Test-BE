
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Doubt from './src/models/Doubt';

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

const debugDoubts = async () => {
    await connectDB();
    
    console.log('--- Fetching All Doubts ---');
    const doubts = await Doubt.find({})
        .select('student teacher status batch question createdAt')
        .lean();

    console.log(`Found ${doubts.length} doubts`);
    
    doubts.forEach(d => {
        console.log(`ID: ${d._id}`);
        console.log(`  Student: ${d.student}`);
        console.log(`  Teacher: ${d.teacher} (${typeof d.teacher})`);
        console.log(`  Status: ${d.status}`);
        console.log(`  Question: ${d.question?.substring(0, 50)}...`);
        console.log('-----------------------------------');
    });

    process.exit(0);
};

debugDoubts();
