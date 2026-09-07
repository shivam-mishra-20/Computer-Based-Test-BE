/**
 * Regression checks for the schedule-image deterministic parsers.
 *
 *     npx ts-node --transpile-only src/scripts/verify_schedule_parsers.ts
 *
 * No database, no AI, no framework. Every case below was observed to FAIL
 * before the fix, or is a guard against re-breaking something that worked.
 *
 * These parsers decide, silently, whether a real class reaches the admin's
 * review screen. Three of them used to delete work without saying so:
 *   - looksLikeScheduleCell dropped any 4+ word allocation
 *   - parseRowLabel dropped EVERY cell in a row whose heading had no leading number
 *   - parseTimeRangeLabel rejected 6 of 14 real header formats, and the empty
 *     times that produced then collided under the caller's duplicate guard
 * so they are pinned here.
 */
import {
  looksLikeScheduleCell,
  matchTeacherName,
  parseRowLabel,
  parseTimeRangeLabel,
  splitCellText,
} from '../services/scheduleImageParsers';

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

const time = (label: string) => {
  const p = parseTimeRangeLabel(label);
  return p ? `${p.startTimeSlot}-${p.endTimeSlot}${p.assumedMeridiem ? ' (assumed)' : ''}` : null;
};

// ── parseTimeRangeLabel — formats that used to be rejected ──────────────────
console.log('\n-- time headers that already worked (must not regress) --');
check('trailing PM, no spaces', time('3:30-4:30PM'), '15:30-16:30');
check('crosses noon', time('11:30-12:30PM'), '11:30-12:30');
check('morning AM', time('8:00-9:30 AM'), '08:00-09:30');
check('noon start', time('12:30-1:30 PM'), '12:30-13:30');
check('dotted minutes', time('3.30 - 4.30 pm'), '15:30-16:30');
check('en dash', time('3:30–4:30 PM'), '15:30-16:30');

console.log('\n-- formats that USED TO RETURN null (the collision trigger) --');
check('24-hour clock', time('15:30-16:30'), '15:30-16:30');
check('meridiem on both ends', time('3:30PM-4:30PM'), '15:30-16:30');
check('"to" separator', time('3:30 to 4:30 PM'), '15:30-16:30');
check('hour only', time('3-4 PM'), '15:00-16:00');
check('dotted P.M.', time('03:30-04:30 P.M.'), '15:30-16:30');
// No meridiem at all is genuinely ambiguous - parsed on the institute clock
// and flagged, rather than dropped.
check('bare range, afternoon', time('3:30-4:30'), '15:30-16:30 (assumed)');
check('bare range, morning', time('9:00-10:00'), '09:00-10:00 (assumed)');
check('bare range across noon', time('11:30-12:30'), '11:30-12:30 (assumed)');

console.log('\n-- non-times must still be rejected --');
check('not a time', parseTimeRangeLabel('Lunch Break'), null);
check('empty', parseTimeRangeLabel(''), null);
check('single time', parseTimeRangeLabel('3:30 PM'), null);
check('absurd span rejected', parseTimeRangeLabel('9:00 AM - 8:00 PM'), null);

// ── parseRowLabel — must never delete a row ────────────────────────────────
console.log('\n-- row labels that already worked --');
check('8th adv', parseRowLabel('8th adv'), { classLevel: '8', batch: 'adv', needsReview: false });
check('11th JEE B1', parseRowLabel('11th JEE B1'), { classLevel: '11', batch: 'JEE B1', needsReview: false });
check('bare 7th', parseRowLabel('7th'), { classLevel: '7', batch: '', needsReview: false });

console.log('\n-- row labels that USED TO DROP THE ENTIRE ROW --');
check('Class 10', parseRowLabel('Class 10'), { classLevel: '10', batch: '', needsReview: false });
check('JEE 11th', parseRowLabel('JEE 11th'), { classLevel: '11', batch: 'JEE', needsReview: false });
check('Std. 9 B1', parseRowLabel('Std. 9 B1'), { classLevel: '9', batch: 'B1', needsReview: false });
check('Foundation', parseRowLabel('Foundation'), { classLevel: '', batch: 'Foundation', needsReview: true });
check('NEET Dropper', parseRowLabel('NEET Dropper'), { classLevel: '', batch: 'NEET Dropper', needsReview: true });
check('Batch A', parseRowLabel('Batch A'), { classLevel: '', batch: 'Batch A', needsReview: true });

// ── looksLikeScheduleCell — keep allocations, drop announcements ───────────
console.log('\n-- allocations that USED TO BE DROPPED as "announcements" --');
check('name + two-word subject', looksLikeScheduleCell('Nitesh Thakur Organic Chemistry'), true);
check('name + subject', looksLikeScheduleCell('Soniya Arora Physical Chemistry'), true);
check('name + subject + batch', looksLikeScheduleCell('Abir Chatterjee Maths Adv'), true);
check('long allocation', looksLikeScheduleCell('Archit Kanajariya Inorganic Chemistry Batch B1'), true);

console.log('\n-- allocations that already worked --');
check('honorific + room', looksLikeScheduleCell('Harsh sir 3'), true);
check('note + room', looksLikeScheduleCell('Archit sir extra class 6'), true);
check('bare name', looksLikeScheduleCell('Garima'), true);

console.log('\n-- announcements must still be rejected --');
check('notice', looksLikeScheduleCell('All students please bring your notebooks'), false);
check('cancellation', looksLikeScheduleCell('No class today'), false);
check('holiday', looksLikeScheduleCell('Holiday'), false);
check('prose', looksLikeScheduleCell('Test on Monday. Prepare well.'), false);
check('empty cell', looksLikeScheduleCell('   '), false);

// ── splitCellText ─────────────────────────────────────────────────────────
console.log('\n-- cell splitting --');
check('trailing room', splitCellText('Harsh sir 3'), { teacherName: 'Harsh sir', roomNumber: 3, note: '' });
check('note + room', splitCellText('Archit sir extra class 6'), { teacherName: 'Archit sir', roomNumber: 6, note: 'Extra Class' });
check('no room', splitCellText('Dhara Goswami'), { teacherName: 'Dhara Goswami', roomNumber: null, note: '' });
// "Room 3" written before the name used to leave the word "Room" in the name.
check('labelled room first', splitCellText('Room 3 Harsh sir'), { teacherName: 'Harsh sir', roomNumber: 3, note: '' });
check('out-of-range room kept in name', splitCellText('Nitesh sir 15'), { teacherName: 'Nitesh sir 15', roomNumber: null, note: '' });

// ── matchTeacherName — the REAL production roster ─────────────────────────
const ROSTER = ['Dhara Goswami', 'Shivam mishra', 'Chandan Kumar', 'Abhigyan Gautam', 'Teacher',
  'Harsh Sharma', 'Gaurav Mishra', 'Princy parashar', 'Rajveer thakur', 'Abir Chatterjee',
  'Soniya Arora', 'Garima', 'Kedar pathak', 'Nitesh Thakur', 'Archit Kanajariya', 'Riya Kadam',
  'Pratyaksha Acharya'].map((name, i) => ({ id: 'id' + i, name }));

console.log('\n-- honorific cells resolve against the real roster --');
const named = (raw: string) => {
  const m = matchTeacherName(raw, ROSTER);
  return m.id ? m.name : (m.ambiguous ? 'AMBIGUOUS' : 'NO MATCH');
};
check('Harsh sir', named('Harsh sir'), 'Harsh Sharma');
check('Archit sir', named('Archit sir'), 'Archit Kanajariya');
check("Dhara ma'am", named("Dhara ma'am"), 'Dhara Goswami');
check('Kedar sir', named('Kedar sir'), 'Kedar pathak');
// Surname-only is genuinely ambiguous here (two Thakurs, two Mishras) and must
// stay flagged rather than guessed.
check('surname only stays ambiguous', named('Thakur sir'), 'AMBIGUOUS');
check('unknown stays unmatched', named('Someone Else'), 'NO MATCH');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
