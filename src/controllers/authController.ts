import { Request, Response } from 'express';
import User from '../models/User';
import jwt from 'jsonwebtoken';
import { AuthPayload } from '../middlewares/authMiddleware';
import { firebaseSignInWithEmailPassword, getFirestoreUserProfile, getFirestoreUserByEmail, getFirestoreUserByEmailAny, uploadToFirebase } from '../services/firebaseService';
import bcrypt from 'bcrypt';

// Public registration endpoint for general users (with admin approval)
export const publicRegister = async (req: Request, res: Response) => {
  const { name, email, password, phone, classLevel, board, targetExams } = req.body;
  const lcEmail = typeof email === 'string' ? email.toLowerCase() : email;
  
  try {
    // Validate required fields
    if (!name || !email || !password || !classLevel || !board || !targetExams || targetExams.length === 0) {
      return res.status(400).json({ message: 'Name, email, password, class, board, and at least one target exam are required' });
    }

    // Check if user already exists
    const existing = await User.findOne({ email: lcEmail });
    if (existing) {
      if (existing.status === 'pending') {
        return res.status(400).json({ message: 'Registration pending admin approval' });
      }
      return res.status(400).json({ message: 'User already exists' });
    }

    // Create user with pending status
    const user = new User({ 
      name, 
      email: lcEmail, 
      password, 
      phone,
      classLevel,
      board,
      targetExams,
      role: 'student',
      status: 'pending',
      authProvider: 'local'
    });
    await user.save();

    res.status(201).json({ 
      message: 'Registration successful! Your account is pending admin approval. You will be able to login once approved.',
      userId: user._id 
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ message: 'Server error during registration' });
  }
};

// Public teacher registration endpoint (with admin approval)
export const publicTeacherRegister = async (req: Request, res: Response) => {
  const { name, email, password, phone } = req.body;
  const lcEmail = typeof email === 'string' ? email.toLowerCase() : email;
  
  try {
    // Validate required fields
    if (!name || !email || !password || !phone) {
      return res.status(400).json({ message: 'Name, email, password, and phone are required' });
    }

    // Check if user already exists
    const existing = await User.findOne({ email: lcEmail });
    if (existing) {
      if (existing.status === 'pending') {
        return res.status(400).json({ message: 'Registration pending admin approval' });
      }
      return res.status(400).json({ message: 'User already exists' });
    }

    // Create teacher with pending status
    const user = new User({ 
      name, 
      email: lcEmail, 
      password, 
      phone,
      role: 'teacher',
      status: 'pending',
      authProvider: 'local'
    });
    await user.save();

    res.status(201).json({ 
      message: 'Teacher registration successful! Your account is pending admin approval. You will be able to login once approved.',
      userId: user._id 
    });
  } catch (err) {
    console.error('Teacher registration error:', err);
    res.status(500).json({ message: 'Server error during registration' });
  }
};

export const register = async (req: Request, res: Response) => {
  // By default, public self-registration is disabled.
  if (process.env.ALLOW_PUBLIC_REGISTER !== 'true') {
    return res.status(405).json({
      message: 'Public registration is disabled. Ask an administrator to create your account.',
    });
  }

  const { name, email, password } = req.body;
  const lcEmail = typeof email === 'string' ? email.toLowerCase() : email;
  try {
    const existing = await User.findOne({ email: lcEmail });
    if (existing) return res.status(400).json({ message: 'User already exists' });

  const user = new User({ name, email: lcEmail, password, role: 'student', status: 'approved' });
    await user.save();

  const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET as string, { expiresIn: '1d' });
  res.status(201).json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const lcEmail = typeof email === 'string' ? email.toLowerCase() : email;
  try {
    const user = await User.findOne({ email: lcEmail });
    
    // Check if user exists and verify password
    if (user && await user.comparePassword(password)) {
      // Check user status
      if (user.status === 'pending') {
        return res.status(403).json({ 
          message: 'Your account is pending admin approval. Please wait for approval before logging in.',
          status: 'pending'
        });
      }
      if (user.status === 'rejected') {
        return res.status(403).json({ 
          message: 'Your account registration was rejected. Please contact support.',
          status: 'rejected'
        });
      }
      
      // User is approved, generate token
      const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET as string, { expiresIn: '1d' });
      console.log(`Login debug: local auth succeeded for ${lcEmail}`);
      return res.json({ 
        token, 
        user: { 
          id: user._id, 
          name: user.name, 
          email: user.email, 
          role: user.role, 
          status: user.status,
          classLevel: (user as any).classLevel, 
          batch: (user as any).batch, 
          firebaseUid: (user as any).firebaseUid,
          profileImage: (user as any).profileImage
        } 
      });
    }
    
    if (!user || !(await user.comparePassword(password))) {
      // Fallback A: Firestore Users hashed password (like StudentLogin.jsx)
  const fsUser = await getFirestoreUserByEmailAny(lcEmail);
      if (fsUser?.password) {
        const isMatch = await bcrypt.compare(password, fsUser.password);
        if (isMatch) {
          let local = await User.findOne({ email: lcEmail });
          if (!local) {
            local = new User({
              name: fsUser.name || lcEmail.split('@')[0],
              email: lcEmail,
              password: Math.random().toString(36).slice(2),
              role: (fsUser.role as any) || 'student',
              status: 'approved',
              firebaseUid: fsUser.uid || fsUser.id,
              authProvider: 'firebase',
              classLevel: (fsUser.classLevel as any) || (fsUser as any).Class,
              batch: (fsUser.batch as any),
            } as any);
          } else {
            local.firebaseUid = fsUser.uid || fsUser.id;
            local.authProvider = 'firebase';
            if (fsUser.classLevel || (fsUser as any).Class) local.classLevel = (fsUser.classLevel as any) || (fsUser as any).Class;
            if (fsUser.batch) local.batch = (fsUser.batch as any);
            if (fsUser.name && !local.name) local.name = fsUser.name;
          }
          await local.save();
          const token = jwt.sign({ id: local._id, role: local.role }, process.env.JWT_SECRET as string, { expiresIn: '1d' });
          // Login debug: firestore bcrypt authentication succeeded
          console.log(`Login debug: firestore-bcrypt auth succeeded for ${lcEmail} (uid=${local.firebaseUid || local._id})`);
          return res.json({ token, user: { id: local._id, name: local.name, email: local.email, role: local.role, classLevel: local.classLevel, batch: local.batch, firebaseUid: local.firebaseUid } });
        }
      }
      // Fallback B: Firebase Auth REST sign-in
      const fb = await firebaseSignInWithEmailPassword(lcEmail, password);
  if (!fb) return res.status(400).json({ message: 'Invalid credentials' });
      // Upsert local user
      let local = await User.findOne({ email: lcEmail });
      if (!local) {
        local = new User({
          name: fb.displayName || lcEmail.split('@')[0],
          email: lcEmail,
          password: Math.random().toString(36).slice(2), // placeholder; not used for Firebase users
          role: 'student',
          status: 'approved',
          firebaseUid: fb.uid,
          authProvider: 'firebase',
        } as any);
      } else {
        local.firebaseUid = fb.uid;
        local.authProvider = 'firebase';
      }
      // Try to enrich with Firestore profile
      const profile = await getFirestoreUserProfile(fb.uid);
      if (profile) {
        if (profile.name && !local.name) local.name = profile.name;
        if (profile.classLevel) local.classLevel = profile.classLevel;
        if (profile.batch) local.batch = profile.batch;
      }
  await local.save();
  const token = jwt.sign({ id: local._id, role: local.role }, process.env.JWT_SECRET as string, { expiresIn: '1d' });
  // Login debug: firebase REST sign-in succeeded
  console.log(`Login debug: firebase-rest auth succeeded for ${lcEmail} (uid=${local.firebaseUid || local._id})`);
  return res.json({ token, user: { id: local._id, name: local.name, email: local.email, role: local.role, classLevel: local.classLevel, batch: local.batch, firebaseUid: local.firebaseUid } });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Return current user info based on JWT (requires authMiddleware)
export const me = async (req: Request, res: Response) => {
  try {
    const current = (req as any).user as { id: string; role?: string } | undefined;
    if (!current) return res.status(401).json({ message: 'Unauthorized' });
    const user = await User.findById(current.id).select('name email role classLevel batch firebaseUid profileImage');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ id: user._id, name: user.name, email: user.email, role: user.role, classLevel: (user as any).classLevel, batch: (user as any).batch, firebaseUid: (user as any).firebaseUid, profileImage: (user as any).profileImage });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

// Change password for authenticated user
export const changePassword = async (req: Request, res: Response) => {
  try {
    const current = (req as any).user as { id: string; role?: string } | undefined;
    if (!current) return res.status(401).json({ message: 'Unauthorized' });

    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current password and new password are required' });
    }
    
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters' });
    }

    const user = await User.findById(current.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Verify current password
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    // Update password (will be hashed by pre-save hook)
    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ message: 'Server error while changing password' });
  }
};

import OfflineResult from '../models/OfflineResult';

// Update user profile
export const updateProfile = async (req: Request, res: Response) => {
  try {
    const current = (req as any).user as { id: string; role?: string } | undefined;
    if (!current) return res.status(401).json({ message: 'Unauthorized' });

    const { name, phone, targetExams, studyGoals, profileImage } = req.body;
    
    const user = await User.findById(current.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const oldName = user.name;

    // Update allowed fields
    if (name) user.name = name;
    if (phone !== undefined) (user as any).phone = phone;
    if (targetExams !== undefined) (user as any).targetExams = targetExams;
    if (studyGoals !== undefined) (user as any).studyGoals = studyGoals;
    if (profileImage !== undefined) (user as any).profileImage = profileImage;

    await user.save();

    // Sync changes to offline results if name changed
    if (name && oldName && name !== oldName) {
      // We match by old Name AND Class to be safer, though collisions are still possible with generic names
      try {
        const result = await OfflineResult.updateMany(
          { name: oldName, class: (user as any).classLevel },
          { $set: { name: name } }
        );
        console.log(`[Profile Update] Synced name change '${oldName}' -> '${name}' for ${result.modifiedCount} offline results`);
      } catch (syncErr) {
        console.error('[Profile Update] Error syncing offline results:', syncErr);
      }
    }

    res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      phone: (user as any).phone,
      classLevel: (user as any).classLevel,
      batch: (user as any).batch,
      targetExams: (user as any).targetExams,
      studyGoals: (user as any).studyGoals,
      profileImage: (user as any).profileImage,
      firebaseUid: (user as any).firebaseUid,
    });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ message: 'Server error while updating profile' });
  }
};

// Upload profile image to Firebase Storage
export const uploadProfileImage = async (req: Request, res: Response) => {
  try {
    const current = (req as any).user as { id: string; role?: string } | undefined;
    if (!current) return res.status(401).json({ message: 'Unauthorized' });

    const file = (req as any).file;
    if (!file) {
      return res.status(400).json({ message: 'No image file provided' });
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ message: 'Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.' });
    }

    // Generate unique filename
    const ext = file.originalname.split('.').pop() || 'jpg';
    const fileName = `profile-images/${current.id}_${Date.now()}.${ext}`;

    // Upload to Firebase Storage
    const imageUrl = await uploadToFirebase(file.buffer, fileName, file.mimetype);

    // Update user's profile image URL
    const user = await User.findByIdAndUpdate(
      current.id,
      { profileImage: imageUrl },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({
      message: 'Profile image uploaded successfully',
      profileImage: imageUrl,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        profileImage: (user as any).profileImage,
      }
    });
  } catch (err) {
    console.error('Upload profile image error:', err);
    res.status(500).json({ message: 'Server error while uploading profile image' });
  }
};
