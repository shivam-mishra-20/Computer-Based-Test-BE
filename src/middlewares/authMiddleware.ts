import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthPayload {
  id: string;
  role?: string;
  name?: string;
}

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.header('Authorization');
  
  const token = authHeader?.replace('Bearer ', '').trim();
  
  // Check if token is missing, empty, or the literal string "null" or "undefined"
  if (!token || token === 'null' || token === 'undefined' || token.length < 20) {
    // Log the rejection reason for debugging (only in development or when DEBUG_AUTH is set)
    if (process.env.NODE_ENV !== 'production' || process.env.DEBUG_AUTH) {
      console.warn(`[Auth] 401 on ${req.method} ${req.path} — reason: ${
        !authHeader ? 'no Authorization header' :
        !token ? 'empty token after parsing' :
        token === 'null' ? 'token is literal "null"' :
        token === 'undefined' ? 'token is literal "undefined"' :
        token.length < 20 ? `token too short (${token.length} chars)` : 'unknown'
      }`);
    }
    return res.status(401).json({ message: 'No token, authorization denied' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as AuthPayload;
    
    // Fetch user from DB to get profile and latest role/assignment metadata
    const User = require('../models/User').default;
    const user = await User.findById(decoded.id)
      .select('name role email classLevel batch firebaseUid status')
      .lean();
    
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }
    
    // Set both id and _id for compatibility, plus profile metadata from DB
    (req as any).user = { 
      id: decoded.id, 
      _id: decoded.id, 
      role: (user as any).role || decoded.role,
      name: (user as any).name,
      email: (user as any).email,
      classLevel: (user as any).classLevel,
      batch: (user as any).batch,
      firebaseUid: (user as any).firebaseUid,
      status: (user as any).status,
    };
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

export const requireRole = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const current = (req as any).user as { id: string; role?: string } | undefined;
    if (!current) return res.status(401).json({ message: 'Unauthorized' });
    if (!current.role || !roles.includes(current.role)) {
      return res.status(403).json({ message: 'Forbidden: insufficient role' });
    }
    next();
  };
};
