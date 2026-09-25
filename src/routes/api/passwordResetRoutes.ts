import { Router, Request, Response } from 'express';
import User from '../../models/User';
import { withoutTenantScope } from '../../core/tenancy';
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
    // A code for a human to type, drawn from a CSPRNG (Math.random is not one).
    const resetToken = crypto.randomInt(100000, 1000000).toString();
    const resetExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    
    // Hash the token before storing
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    
    user.passwordResetToken = hashedToken;
    user.passwordResetExpires = resetExpires;
    await user.save();
    
    // DELIVERY: the platform has no email/SMS provider. In production the code
    // is therefore NOT returned (that would hand any caller the account), and it
    // cannot be delivered either — self-service reset needs a provider wired in
    // here. Until then an administrator issues a reset LINK instead
    // (POST /api/org-admin/users/:id/reset-link). The response is identical
    // either way, so it does not reveal whether the account exists.
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
    
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
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
    // A reset signs out every session, including a thief's.
    user.tokenVersion = (Number(user.tokenVersion) || 0) + 1;
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
    
    // Only a session credential of the account itself (not a platform or a
    // refresh token), and only a harmless flag on that one account — looked up
    // by the signed id, so it works with or without an organization claim.
    const jwt = require('jsonwebtoken');
    const token = authHeader.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET) as { id: string; aud?: string };
    if (decoded.aud && decoded.aud !== 'tenant' && decoded.aud !== 'legacy') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    await withoutTenantScope('auth:welcome-tutorial', async () =>
      User.updateOne({ _id: decoded.id }, { $set: { welcomeTutorialCompleted: true } }),
    );
    
    res.json({ success: true, message: 'Welcome tutorial marked as completed' });
  } catch (error: any) {
    console.error('Welcome tutorial error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
