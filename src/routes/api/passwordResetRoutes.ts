import { Router, Request, Response } from 'express';
import User from '../../models/User';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { passwordResetLimiter } from '../../middlewares/rateLimiter';

const router = Router();

// Request password reset - generates token
router.post('/forgot-password', passwordResetLimiter, async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    const lcEmail = typeof email === 'string' ? email.toLowerCase().trim() : email;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const user = await User.findOne({ email: lcEmail });
    
    // Always return success to prevent email enumeration
    if (!user) {
      return res.json({ 
        success: true, 
        message: 'If an account exists with that email, a reset token has been generated.' 
      });
    }
    
    // Generate reset token (6-digit numeric code for simplicity)
    const resetToken = Math.floor(100000 + Math.random() * 900000).toString();
    const resetExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    
    // Hash the token before storing
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    
    user.passwordResetToken = hashedToken;
    user.passwordResetExpires = resetExpires;
    await user.save();
    
    // In production, you would send an email here
    // For now, we'll return the token in development mode
    const response: any = { 
      success: true, 
      message: 'Password reset token generated. Valid for 15 minutes.',
      expiresAt: resetExpires
    };
    
    // Only include token in development for testing
    if (process.env.NODE_ENV !== 'production') {
      response.token = resetToken;
    }
    
    res.json(response);
  } catch (error: any) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset password with token
router.post('/reset-password', passwordResetLimiter, async (req: Request, res: Response) => {
  try {
    const { email, token, newPassword } = req.body;
    const lcEmail = typeof email === 'string' ? email.toLowerCase().trim() : email;
    
    if (!email || !token || !newPassword) {
      return res.status(400).json({ error: 'Email, token, and new password are required' });
    }
    
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    
    // Hash the provided token for comparison
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    
    const user = await User.findOne({ 
      email: lcEmail,
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: new Date() }
    });
    
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }
    
    // Update password (will be hashed by pre-save hook)
    user.password = newPassword;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();
    
    res.json({ success: true, message: 'Password has been reset successfully' });
  } catch (error: any) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark welcome tutorial as completed
router.post('/welcome-tutorial/complete', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Decode token to get user ID (simplified - in production use proper middleware)
    const jwt = require('jsonwebtoken');
    const token = authHeader.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET) as { id: string };
    
    await User.findByIdAndUpdate(decoded.id, { welcomeTutorialCompleted: true });
    
    res.json({ success: true, message: 'Welcome tutorial marked as completed' });
  } catch (error: any) {
    console.error('Welcome tutorial error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
