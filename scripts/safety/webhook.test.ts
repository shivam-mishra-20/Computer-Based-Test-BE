/**
 * Attendance webhook — refusal behaviour.
 *
 * The endpoint previously accepted unauthenticated writes. These tests exist to
 * make sure it can never quietly go back to that, and in particular that every
 * misconfiguration REFUSES rather than falling back to the permissive path.
 *
 * No database and no network: the handler is driven with fake req/res objects,
 * so this gates a pull request in milliseconds.
 *
 *   npx ts-node --transpile-only scripts/safety/webhook.test.ts
 */

import crypto from 'crypto';
import { WebhookController } from '../../src/controllers/WebhookController';

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

interface FakeRes {
  statusCode: number;
  body: unknown;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function makeReq(body: unknown, signature?: string) {
  return {
    body,
    headers: signature ? { 'x-signature': signature } : {},
    ip: '203.0.113.1',
  } as never;
}

const VALID_BODY = { studentId: '507f1f77bcf86cd799439011', date: '2026-08-17', status: 'present' };

function setEnv(env: Record<string, string | undefined>) {
  for (const key of [
    'ENABLE_ATTENDANCE_WEBHOOK',
    'ATTENDANCE_WEBHOOK_SECRET',
    'ATTENDANCE_WEBHOOK_ORG_ID',
  ]) {
    delete process.env[key];
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
}

async function main() {
  console.log('Attendance webhook refusal behaviour\n');

  // ── Disabled by default ──────────────────────────────────────────────────
  setEnv({});
  {
    const res = makeRes();
    await WebhookController.handleAttendance(makeReq(VALID_BODY), res as never);
    check(
      'DEFAULT (no env set): 404 — disabled, and does not advertise itself',
      res.statusCode === 404,
      `got ${res.statusCode}`,
    );
  }

  // ── Enabled but misconfigured must REFUSE, not fall back ────────────────
  setEnv({ ENABLE_ATTENDANCE_WEBHOOK: 'true' });
  {
    const res = makeRes();
    await WebhookController.handleAttendance(makeReq(VALID_BODY), res as never);
    check(
      'enabled with NO secret and NO org: 503 refusal, never the old open path',
      res.statusCode === 503,
      `got ${res.statusCode} — a fallback here recreates the original hole`,
    );
  }

  setEnv({ ENABLE_ATTENDANCE_WEBHOOK: 'true', ATTENDANCE_WEBHOOK_SECRET: 's3cret' });
  {
    const res = makeRes();
    await WebhookController.handleAttendance(makeReq(VALID_BODY), res as never);
    check('enabled with secret but NO org: 503 refusal', res.statusCode === 503, `got ${res.statusCode}`);
  }

  setEnv({ ENABLE_ATTENDANCE_WEBHOOK: 'true', ATTENDANCE_WEBHOOK_ORG_ID: 'ORG_001' });
  {
    const res = makeRes();
    await WebhookController.handleAttendance(makeReq(VALID_BODY), res as never);
    check('enabled with org but NO secret: 503 refusal', res.statusCode === 503, `got ${res.statusCode}`);
  }

  // ── Fully configured: signature is mandatory ────────────────────────────
  const SECRET = 'test-secret-value';
  setEnv({
    ENABLE_ATTENDANCE_WEBHOOK: 'true',
    ATTENDANCE_WEBHOOK_SECRET: SECRET,
    ATTENDANCE_WEBHOOK_ORG_ID: 'ORG_001',
  });

  {
    const res = makeRes();
    await WebhookController.handleAttendance(makeReq(VALID_BODY), res as never);
    check('configured, NO signature: 401', res.statusCode === 401, `got ${res.statusCode}`);
  }

  {
    const res = makeRes();
    await WebhookController.handleAttendance(makeReq(VALID_BODY, 'deadbeef'), res as never);
    check('configured, WRONG signature: 401', res.statusCode === 401, `got ${res.statusCode}`);
  }

  {
    // Correct signature over a DIFFERENT body — replaying someone else's
    // signature against modified content must fail.
    const otherSig = crypto
      .createHmac('sha256', SECRET)
      .update(JSON.stringify({ studentId: 'x', date: 'y', status: 'z' }))
      .digest('hex');
    const res = makeRes();
    await WebhookController.handleAttendance(makeReq(VALID_BODY, otherSig), res as never);
    check(
      'configured, signature valid for a DIFFERENT payload: 401',
      res.statusCode === 401,
      `got ${res.statusCode}`,
    );
  }

  {
    // Signature computed with the wrong secret.
    const wrongSecretSig = crypto
      .createHmac('sha256', 'not-the-secret')
      .update(JSON.stringify(VALID_BODY))
      .digest('hex');
    const res = makeRes();
    await WebhookController.handleAttendance(makeReq(VALID_BODY, wrongSecretSig), res as never);
    check('configured, signature from wrong secret: 401', res.statusCode === 401, `got ${res.statusCode}`);
  }

  {
    // Valid signature, but the payload is incomplete — validation still applies
    // AFTER authentication, never before.
    const badBody = { studentId: 'abc' };
    const sig = crypto.createHmac('sha256', SECRET).update(JSON.stringify(badBody)).digest('hex');
    const res = makeRes();
    await WebhookController.handleAttendance(makeReq(badBody, sig), res as never);
    check('valid signature but incomplete payload: 400', res.statusCode === 400, `got ${res.statusCode}`);
  }

  setEnv({});

  console.log('');
  if (failures) {
    console.error(`WEBHOOK TESTS FAILED — ${failures} of ${checks}.`);
    process.exit(1);
  }
  console.log(`All ${checks} webhook checks passed.`);
  // Explicit exit: importing the controller pulls in QueueService ->
  // AttendanceWorker -> SocketService -> config/redis, which opens a Redis
  // connection eagerly and keeps the event loop alive forever. Without this the
  // suite passes and then hangs, which in CI looks identical to a failure.
  process.exit(0);
}

main().catch((error) => {
  console.error('webhook.test.ts crashed:', error);
  process.exit(1);
});
