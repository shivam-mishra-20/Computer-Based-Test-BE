import { Request, Response } from 'express';
import User from '../models/User';
import jwt from 'jsonwebtoken';
import { AuthPayload } from '../middlewares/authMiddleware';
import { uploadToFirebase } from '../services/firebaseService';

const normalizeRegistrationSource = (value: unknown): 'website' | 'app' | 'unknown' => {
  const source = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (source === 'website' || source === 'web') return 'website';
  if (source === 'app' || source === 'mobile') return 'app';
  return 'unknown';
};

// Public registration endpoint for general users (with admin approval)
export const publicRegister = async (req: Request, res: Response) => {
  const { name, email, password, phone, classLevel, board, targetExams, registrationSource, profileImage } = req.body;
  const lcEmail = typeof email === 'string' ? email.toLowerCase() : email;
  
  try {
    // Validate required fields
    if (!name || !email || !password || !phone || !classLevel || !board || !targetExams || targetExams.length === 0 || !profileImage) {
      return res.status(400).json({ message: 'Name, email, password, phone, class, board, profile photo, and at least one target exam are required' });
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
      authProvider: 'local',
      registrationSource: normalizeRegistrationSource(registrationSource),
      profileImage,
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
  const { name, email, password, phone, registrationSource, profileImage } = req.body;
  const lcEmail = typeof email === 'string' ? email.toLowerCase() : email;
  
  try {
    // Validate required fields
    if (!name || !email || !password || !phone || !profileImage) {
      return res.status(400).json({ message: 'Name, email, password, phone, and profile photo are required' });
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
      authProvider: 'local',
      registrationSource: normalizeRegistrationSource(registrationSource),
      profileImage,
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

  const { name, email, password, phone, registrationSource } = req.body;
  const lcEmail = typeof email === 'string' ? email.toLowerCase() : email;
  try {
    if (!name || !email || !password || !phone) {
      return res.status(400).json({ message: 'Name, email, password and phone are required' });
    }

    const existing = await User.findOne({ email: lcEmail });
    if (existing) return res.status(400).json({ message: 'User already exists' });

  const user = new User({
    name,
    email: lcEmail,
    password,
    phone,
    role: 'student',
    status: 'approved',
    registrationSource: normalizeRegistrationSource(registrationSource),
  });
    await user.save();

  const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET as string, { expiresIn: '3650d' });
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

    if (!user) {
      return res.status(404).json({
        message: "You don't seem to have an account. Please register to login.",
        status: 'account-not-found',
      });
    }

    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Check user status
    if (user.status === 'pending') {
      return res.status(403).json({
        message: 'Your account is pending admin approval. Please wait for approval before logging in.',
        status: 'pending',
      });
    }
    if (user.status === 'rejected') {
      return res.status(403).json({
        message: 'Your account registration was rejected. Please contact support.',
        status: 'rejected',
      });
    }

    // User is approved, generate token (10 years - effectively permanent until manual logout)
    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET as string,
      { expiresIn: '3650d' }
    );
    console.log(`Login debug: mongodb-local auth succeeded for ${lcEmail}`);
    return res.json({
      token,
      user: {
        _id: user._id,
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
        classLevel: (user as any).classLevel,
        batch: (user as any).batch,
        firebaseUid: (user as any).firebaseUid,
        profileImage: (user as any).profileImage,
        phone: (user as any).phone,
        empCode: (user as any).empCode,
        registrationSource: (user as any).registrationSource,
      },
    });
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
    const user = await User.findById(current.id).select('name email role classLevel batch firebaseUid profileImage phone empCode bio status registrationSource');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ 
      _id: user._id, 
      id: user._id, 
      name: user.name, 
      email: user.email, 
      role: user.role, 
      status: (user as any).status,
      classLevel: (user as any).classLevel, 
      batch: (user as any).batch, 
      firebaseUid: (user as any).firebaseUid, 
      profileImage: (user as any).profileImage, 
      phone: (user as any).phone, 
      empCode: (user as any).empCode, 
      bio: (user as any).bio,
      registrationSource: (user as any).registrationSource,
    });
  } catch (err) {
    console.error('Get user error:', err);
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

    const { name, phone, bio, targetExams, studyGoals, profileImage, settings } = req.body;
    
    const user = await User.findById(current.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const oldName = user.name;

    // Update allowed fields
    if (name) user.name = name;
    if (phone !== undefined) (user as any).phone = phone;
    if (bio !== undefined) (user as any).bio = bio;
    if (targetExams !== undefined) (user as any).targetExams = targetExams;
    if (studyGoals !== undefined) (user as any).studyGoals = studyGoals;
    if (profileImage !== undefined) (user as any).profileImage = profileImage;
    if (settings !== undefined) {
      // Merge settings with existing settings
      (user as any).settings = {
        ...(user as any).settings,
        ...settings
      };
    }

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
      bio: (user as any).bio,
      empCode: (user as any).empCode,
      classLevel: (user as any).classLevel,
      batch: (user as any).batch,
      targetExams: (user as any).targetExams,
      studyGoals: (user as any).studyGoals,
      profileImage: (user as any).profileImage,
      firebaseUid: (user as any).firebaseUid,
      settings: (user as any).settings,
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

    console.log('[UploadProfileImage] Request received from user:', current.id);

    const file = (req as any).file;
    if (!file) {
      console.log('[UploadProfileImage] No file in request');
      return res.status(400).json({ message: 'No image file provided' });
    }

    console.log('[UploadProfileImage] File details:', {
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size
    });

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ message: 'Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.' });
    }

    // Generate unique filename
    const ext = file.originalname.split('.').pop() || 'jpg';
    const fileName = `profile-images/${current.id}_${Date.now()}.${ext}`;

    // Upload to Firebase Storage
    console.log('[UploadProfileImage] Uploading to Firebase Storage:', fileName);
    const imageUrl = await uploadToFirebase(file.buffer, fileName, file.mimetype);
    console.log('[UploadProfileImage] Upload successful, URL:', imageUrl);

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
    // Return more helpful error message
    const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';
    res.status(500).json({ 
      message: 'Failed to upload profile image', 
      error: errorMessage 
    });
  }
};
