import { Request, Response } from 'express';
import QueueService from '../services/QueueService';
import crypto from 'crypto';

export class WebhookController {
  
  // Endpoint: POST /api/webhooks/attendance
  public static async handleAttendance(req: Request, res: Response): Promise<void> {
    try {
      const signature = req.headers['x-signature'] as string;
      const payload = req.body;

      // 1. Validate Signature (Mock implementation - replace with actual secret check)
      // In production: const expected = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET)...
      if (!signature) {
         // checks disabled for dev/demo if needed, or enforce:
         // res.status(401).json({ message: 'Missing signature' });
         // return;
      }

      // 2. Validate Payload (Basic check)
      if (!payload.studentId || !payload.date || !payload.status) {
        res.status(400).json({ message: 'Invalid payload: missing required fields' });
        return;
      }

      // 3. processing
      // We pass the entire payload + headers/metadata if needed
      await QueueService.add({
        ...payload,
        source: 'webhook',
        metadata: {
           receivedAt: new Date(),
           ip: req.ip
        }
      });

      // 4. Respond immediately (Async processing)
      res.status(202).json({ message: 'Accepted', status: 'processing' });

    } catch (error) {
      console.error('Webhook Error:', error);
      res.status(500).json({ message: 'Internal Server Error' });
    }
  }
}

export default WebhookController;
