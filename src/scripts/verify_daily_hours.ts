/**
 * Regression checks for the Daily Working Hours arithmetic.
 *
 *     npx ts-node --transpile-only src/scripts/verify_daily_hours.ts
 *
 * No database and no framework: every expectation is hand-computed from the
 * definitions in `services/dailyHoursService.ts`. These figures are read as a
 * record of someone's working day, and the two rules that are easy to get wrong
 * (class hours are a union, not a sum; class hours are capped to the punch
 * window so non-class hours can never go negative) are pinned here.
 */
import {
  buildDailyHoursRow,
  intersectIntervals,
  mergeIntervals,
  scheduleAppliesOn,
  scheduleWindow,
  timeToMinutes,
  toInterval,
  totalMinutes,
} from '../services/dailyHoursService';

let failures = 0;
function check(name: string, actual: any, expected: any) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures += 1;
    console.log(`FAIL  ${name}\n      expected ${e}\n      actual   ${a}`);
  } else {
    console.log(`ok    ${name} = ${a}`);
  }
}

// ── Primitives ──────────────────────────────────────────────────────────────
check('merge overlapping', mergeIntervals([[10, 20], [15, 30], [40, 50]]), [[10, 30], [40, 50]]);
check('merge touching', mergeIntervals([[10, 20], [20, 30]]), [[10, 30]]);
check('intersect', intersectIntervals([[10, 30]], [[20, 40]]), [[20, 30]]);
check('intersect disjoint', intersectIntervals([[10, 20]], [[30, 40]]), []);
check('total merges before summing', totalMinutes([[0, 60], [30, 90]]), 90);
check('time parse', timeToMinutes('09:05'), 545);
check('time parse rejects placeholder', timeToMinutes('--:--'), null);
check('interval with bad end becomes one hour', toInterval('14:30', ''), [870, 930]);

// ── Fixtures ────────────────────────────────────────────────────────────────
const user = { _id: 'u1', name: 'A. Teacher', empCode: '101' };
const base = { user, date: new Date(2026, 8, 2), isWorkingDay: true, holidayName: null };
const cls = (startTime: string, endTime: string, id = startTime) => ({
  scheduleId: id,
  subject: 'Maths',
  classLevel: '10',
  batch: 'B1',
  roomNumber: 1,
  startTime,
  endTime,
  scheduleType: 'regular' as const,
});

// ── The example from the spec ───────────────────────────────────────────────
// In 09:05, out 18:10 → 8h 35m. Four and a half hours of class → 4h 05m non-class.
const spec = buildDailyHoursRow({
  ...base,
  attendance: { clockIn: '09:05', clockOut: '18:10', punchCount: 2 },
  schedule: [cls('10:00', '12:00'), cls('14:00', '16:30')],
  eodDoc: { status: 'pending', submittedAt: new Date() },
});
check('spec: working minutes', spec.workingMinutes, 545);
check('spec: class minutes', spec.classMinutes, 270);
check('spec: non-class minutes', spec.nonClassMinutes, 275);
check('spec: working = class + non-class', spec.classMinutes + spec.nonClassMinutes, spec.workingMinutes);
check('spec: eod status', spec.eodStatus, 'PENDING');

// ── Overlapping classes are a UNION, never a sum ────────────────────────────
// One combined session stored as two rows (two batches, same room, same hour).
const combined = buildDailyHoursRow({
  ...base,
  attendance: { clockIn: '09:00', clockOut: '18:00', punchCount: 2 },
  schedule: [cls('10:00', '11:00', 'a'), cls('10:00', '11:00', 'b')],
  eodDoc: null,
});
check('combined: counted once', combined.classMinutes, 60);
check('combined: flagged as overlapping', combined.hasOverlappingClasses, true);
check('combined: per-class minutes still shown', combined.classes.map((c) => c.countedMinutes), [60, 60]);

// Partially overlapping sessions.
const partial = buildDailyHoursRow({
  ...base,
  attendance: { clockIn: '09:00', clockOut: '18:00', punchCount: 2 },
  schedule: [cls('10:00', '11:30', 'a'), cls('11:00', '12:00', 'b')],
  eodDoc: null,
});
check('partial overlap: union is 10:00-12:00', partial.classMinutes, 120);
check('partial overlap: flagged', partial.hasOverlappingClasses, true);

// Non-overlapping classes are not flagged.
check('no overlap: not flagged', spec.hasOverlappingClasses, false);

// ── Class time outside the punch window never inflates class hours ──────────
const outside = buildDailyHoursRow({
  ...base,
  attendance: { clockIn: '10:00', clockOut: '13:00', punchCount: 2 },
  schedule: [cls('10:00', '11:00'), cls('17:00', '18:00')],
  eodDoc: null,
});
check('outside window: working', outside.workingMinutes, 180);
check('outside window: class capped to presence', outside.classMinutes, 60);
check('outside window: non-class stays positive', outside.nonClassMinutes, 120);
check('outside window: full roster still reported', outside.scheduledMinutes, 120);
check('outside window: difference explained', outside.scheduledOutsideWindowMinutes, 60);

// ── Incomplete records: flagged, never estimated ────────────────────────────
// A duplicate punch at the same minute must not be read as a punch-out.
const duplicatePunch = buildDailyHoursRow({
  ...base,
  attendance: { clockIn: '11:32', clockOut: '11:32', punchCount: 2 },
  schedule: [cls('12:00', '13:00')],
  eodDoc: null,
});
check('duplicate punch: incomplete', duplicatePunch.incomplete, true);
check('duplicate punch: missing punch-out', duplicatePunch.missingPunchOut, true);
check('duplicate punch: working is zero', duplicatePunch.workingMinutes, 0);
check('duplicate punch: class is zero', duplicatePunch.classMinutes, 0);

// An out earlier than the in is unusable, not a negative day.
const reversed = buildDailyHoursRow({
  ...base,
  attendance: { clockIn: '18:00', clockOut: '09:00', punchCount: 2 },
  schedule: [],
  eodDoc: null,
});
check('reversed pair: incomplete', reversed.incomplete, true);
check('reversed pair: working is zero', reversed.workingMinutes, 0);
check('reversed pair: non-class not negative', reversed.nonClassMinutes, 0);

// Punch-out with no punch-in.
const noIn = buildDailyHoursRow({
  ...base,
  attendance: { clockIn: null, clockOut: '18:00', punchCount: 1 },
  schedule: [cls('10:00', '11:00')],
  eodDoc: null,
});
check('missing punch-in: flagged', noIn.missingPunchIn, true);
check('missing punch-in: incomplete', noIn.incomplete, true);
check('missing punch-in: not flagged as missing punch-out', noIn.missingPunchOut, false);
check('missing punch-in: working is zero', noIn.workingMinutes, 0);
check('missing punch-in: out time still shown', noIn.outTime, '18:00');

// A complete day is not incomplete.
check('complete day: not incomplete', spec.incomplete, false);
check('complete day: no missing flags', [spec.missingPunchIn, spec.missingPunchOut], [false, false]);

// No attendance at all is absence, not an incomplete record.
const nothing = buildDailyHoursRow({ ...base, attendance: null, schedule: [], eodDoc: null });
check('no attendance: not incomplete', nothing.incomplete, false);
check('no attendance: no missing flags', [nothing.missingPunchIn, nothing.missingPunchOut], [false, false]);

// ── Missing punch-out: hours cannot be measured, so nothing is invented ─────
const noOut = buildDailyHoursRow({
  ...base,
  attendance: { clockIn: '09:30', clockOut: null, punchCount: 1 },
  schedule: [cls('10:00', '11:00')],
  eodDoc: null,
});
check('missing punch-out: flagged', noOut.missingPunchOut, true);
check('missing punch-out: working is zero', noOut.workingMinutes, 0);
check('missing punch-out: class is zero', noOut.classMinutes, 0);
check('missing punch-out: non-class is zero', noOut.nonClassMinutes, 0);
check('missing punch-out: in time still shown', noOut.inTime, '09:30');
check('missing punch-out: incomplete', noOut.incomplete, true);
check('missing punch-out: not flagged as missing punch-in', noOut.missingPunchIn, false);

// ── No punch at all ─────────────────────────────────────────────────────────
const absent = buildDailyHoursRow({
  ...base,
  attendance: null,
  schedule: [cls('10:00', '11:00')],
  eodDoc: null,
});
check('no punch: working is zero', absent.workingMinutes, 0);
check('no punch: not flagged as a missing punch-out', absent.missingPunchOut, false);
check('no punch: eod status', absent.eodStatus, 'NOT_SUBMITTED');

// ── EOD status maps the existing enum, and nothing else ─────────────────────
const eodStatus = (doc: any) =>
  buildDailyHoursRow({ ...base, attendance: null, schedule: [], eodDoc: doc }).eodStatus;
check('eod: missing document', eodStatus(null), 'NOT_SUBMITTED');
check('eod: pending', eodStatus({ status: 'pending' }), 'PENDING');
check('eod: approved', eodStatus({ status: 'approved' }), 'APPROVED');
check('eod: rejected', eodStatus({ status: 'rejected' }), 'REJECTED');
// A legacy document with no status is submitted-but-unresolved, not missing.
check('eod: absent status field reads as pending', eodStatus({}), 'PENDING');

// ── Schedule validity: today's timetable is not projected backwards ─────────
const win = scheduleWindow({ effectiveFrom: new Date(2026, 8, 1), effectiveTo: new Date(2026, 8, 30) });
check('window: from', win.from, '2026-09-01');
check('window: to', win.to, '2026-09-30');
check('applies: before start', scheduleAppliesOn(win, '2026-08-31'), false);
check('applies: on start', scheduleAppliesOn(win, '2026-09-01'), true);
check('applies: on end', scheduleAppliesOn(win, '2026-09-30'), true);
check('applies: after end', scheduleAppliesOn(win, '2026-10-01'), false);
check(
  'applies: falls back to createdAt',
  scheduleAppliesOn(scheduleWindow({ createdAt: new Date(2026, 8, 2) }), '2026-08-15'),
  false
);
check('applies: open window covers everything', scheduleAppliesOn({ from: null, to: null }, '2020-01-01'), true);

console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
