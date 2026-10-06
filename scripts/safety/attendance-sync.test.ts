/**
 * Biometric attendance sync — the rules that decide what a sync fetches,
 * what it writes, and whether the scheduled sync is healthy.
 *
 * ── The problems this locks down ────────────────────────────────────────────
 *   one request per range   a long range was one device request; one timeout
 *                           lost the whole range. Windows must cover every day
 *                           exactly once and never exceed a month.
 *   rewrite everything      every sync rewrote every day it saw, so "your
 *                           attendance was updated" went to everyone four
 *                           times a day. Only a real change may count.
 *   silent scheduler        nothing said whether the cron had stopped. The
 *                           health check must tell ok / running / failing /
 *                           stalled / missed apart.
 *
 * Pure functions only — no database, no network.
 *
 *   npx ts-node --transpile-only scripts/safety/attendance-sync.test.ts
 */

import {
  assessAutoSync,
  autoSyncRange,
  checkSyncRange,
  dayNeedsWrite,
  formatDdMmYyyy,
  groupPunchesByDay,
  idempotencyKeyFor,
  isNoDataMessage,
  nextScheduledRun,
  parseDdMmYyyy,
  splitIntoWindows,
  storedDateFor,
} from '../../src/services/etimeSyncLogic';

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

const d = (value: string) => parseDdMmYyyy(value)!;

section('Dates and ranges');
{
  check('reads a real date', JSON.stringify(parseDdMmYyyy('06/10/2026')) === '{"year":2026,"month":10,"day":6}');
  check('rejects 31/02', parseDdMmYyyy('31/02/2026') === null);
  check('rejects yyyy-mm-dd', parseDdMmYyyy('2026-10-06') === null);
  check('one day is a valid range', checkSyncRange('06/10/2026', '06/10/2026').ok);
  check('reversed range is refused', !checkSyncRange('07/10/2026', '06/10/2026').ok);
  check('a full year is allowed', checkSyncRange('01/01/2026', '31/12/2026').ok);
  check('more than 366 days is refused', !checkSyncRange('01/01/2025', '03/01/2026').ok);
}

section('Windows cover every day exactly once, a month at most');
{
  const single = splitIntoWindows(d('06/10/2026'), d('06/10/2026'));
  check('one day → one window', single.length === 1 && formatDdMmYyyy(single[0].to) === '06/10/2026');

  const year = splitIntoWindows(d('01/01/2026'), d('31/12/2026'), 31);
  let covered = 0;
  let contiguous = true;
  let maxLen = 0;
  for (let i = 0; i < year.length; i += 1) {
    const from = Date.UTC(year[i].from.year, year[i].from.month - 1, year[i].from.day);
    const to = Date.UTC(year[i].to.year, year[i].to.month - 1, year[i].to.day);
    const len = Math.round((to - from) / 86400000) + 1;
    covered += len;
    maxLen = Math.max(maxLen, len);
    if (i > 0) {
      const prevTo = Date.UTC(year[i - 1].to.year, year[i - 1].to.month - 1, year[i - 1].to.day);
      if (from - prevTo !== 86400000) contiguous = false;
    }
  }
  check('365 days covered', covered === 365, `covered ${covered}`);
  check('no gaps or overlaps', contiguous);
  check('no window longer than 31 days', maxLen <= 31, `max ${maxLen}`);
  check('crosses a month end', formatDdMmYyyy(splitIntoWindows(d('25/09/2026'), d('05/10/2026'), 31)[0].to) === '05/10/2026');
}

section('Device "no data" is an empty window, not a failure');
{
  check('"No Record Found"', isNoDataMessage('No Record Found'));
  check('"No data found"', isNoDataMessage('No data found'));
  check('auth error is a failure', !isNoDataMessage('Invalid credentials'));
}

section('Punches become one day per person');
{
  const { days, skipped } = groupPunchesByDay([
    { Name: 'A', Empcode: ' 101 ', PunchDate: '06/10/2026 18:45:00', M_Flag: null },
    { Name: 'A', Empcode: '101', PunchDate: '06/10/2026 10:28:00', M_Flag: null },
    { Name: 'A', Empcode: '101', PunchDate: '06/10/2026 13:10:00', M_Flag: null },
    { Name: 'B', Empcode: '102', PunchDate: '06/10/2026 9:05:00', M_Flag: null },
    { Name: 'B', Empcode: '102', PunchDate: '06/10/2026 10:15:00', M_Flag: null },
    { Name: 'C', Empcode: '103', PunchDate: '06/10/2026 11:00:00', M_Flag: null },
    { Name: 'A', Empcode: '101', PunchDate: '07/10/2026 10:31:00', M_Flag: null },
    { Name: 'X', Empcode: '', PunchDate: '06/10/2026 10:00:00', M_Flag: null },
    { Name: 'Y', Empcode: '104', PunchDate: 'garbage', M_Flag: null },
  ]);
  const byKey = new Map(days.map((day) => [idempotencyKeyFor(day), day]));
  const a = byKey.get('etime-101-06/10/2026');
  check('unreadable punches are counted, not stored', skipped === 2, `skipped ${skipped}`);
  check('four person-days', days.length === 4, `got ${days.length}`);
  check('first punch is clock-in', a?.clockIn === '10:28');
  check('last punch is clock-out', a?.clockOut === '18:45');
  check('punch count kept', a?.punchCount === 3);
  check('codes are trimmed', Boolean(a));
  check('9:05 sorts before 10:15', byKey.get('etime-102-06/10/2026')?.clockIn === '09:05');
  check('single punch has no clock-out', byKey.get('etime-103-06/10/2026')?.clockOut === undefined);
  check('a new day is a separate record', byKey.has('etime-101-07/10/2026'));
  check('stored date is midnight UTC (as before)', storedDateFor('06/10/2026').toISOString() === '2026-10-06T00:00:00.000Z');
}

section('Only real changes are written');
{
  const next = {
    studentId: 'u1',
    date: storedDateFor('06/10/2026'),
    status: 'present',
    clockIn: '10:28',
    clockOut: '18:45',
    punchCount: 3,
  };
  const stored = {
    studentId: 'u1',
    date: new Date('2026-10-06T00:00:00.000Z'),
    status: 'present',
    clockIn: '10:28',
    clockOut: '18:45',
    metadata: { punchCount: 3 },
  };
  check('new day is written', dayNeedsWrite(null, next));
  check('identical day is skipped', !dayNeedsWrite(stored, next));
  check('new clock-out is written', dayNeedsWrite({ ...stored, clockOut: undefined, metadata: { punchCount: 1 } }, next));
  check('later clock-out is written', dayNeedsWrite({ ...stored, clockOut: '17:00' }, next));
  check('extra middle punch is written', dayNeedsWrite({ ...stored, metadata: { punchCount: 2 } }, next));
  check('missing clock-out on the device never erases one', !dayNeedsWrite(stored, { ...next, clockOut: undefined }));
  check('status corrected to present is written', dayNeedsWrite({ ...stored, status: 'absent' }, next));
}

section('Scheduled sync health');
{
  const slots = [
    { hour: 11, minute: 40 },
    { hour: 16, minute: 0 },
    { hour: 21, minute: 0 },
    { hour: 3, minute: 0 },
  ];
  // 13:00 IST on 6 Oct 2026 = 07:30 UTC. The 11:40 run should have finished.
  const now = new Date('2026-10-06T07:30:00.000Z');
  const at = (iso: string) => new Date(iso);

  const next = nextScheduledRun(now, slots);
  check('next run is 4:00 PM IST', next?.toISOString() === '2026-10-06T10:30:00.000Z', next?.toISOString());
  const lateNight = nextScheduledRun(new Date('2026-10-06T16:00:00.000Z'), slots); // 21:30 IST
  check('after 9 PM the next run is 3 AM tomorrow', lateNight?.toISOString() === '2026-10-06T21:30:00.000Z', lateNight?.toISOString());

  const ok = assessAutoSync(now, slots, {
    lastStart: at('2026-10-06T06:10:00.000Z'),
    lastComplete: at('2026-10-06T06:12:00.000Z'),
  });
  check('completed after 11:40 → ok', ok.status === 'ok', ok.status);
  check('judged against the 11:40 slot', ok.expectedSince?.toISOString() === '2026-10-06T06:10:00.000Z');

  const missed = assessAutoSync(now, slots, {
    lastStart: at('2026-10-05T15:30:00.000Z'),
    lastComplete: at('2026-10-05T15:31:00.000Z'),
  });
  check('nothing since yesterday 9 PM → missed', missed.status === 'missed', missed.status);
  check('no history at all → missed', assessAutoSync(now, slots, {}).status === 'missed');

  const failing = assessAutoSync(now, slots, {
    lastStart: at('2026-10-06T06:10:00.000Z'),
    lastFailure: at('2026-10-06T06:11:00.000Z'),
    lastComplete: at('2026-10-05T21:32:00.000Z'),
  });
  check('failed after 11:40 → failing', failing.status === 'failing', failing.status);

  const stalled = assessAutoSync(now, slots, {
    lastStart: at('2026-10-06T06:10:00.000Z'),
    lastComplete: at('2026-10-05T21:32:00.000Z'),
  });
  check('started at 11:40, never finished → stalled', stalled.status === 'stalled', stalled.status);

  // 11:50 IST: the 11:40 run is in progress; 3 AM is the slot it is judged by.
  const midRun = assessAutoSync(new Date('2026-10-06T06:20:00.000Z'), slots, {
    lastStart: at('2026-10-06T06:10:00.000Z'),
    lastComplete: at('2026-10-05T21:32:00.000Z'),
  });
  check('a run in progress reads as running', midRun.status === 'running', midRun.status);

  const graceOk = assessAutoSync(new Date('2026-10-06T06:20:00.000Z'), slots, {
    lastStart: at('2026-10-05T21:30:00.000Z'),
    lastComplete: at('2026-10-05T21:32:00.000Z'),
  });
  check('ten minutes after a slot, the previous run still counts', graceOk.status === 'ok', graceOk.status);
}

section('Scheduled range: month to date in India time, always including yesterday');
{
  const r = (iso: string) => JSON.stringify(autoSyncRange(new Date(iso)));
  check('mid-month at 11:40 IST', r('2026-10-06T06:10:00.000Z') === '{"fromDate":"01/10/2026","toDate":"06/10/2026"}', r('2026-10-06T06:10:00.000Z'));
  // 3:00 AM IST on 1 Oct = 21:30 UTC on 30 Sep: the server clock says September.
  check('3 AM on the 1st keeps last month', r('2026-09-30T21:30:00.000Z') === '{"fromDate":"01/09/2026","toDate":"01/10/2026"}', r('2026-09-30T21:30:00.000Z'));
  check('11:40 AM on the 2nd is this month only', r('2026-10-02T06:10:00.000Z') === '{"fromDate":"01/10/2026","toDate":"02/10/2026"}', r('2026-10-02T06:10:00.000Z'));
  check('new year', r('2026-12-31T21:30:00.000Z') === '{"fromDate":"01/12/2026","toDate":"01/01/2027"}', r('2026-12-31T21:30:00.000Z'));
}

console.log(`\n${checks} checks, ${failures} failure(s).`);
process.exit(failures ? 1 : 0);
