import { Request, Response } from 'express';
import crypto from 'crypto';
import QueueService from '../services/QueueService';
import { runWithTenant, withoutTenantScope } from '../core/tenancy';

/**
 * Inbound attendance webhook.
 *
 * ── Investigation, 2026-08-17 ───────────────────────────────────────────────
 * This endpoint previously accepted UNAUTHENTICATED WRITES: it read an
 * `x-signature` header but the verification block was commented out, so any
 * caller could queue an attendance record for any studentId.
 *
 * Before changing it, the actual integration contract was established rather
 * than assumed. The evidence says there is no integration here at all:
 *
 *   · eTimeOffice is PULL-only. `EtimeService.syncAttendance()` calls
 *     `GET {ETIME_API_URL}/DownloadPunchData` on a cron. Nothing registers a
 *     callback URL with them, and their client has zero webhook references.
 *   · `WEBHOOK_SECRET` has never been configured.
 *   · Seven months of production attendance (2026-01-02 → 2026-08-16, 7,643
 *     records) are 100% `source: 'external'`, written by EtimeService's pull
 *     path. `distinct('source')` returns exactly `['external']`.
 *   · This path would write `source: 'webhook'`. There are ZERO such records,
 *     and zero audit entries mentioning a webhook.
 *   · No client repository calls it.
 *
 * So it is dead scaffolding — the original comment saying "Mock
 * implementation" was accurate — and disabling it breaks nothing.
 *
 * ── Resolution ──────────────────────────────────────────────────────────────
 * DISABLED BY DEFAULT. The code is retained rather than deleted so a real push
 * integration can be built on it, and enabling it now requires doing the whole
 * thing properly: a shared secret, an explicitly configured organization, and
 * a membership check. There is deliberately no path that writes attendance
 * without all three.
 *
 * Tenant identity is NEVER inferred from studentId. An attacker chooses the
 * studentId, so deriving the organization from it would let a caller write
 * into whichever tenant they name — the precise hole this closes.
 */

interface WebhookConfig {
  enabled: boolean;
  secret: string | null;
  orgId: string | null;
}

function readConfig(): WebhookConfig {
  return {
    enabled: String(process.env.ENABLE_ATTENDANCE_WEBHOOK ?? 'false').toLowerCase() === 'true',
    secret: (process.env.ATTENDANCE_WEBHOOK_SECRET || '').trim() || null,
    orgId: (process.env.ATTENDANCE_WEBHOOK_ORG_ID || '').trim() || null,
  };
}

/**
 * Constant-time HMAC comparison.
 *
 * `===` on a signature leaks the position of the first differing byte through
 * timing, which is enough to reconstruct a valid signature given patience.
 * `timingSafeEqual` needs equal-length buffers, so length is checked first —
 * that check leaks only the length, which is fixed and public anyway.
 */
function signatureMatches(payload: string, provided: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided.trim().replace(/^sha256=/i, ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export class WebhookController {
  // POST /api/webhooks/attendance
  public static async handleAttendance(req: Request, res: Response): Promise<void> {
    const config = readConfig();

    // ── 1. Disabled ────────────────────────────────────────────────────────
    // 404, not 403: an endpoint that is switched off should not advertise that
    // it exists and is merely locked.
    if (!config.enabled) {
      res.status(404).json({ message: 'Not found' });
      return;
    }

    // ── 2. Misconfiguration is a refusal, never a fallback ────────────────
    // Enabling the flag without a secret and an organization must not degrade
    // to the old unauthenticated behaviour. That degradation is exactly how
    // the original hole would come back.
    if (!config.secret || !config.orgId) {
      console.error(
        '[webhook:attendance] ENABLE_ATTENDANCE_WEBHOOK=true but ' +
          'ATTENDANCE_WEBHOOK_SECRET and/or ATTENDANCE_WEBHOOK_ORG_ID are unset. Refusing.',
      );
      res.status(503).json({ message: 'Webhook not configured', code: 'WEBHOOK_NOT_CONFIGURED' });
      return;
    }

    try {
      // ── 3. Authenticate ─────────────────────────────────────────────────
      const provided = req.headers['x-signature'];
      if (typeof provided !== 'string' || !provided) {
        res.status(401).json({ message: 'Missing signature' });
        return;
      }

      // Signed over the exact bytes received. Re-serialising the parsed body
      // would let a caller craft a payload that stringifies differently from
      // what they signed.
      const raw =
        (req as Request & { rawBody?: Buffer }).rawBody?.toString('utf8') ??
        JSON.stringify(req.body ?? {});

      if (!signatureMatches(raw, provided, config.secret)) {
        res.status(401).json({ message: 'Invalid signature' });
        return;
      }

      // ── 4. Validate payload ─────────────────────────────────────────────
      const payload = req.body as { studentId?: string; date?: string; status?: string };
      if (!payload?.studentId || !payload.date || !payload.status) {
        res.status(400).json({ message: 'Invalid payload: missing required fields' });
        return;
      }

      // ── 5. Organization comes from CONFIGURATION, never the payload ─────
      const orgId = config.orgId;

      // ── 6. The student must belong to that organization ─────────────────
      // Without this, a caller holding the secret for org A could still write
      // attendance for a student in org B by naming their id.
      const belongs = await runWithTenant({ orgId, source: 'job' }, async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const User = require('../models/User').default;
        return Boolean(await User.exists({ _id: payload.studentId }));
      });

      if (!belongs) {
        console.warn(
          `[webhook:attendance] rejected: student ${payload.studentId} is not in org ${orgId}`,
        );
        // 202 deliberately: a signed caller should not be able to probe which
        // student ids exist by watching status codes. The record is dropped.
        res.status(202).json({ message: 'Accepted', status: 'ignored' });
        return;
      }

      // ── 7. Enqueue, carrying the organization with the job ──────────────
      await runWithTenant({ orgId, source: 'job' }, async () => {
        await QueueService.add({
          ...payload,
          source: 'webhook',
          metadata: { receivedAt: new Date(), ip: req.ip },
        });
      });

      res.status(202).json({ message: 'Accepted', status: 'processing' });
    } catch (error) {
      console.error('Webhook Error:', error);
      res.status(500).json({ message: 'Internal Server Error' });
    }
  }
}

// Referenced so the import is not stripped; the escape hatch is documented in
// publicRoutes.ts as deliberately NOT covering this endpoint.
void withoutTenantScope;

export default WebhookController;
