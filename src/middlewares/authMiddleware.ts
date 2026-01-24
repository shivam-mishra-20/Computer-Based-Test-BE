import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthPayload {
  id: string;
  role?: string;
}

export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.header('Authorization');
  console.log('[authMiddleware] Path:', req.path, 'Authorization header:', authHeader ? 'Present' : 'Missing');
  
  if (authHeader) {
    console.log('[authMiddleware] Full auth header (first 50 chars):', authHeader.substring(0, 50));
  }
  
  const token = authHeader?.replace('Bearer ', '').trim();
  
  // Check if token is missing, empty, or the literal string "null" or "undefined"
  if (!token || token === 'null' || token === 'undefined' || token.length < 20) {
    console.log('[authMiddleware] Invalid or missing token:', token || 'empty');
    return res.status(401).json({ message: 'No token, authorization denied' });
  }

  console.log('[authMiddleware] Token (first 20 chars):', token.substring(0, 20), 'Length:', token.length);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as AuthPayload;
    // Set both id and _id for compatibility with different route handlers
    (req as any).user = { id: decoded.id, _id: decoded.id, role: decoded.role };
    console.log('[authMiddleware] Token valid for user:', decoded.id, 'role:', decoded.role);
    next();
  } catch (err) {
    console.log('[authMiddleware] Token verification failed:', err);
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
