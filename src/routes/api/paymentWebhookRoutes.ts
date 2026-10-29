/**
 * POST /api/public/payments/cashfree/webhook — Cashfree's server-to-server
 * notification for registration checkouts (core/billing/registrationPayments).
 *
 * Mounted in app.ts BEFORE the JSON parser, with its own raw parser: the
 * signature is an HMAC over the exact bytes received, and a body that has been
 * parsed and re-serialised no longer matches it.
 *
 * The delivery is only a prompt. After the signature and the time window are
 * checked, the order is looked up with Cashfree from here and THAT answer is
 * recorded — the webhook body's own claims about money are never written.
 *
 *   200  processed, ignored (not one of ours) or already seen
 *   400  stale or malformed — nothing written
 *   401  bad signature — nothing written
 *   500  our failure — Cashfree retries, and a retry is processed again
 */

import express, { Request, Response } from 'express';
import { requirePlatformDeployment } from '../../middlewares/requirePlatformDeployment';
import { BillingError } from '../../core/billing/invoices';
import { handleCashfreeWebhook } from '../../core/billing/gatewayWebhook';
import { autopayReturn } from '../../core/billing/autopay';

export const CASHFREE_WEBHOOK_PATH = '/api/public/payments/cashfree/webhook';

async function cashfreeWebhook(req: Request, res: Response) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  try {
    const result = await handleCashfreeWebhook(raw, {
      'x-webhook-signature': req.header('x-webhook-signature') ?? undefined,
      'x-webhook-timestamp': req.header('x-webhook-timestamp') ?? undefined,
    });
    return res.status(200).json({ received: true, duplicate: result.duplicate });
  } catch (error) {
    if (error instanceof BillingError && error.status < 500) {
      return res.status(error.status).json({ message: error.message, code: error.code });
    }
    console.error('[cashfree-webhook] failed:', (error as Error)?.message);
    return res.status(500).json({ message: 'Webhook processing failed.' });
  }
}

export const cashfreeWebhookRoute = [
  requirePlatformDeployment,
  express.raw({ type: '*/*', limit: '256kb' }),
  cashfreeWebhook,
] as const;

/**
 * Where Cashfree sends the browser after an institute authorises auto-pay —
 * a form POST (GET accepted too). The mandate is checked with Cashfree, then
 * the browser goes back to the admin panel page that started it, with
 * `?autopay=<status>`. Nothing from the posted form is trusted.
 */
export const paymentReturnRoutes = express.Router();
paymentReturnRoutes.all('/payments/cashfree/autopay-return', requirePlatformDeployment, async (req: Request, res: Response) => {
  try {
    const target = await autopayReturn(String(req.query.m ?? ''));
    if (target) return res.redirect(303, target);
    return res.status(404).type('text/plain').send('This auto-pay setup was not found. Close this page and check Subscription & billing.');
  } catch (error) {
    console.error('[autopay-return] failed:', (error as Error)?.message);
    return res.status(500).type('text/plain').send('Something went wrong. Close this page and check Subscription & billing.');
  }
});
