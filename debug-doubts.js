"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const dotenv_1 = __importDefault(require("dotenv"));
const Doubt_1 = __importDefault(require("./src/models/Doubt"));
dotenv_1.default.config();
const connectDB = async () => {
    try {
        await mongoose_1.default.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/cbt_exam');
        console.log('MongoDB Connected');
    }
    catch (err) {
        console.error('Connection error:', err);
        process.exit(1);
    }
};
const debugDoubts = async () => {
    await connectDB();
    console.log('--- Fetching All Doubts ---');
    const doubts = await Doubt_1.default.find({})
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
//# sourceMappingURL=debug-doubts.js.map