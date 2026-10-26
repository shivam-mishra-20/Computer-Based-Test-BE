/**
 * Usage limits — the counting rules and the gate's arithmetic, as pure logic.
 * No database. The end-to-end proof (concurrency, transfers, downgrades, every
 * route) is usage-limits.e2e.test.ts.
 *
 *   npx ts-node --transpile-only scripts/safety/usage-limits.test.ts
 */

import {
  ENFORCED_RESOURCES,
  PlanLimitReached,
  SEAT_RESOURCES,
  UsageBusy,
  effectiveLimit,
  monthStart,
  seatOf,
} from '../../src/core/subscriptions/usage';
import { LIMIT_KEYS } from '../../src/core/subscriptions/catalogue';
import { platformRuntimeEnv } from '../../src/core/realm/realm';
import { SubscriptionLifecycleCron } from '../../src/services/SubscriptionLifecycleCron';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}
const section = (t: string) => console.log(`\n${t}`);

function main() {
  console.log('Usage limits\n');

  section('what holds a seat');
  check('an approved student holds a student seat', seatOf({ role: 'student', status: 'approved' }) === 'students');
  check('...also when marked INSTITUTE_STUDENT', seatOf({ role: 'student', status: 'approved', accountType: 'INSTITUTE_STUDENT' }) === 'students');
  check('a pending or rejected student holds none', seatOf({ role: 'student', status: 'pending' }) === null && seatOf({ role: 'student', status: 'rejected' }) === null);
  check('a public learner never holds an institute seat', seatOf({ role: 'student', status: 'approved', accountType: 'PUBLIC_LEARNER' }) === null);
  check('approved teachers and admins hold staff seats', seatOf({ role: 'teacher', status: 'approved' }) === 'teachers' && seatOf({ role: 'admin', status: 'approved' }) === 'admins');
  check('a parent holds no seat', seatOf({ role: 'parent', status: 'approved' }) === null);

  section('which limits are enforced');
  check('LIMIT_KEYS says enforced for exactly the resources the gate meters',
    Object.entries(LIMIT_KEYS).every(([k, v]) => v.enforced === (ENFORCED_RESOURCES as string[]).includes(k)),
    JSON.stringify(Object.fromEntries(Object.entries(LIMIT_KEYS).map(([k, v]) => [k, v.enforced]))));
  check('storage and exams-per-month are recorded but NOT enforced', !LIMIT_KEYS.storageGb.enforced && !LIMIT_KEYS.examsMonthly.enforced);
  check('every seat resource is a limit key', SEAT_RESOURCES.every((r) => Boolean(LIMIT_KEYS[r])));

  section('the effective limit');
  check('a managed subscription with a number is limited', effectiveLimit({ limits: { students: 100 }, limitsEnforced: true }, 'students') === 100);
  check('zero is a limit (nothing allowed), not "unlimited"', effectiveLimit({ limits: { teachers: 0 }, limitsEnforced: true }, 'teachers') === 0);
  check('-1 is unlimited', effectiveLimit({ limits: { students: -1 }, limitsEnforced: true }, 'students') === null);
  check('an absent limit is unlimited', effectiveLimit({ limits: {}, limitsEnforced: true }, 'students') === null);
  check('limits of an unmanaged (pre-lifecycle) subscription are not enforced', effectiveLimit({ limits: { students: 1 }, limitsEnforced: false }, 'students') === null);
  check('...nor of a snapshot that predates the field', effectiveLimit({ limits: { students: 1 } } as never, 'students') === null);

  section('the month (IST)');
  check('00:00 IST on 1 November is the start of November', monthStart(new Date('2026-10-31T18:30:00.000Z')).toISOString() === '2026-10-31T18:30:00.000Z');
  check('23:59 IST on 31 October is still October', monthStart(new Date('2026-10-31T18:29:59.000Z')).toISOString() === '2026-09-30T18:30:00.000Z');
  check('mid-month resolves to the 1st at 00:00 IST', monthStart(new Date('2026-10-17T06:30:00.000Z')).toISOString() === '2026-09-30T18:30:00.000Z');
  check('January from a 1 January IST morning (UTC still in December)', monthStart(new Date('2026-12-31T20:00:00.000Z')).toISOString() === '2026-12-31T18:30:00.000Z');

  section('the refusal');
  const refusal = new PlanLimitReached('students', 100, 100);
  const body = refusal.body();
  check('402 PLAN_LIMIT_REACHED', refusal.status === 402 && body.code === 'PLAN_LIMIT_REACHED');
  check('names the resource, the limit, current usage and the request', body.resource === 'students' && body.limit === 100 && body.current === 100 && body.requested === 1);
  check('says it in words, with nothing about any other organization', /100 active students/.test(body.message) && !/org/i.test(body.message.replace(/organization/gi, '')));
  check('the singular reads right', /1 teacher,/.test(new PlanLimitReached('teachers', 1, 1).message));
  check('a lease that could not be had is 503 USAGE_CHECK_BUSY', new UsageBusy('students').status === 503 && new UsageBusy('students').code === 'USAGE_CHECK_BUSY');

  section('the daily sweep is gated');
  const runtimeOff = platformRuntimeEnv({ JWT_SECRET: 'test-only-secret', MONGO_URI: 'mongodb://127.0.0.1:1/e', PLATFORM_MONGODB_URI: 'mongodb://127.0.0.1:1/p' } as NodeJS.ProcessEnv, { primary: true, gatewayKey: 'k' });
  const runtimeOn = platformRuntimeEnv({ JWT_SECRET: 'test-only-secret', MONGO_URI: 'mongodb://127.0.0.1:1/e', PLATFORM_MONGODB_URI: 'mongodb://127.0.0.1:1/p', PLATFORM_ENABLE_CRON: 'true' } as NodeJS.ProcessEnv, { primary: true, gatewayKey: 'k' });
  check('the platform runtime has cron OFF unless PLATFORM_ENABLE_CRON=true', runtimeOff.ENABLE_CRON === 'false' && runtimeOn.ENABLE_CRON === 'true');
  check('...whatever the existing system\'s ENABLE_CRON says', platformRuntimeEnv({ JWT_SECRET: 'test-only-secret', MONGO_URI: 'mongodb://127.0.0.1:1/e', PLATFORM_MONGODB_URI: 'mongodb://127.0.0.1:1/p', ENABLE_CRON: 'true' } as NodeJS.ProcessEnv, { primary: true, gatewayKey: 'k' }).ENABLE_CRON === 'false');
  check('the sweep does not run in the platform runtime with cron off', SubscriptionLifecycleCron.shouldRun(runtimeOff) === false);
  check('...and does with PLATFORM_ENABLE_CRON=true', SubscriptionLifecycleCron.shouldRun(runtimeOn) === true);
  check('the existing system never runs it, even with ENABLE_CRON=true', SubscriptionLifecycleCron.shouldRun({ ENABLE_CRON: 'true' } as NodeJS.ProcessEnv) === false);

  console.log(`\n  ${checks - failures}/${checks} checks passed.\n`);
  process.exit(failures ? 1 : 0);
}

main();
