import { Router } from 'express';
import WebhookController from '../../controllers/WebhookController';

const router = Router();

router.post('/attendance', WebhookController.handleAttendance);

export default router;

