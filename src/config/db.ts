import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/User';

dotenv.config();

export const connectDB = async (): Promise<void> => {
  try {
    const uri = process.env.MONGO_URI;
    if (!uri) {
      throw new Error('MONGO_URI is not defined in environment variables');
    }
    await mongoose.connect(uri);
    console.log('✅ MongoDB Connected');

    // Seed default admin if not exists
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@cbt.local';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123';
    const adminName = process.env.ADMIN_NAME || 'System Admin';
    const existingAdmin = await User.findOne({ email: adminEmail, role: 'admin' });
    if (!existingAdmin) {
      await User.create({ name: adminName, email: adminEmail, password: adminPassword, role: 'admin' });
      console.log(`👤 Default admin seeded: ${adminEmail}`);
    }
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    // Do not terminate the process here; let the caller handle the failure
    throw error;
  }
};
