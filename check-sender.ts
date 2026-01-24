
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

const checkIntegrity = async () => {
    await connectDB();
    
    // ID from logs: 6973164b784d2bfb5d7a8e8c
    const doubtId = '6973164b784d2bfb5d7a8e8c'; 
    console.log(`Checking Doubt ID: ${doubtId}`);

    const doubt = await Doubt.findById(doubtId).lean();
    
    if (!doubt) {
        console.log('Doubt not found');
        return;
    }

    console.log('Messages:', doubt.messages.length);
    
    for (const [i, msg] of doubt.messages.entries()) {
        console.log(`Msg ${i}: Sender ID: ${msg.sender} Role: ${msg.senderRole}`);
        if (msg.sender) {
            const user = await User.findById(msg.sender);
            console.log(`   -> User found: ${!!user} ${user ? user.name : 'NULL'}`);
        } else {
             console.log(`   -> Sender is null/undefined`);
        }
    }
    
    process.exit(0);
};

checkIntegrity();
