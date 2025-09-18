import { Request, Response } from 'express';
import User from '../models/User';
import jwt from 'jsonwebtoken';
import { AuthPayload } from '../middlewares/authMiddleware';
import { firebaseSignInWithEmailPassword, getFirestoreUserProfile, getFirestoreUserByEmail, getFirestoreUserByEmailAny } from '../services/firebaseService';
import bcrypt from 'bcrypt';

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

  const user = new User({ name, email: lcEmail, password, role: 'student' });
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
    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET as string, { expiresIn: '1d' });
    // Login debug: local authentication succeeded
    console.log(`Login debug: local auth succeeded for ${lcEmail}`);
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role, classLevel: (user as any).classLevel, batch: (user as any).batch, firebaseUid: (user as any).firebaseUid } });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

// Return current user info based on JWT (requires authMiddleware)
export const me = async (req: Request, res: Response) => {
  try {
    const current = (req as any).user as { id: string; role?: string } | undefined;
    if (!current) return res.status(401).json({ message: 'Unauthorized' });
    const user = await User.findById(current.id).select('name email role classLevel batch firebaseUid');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ id: user._id, name: user.name, email: user.email, role: user.role, classLevel: (user as any).classLevel, batch: (user as any).batch, firebaseUid: (user as any).firebaseUid });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};
