import { Request, Response } from 'express';
import User from '../models/User';
import jwt from 'jsonwebtoken';
import { AuthPayload } from '../middlewares/authMiddleware';

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
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET as string, { expiresIn: '1d' });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

// Return current user info based on JWT (requires authMiddleware)
export const me = async (req: Request, res: Response) => {
  try {
    const current = (req as any).user as { id: string; role?: string } | undefined;
    if (!current) return res.status(401).json({ message: 'Unauthorized' });
    const user = await User.findById(current.id).select('name email role');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ id: user._id, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};
