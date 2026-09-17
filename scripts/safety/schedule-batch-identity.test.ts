/**
 * The timetable image is not the batch registry.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * A row reading "11th jee even" says the CLASS is 11. It does not say a batch
 * called "jee even" exists, and it must never cause one to. Batch identity
 * belongs to the organization's own `Batch` documents — the same records the
 * student forms, the schedule pickers and student assignment already use.
 *
 * ── What the importer used to do ────────────────────────────────────────────
 *     const { matched } = matchBatchLabel(batchRaw, batchCandidates);
 *     batch: matched || batchRaw
 *
 * `matchBatchLabel` is fuzzy token overlap, so "jee even" shares the token
 * "jee" with BOTH "JEE Morning" and "JEE Evening" and it returned whichever
 * scored first — a coin flip written into a real schedule in front of real
 * students. And when nothing matched, the raw image text was stored as the
 * batch outright.
 *
 * ── What is asserted here ───────────────────────────────────────────────────
 * The real resolver, the real application matcher (`matchBatchName`, the one
 * the student forms use), and the real save-time gate. The batch data is the
 * shape `getStudentBatchConfigFromDatabase()` returns, so the contract under
 * test is the application's own — no parallel batch model, no mock service.
 *
 *   npx ts-node --transpile-only scripts/safety/schedule-batch-identity.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  batchResolved,
  checkEntryBatches,
  resolveBatchForClass,
  suggestExistingBatches,
  type BatchRules,
} from '../../src/services/schedule/scheduleBatchResolver';
import { matchBatchName } from '../../src/services/batchConfigService';
import {
  parseRowLabel,
  parseTimeRangeLabel,
  splitCellText,
} from '../../src/services/scheduleImageParsers';
import { normalizeClassValue } from '../../src/config/studentBatchConfig';

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

function eq<T>(label: string, actual: T, expected: T) {
  check(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/**
 * The organization's existing batches, in the exact shape
 * `getStudentBatchConfigFromDatabase()` returns (`batchRules`). These names are
 * the ONLY names any of the assertions below will accept as an outcome.
 */
const EXISTING: BatchRules = {
  '7': [],
  '8': ['Advanced/Basic', 'JEE'],
  '9': ['Advanced/Basic', 'JEE'],
  '10': ['Advanced/Basic', 'JEE'],
  '11': ['Commerce CBSE', 'Commerce GSEB', 'JEE Evening', 'JEE Morning'],
  '12': ['Commerce CBSE', 'JEE'],
};

/** Every batch name the organization has, flattened — nothing else may appear. */
const ALL_EXISTING = new Set(Object.values(EXISTING).flat());

/** The importer's row -> (class, hint) step, exactly as the route does it. */
function readRow(label: string) {
  const parsed = parseRowLabel(label);
  const classLevel =
    normalizeClassValue(parsed.classLevel) || parsed.classLevel;
  return { classLevel, hint: parsed.batch };
}

function main() {
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n1 — the image contributes the CLASS, and only the class');
  // ══════════════════════════════════════════════════════════════════════════

  const rows: Array<[string, string]> = [
    ['7th', '7'],
    ['8th adv', '8'],
    ['8th jee', '8'],
    ['9th Adv', '9'],
    ['9th  JEE', '9'],
    ['10th adv', '10'],
    ['10th jee', '10'],
    ['11th jee morn', '11'],
    ['11th jee even', '11'],
    ['11th Comm CBSE', '11'],
    ['12th jee', '12'],
    ['12th comm cbse', '12'],
  ];
  rows.forEach(([label, expected]) => {
    eq(`"${label}" -> class ${expected}`, readRow(label).classLevel, expected);
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n2 & 3 — the rest of the row label never becomes a batch');
  // ══════════════════════════════════════════════════════════════════════════

  const even = resolveBatchForClass({
    ...readRow('11th jee even'),
    batchRules: EXISTING,
  });
  eq('"11th jee even" does NOT produce a "jee even" batch', even.batch, '');
  eq('it asks instead', even.status, 'needs-selection');
  eq(
    "and offers the class's real batches",
    even.availableBatches,
    EXISTING['11'],
  );
  check(
    'the raw hint is preserved for review',
    even.hint.toLowerCase().includes('jee even'),
    even.hint,
  );
  check(
    'JEE Evening is suggested but NOT applied',
    even.suggestions.includes('JEE Evening') && even.batch === '',
    JSON.stringify(even.suggestions),
  );

  const comm = resolveBatchForClass({
    ...readRow('11th Comm CBSE'),
    batchRules: EXISTING,
  });
  eq('"11th Comm CBSE" does NOT produce a "Comm CBSE" batch', comm.batch, '');
  eq('it asks instead', comm.status, 'needs-selection');
  eq('class is still 11', readRow('11th Comm CBSE').classLevel, '11');

  const morn = resolveBatchForClass({
    ...readRow('11th jee morn'),
    batchRules: EXISTING,
  });
  eq('"11th jee morn" does NOT produce a "jee morn" batch', morn.batch, '');

  // The single most important invariant in this file.
  [even, comm, morn].forEach((r, i) => {
    check(
      `resolution ${i} returned either nothing or an EXISTING batch`,
      r.batch === '' || ALL_EXISTING.has(r.batch),
      r.batch,
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n4 & 5 — existing batches come from the application's own map");
  // ══════════════════════════════════════════════════════════════════════════

  eq("class 11 batches are the organization's four", even.availableBatches, [
    'Commerce CBSE',
    'Commerce GSEB',
    'JEE Evening',
    'JEE Morning',
  ]);
  check(
    "every offered batch exists in the organization's data",
    even.availableBatches.every((b) => ALL_EXISTING.has(b)),
  );
  // The resolver defers to the application's matcher, not one of its own.
  eq(
    'an exact existing name resolves',
    resolveBatchForClass({
      classLevel: '11',
      hint: 'JEE Evening',
      batchRules: EXISTING,
    }).batch,
    'JEE Evening',
  );
  eq(
    'and case-insensitively, exactly as matchBatchName does',
    resolveBatchForClass({
      classLevel: '11',
      hint: 'jee evening',
      batchRules: EXISTING,
    }).batch,
    matchBatchName('jee evening', EXISTING['11']),
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log(
    '\n6 & 7 — several batches for one class is a question, not a guess',
  );
  // ══════════════════════════════════════════════════════════════════════════

  // Determinism: the same ambiguous row must never resolve differently.
  const repeats = Array.from({ length: 25 }, () =>
    resolveBatchForClass({ ...readRow('11th jee even'), batchRules: EXISTING }),
  );
  check(
    'an ambiguous row never resolves, however many times it is asked',
    repeats.every((r) => r.batch === '' && r.status === 'needs-selection'),
  );
  check(
    'and never picks one of the two JEE batches at random',
    new Set(repeats.map((r) => r.batch)).size === 1,
  );
  eq(
    'an unresolved batch is flagged for review',
    batchResolved(even.status),
    false,
  );

  // A class with exactly ONE existing batch has no ambiguity to resolve.
  const single = resolveBatchForClass({
    classLevel: '11',
    hint: 'anything at all',
    batchRules: { '11': ['JEE Morning'] },
  });
  eq(
    'one batch for the class is applied automatically',
    single.batch,
    'JEE Morning',
  );
  eq('and reported as such', single.status, 'resolved-single');
  eq('which counts as resolved', batchResolved(single.status), true);

  // A class with no batches configured is not "unresolved" — batch just does
  // not apply, and demanding a selection would block a legitimate save.
  const none = resolveBatchForClass({
    classLevel: '7',
    hint: '',
    batchRules: EXISTING,
  });
  eq('a class with no batches needs no selection', none.status, 'no-batches');
  eq('with no batch', none.batch, '');
  eq('and is treated as resolved', batchResolved(none.status), true);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n8 — nothing is created, and nothing unknown can be saved');
  // ══════════════════════════════════════════════════════════════════════════

  // The resolver is pure: it has no model import, so it CANNOT create a batch.
  const resolverSrc = readFileSync(
    join(
      process.cwd(),
      'src',
      'services',
      'schedule',
      'scheduleBatchResolver.ts',
    ),
    'utf8',
  );
  check(
    'the resolver imports no model',
    !/from '\.\.\/\.\.\/models\//.test(resolverSrc),
  );
  check(
    'and never writes',
    !/\.save\(|insertMany|findOneAndUpdate|create\(/.test(resolverSrc),
  );

  const routeSrc = readFileSync(
    join(process.cwd(), 'src', 'routes', 'api', 'scheduleRoutes.ts'),
    'utf8',
  );
  check(
    'the extractor no longer falls back to the image text',
    !routeSrc.includes('batch: matchedBatch || batchRaw'),
  );
  check(
    'and no longer fuzzy-matches batches from the image',
    !routeSrc.includes('matchBatchLabel('),
  );
  check(
    'the extractor uses the resolver',
    routeSrc.includes('resolveBatchForClass({'),
  );
  check(
    'the save path checks batches against the organization',
    routeSrc.includes('checkEntryBatches('),
  );
  // Scoped to the EXTRACTION handler, not the whole file: `POST
  // /api/schedule/batches` legitimately creates a batch, because an admin
  // typed one. The claim being pinned is narrower and is the one that matters
  // — uploading a photograph creates none.
  const extractStart = routeSrc.indexOf("'/extract-image',");
  const extractEnd = routeSrc.indexOf("router.post('/bulk/validate'");
  const extractBlock = routeSrc.slice(extractStart, extractEnd);
  check(
    'the extraction handler was located',
    extractStart > -1 && extractEnd > extractStart,
  );
  check(
    'extraction creates no Batch document',
    !/new Batch\(|Batch\.create\(|Batch\.insertMany\(|Batch\.findOneAndUpdate\(/.test(
      extractBlock,
    ),
  );
  check(
    'extraction does not write to any model',
    !/\.save\(\)|insertMany\(|findOneAndUpdate\(|updateOne\(|deleteOne\(/.test(
      extractBlock,
    ),
  );

  // The gate itself.
  const gate = checkEntryBatches(
    [
      { tempId: 'a', classLevel: '11', batch: 'jee even' },
      { tempId: 'b', classLevel: '11', batch: 'JEE Evening' },
      { tempId: 'c', classLevel: '11', batch: '' },
      { tempId: 'd', classLevel: '7', batch: '' },
      { tempId: 'e', classLevel: '11', batch: 'Commerce CBSE' },
    ],
    EXISTING,
  );
  const byId = (id: string) => gate.filter((i) => i.tempId === id);
  eq(
    'image text "jee even" is refused at save',
    byId('a')[0]?.rule,
    'batchMustExist',
  );
  eq('a real existing batch is accepted', byId('b').length, 0);
  eq(
    'an unmade choice is refused',
    byId('c')[0]?.rule,
    'batchSelectionRequired',
  );
  eq('a class with no batches needs none', byId('d').length, 0);
  eq('a second real batch is accepted', byId('e').length, 0);
  check(
    'the refusal names the real options rather than offering to create one',
    /Existing batches: /.test(byId('a')[0]?.message || '') &&
      !/creat/i.test(byId('a')[0]?.message || ''),
    byId('a')[0]?.message,
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\na class may be assigned to SEVERAL existing batches');
  // ══════════════════════════════════════════════════════════════════════════

  // Two batches of one class sharing a teacher, room and slot is a combined
  // session — valid under the schedule policy — so the selection is a list.
  // What does NOT change is where the names are allowed to come from.
  const multi = checkEntryBatches(
    [
      {
        tempId: 'm1',
        classLevel: '11',
        batches: ['JEE Morning', 'JEE Evening'],
      },
      {
        tempId: 'm2',
        classLevel: '11',
        batches: ['Commerce CBSE', 'Commerce GSEB'],
      },
      { tempId: 'm3', classLevel: '11', batches: ['JEE Morning', 'jee even'] },
      { tempId: 'm4', classLevel: '11', batches: [] },
      {
        tempId: 'm5',
        classLevel: '11',
        batch: 'JEE Morning',
        batches: ['JEE Evening'],
      },
      { tempId: 'm6', classLevel: '7', batches: [] },
    ],
    EXISTING,
  );
  const issuesFor = (id: string) => multi.filter((i) => i.tempId === id);

  eq('two real batches are accepted', issuesFor('m1').length, 0);
  eq('so are two commerce batches', issuesFor('m2').length, 0);
  eq(
    'image text alongside a real batch is still refused',
    issuesFor('m3')[0]?.rule,
    'batchMustExist',
  );
  check(
    'and the refusal names the offending one, not the valid one',
    /jee even/.test(issuesFor('m3')[0]?.message || '') &&
      !/"JEE Morning" is not/.test(issuesFor('m3')[0]?.message || ''),
    issuesFor('m3')[0]?.message,
  );
  eq(
    'an empty selection is still refused',
    issuesFor('m4')[0]?.rule,
    'batchSelectionRequired',
  );
  check(
    'and now asks for one OR MORE',
    /which one or ones/.test(issuesFor('m4')[0]?.message || ''),
    issuesFor('m4')[0]?.message,
  );
  eq(
    'the legacy single field is folded in, not fought with',
    issuesFor('m5').length,
    0,
  );
  eq('a class with no batches still needs none', issuesFor('m6').length, 0);

  // Every name in a multi-selection is checked, not only the first.
  const allBad = checkEntryBatches(
    [
      {
        tempId: 'x',
        classLevel: '11',
        batches: ['JEE Morning', 'made up', 'also fake'],
      },
    ],
    EXISTING,
  );
  eq('each invalid name is reported', allBad.length, 2);
  check(
    'and the valid one is not',
    !allBad.some((i) => /"JEE Morning"/.test(i.message)),
    JSON.stringify(allBad.map((i) => i.message)),
  );

  check(
    'the writer stores every selected batch',
    routeSrc.includes('batches: entryBatches(entry),'),
  );
  check(
    'and keeps `batch` as the first, for the queries that read the single field',
    routeSrc.includes("batch: entryBatches(entry)[0] || '',"),
  );
  check(
    'notifications reach every batch on the session, not just the first',
    routeSrc.includes('const docBatches = getScheduleBatches(doc);'),
  );
  check(
    'the conflict validator still receives the list',
    routeSrc.includes(
      'batches: Array.isArray(entry?.batches) ? entry.batches : undefined,',
    ),
  );
  check(
    'extraction emits the list form from the start',
    routeSrc.includes(
      'batches: batchResolution.batch ? [batchResolution.batch] : [],',
    ),
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log(
    '\nclearing a date removes that day, and only that day, silently',
  );
  // ══════════════════════════════════════════════════════════════════════════

  const clearBlock = routeSrc.slice(
    routeSrc.indexOf("router.delete('/date/:date'"),
    routeSrc.indexOf("router.delete('/:scheduleId'"),
  );
  check('the clear-date route exists', clearBlock.length > 0);

  // The whole reason the route exists: a day is usually cleared because it was
  // entered wrongly, and a push per removed row would tell students their real
  // classes had been cancelled.
  check(
    'it sends NO notification',
    !/notifyScheduleAudienceByBatches|sendScheduleNotification|sendTeacherNotification/.test(
      clearBlock,
    ),
  );

  // A regular slot is a weekly commitment that merely falls on this date.
  check(
    'it touches CUSTOM sessions only',
    clearBlock.includes("scheduleType: 'custom' as const"),
  );
  check(
    'so one bad day cannot cancel every future week',
    !clearBlock.includes("scheduleType: 'regular'"),
  );

  check(
    'it is scoped to the organization',
    clearBlock.includes('...tenantScope(),'),
  );
  check('admin only', clearBlock.includes("user.role !== 'admin'"));
  check('the date must be a real date', clearBlock.includes('$/.test(date)'));

  // Retire rather than erase, so a day that genuinely ran stays in history —
  // and a deactivated row blocks nothing, so the date is free to re-import.
  check(
    'it deactivates by default',
    clearBlock.includes('updateMany(scope, { $set: { isActive: false } })'),
  );
  check(
    'with a hard-delete escape hatch',
    clearBlock.includes('deleteMany(scope)'),
  );
  check('and reports how many it cleared', clearBlock.includes('cleared'));

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n9 — teacher, room and time do not depend on batch identity');
  // ══════════════════════════════════════════════════════════════════════════

  // The "11th jee even" row from the reported timetable. Its schedule must be
  // fully extracted even though its batch is undecided.
  const rowCells: Array<[string, string, number]> = [
    ['5:30-6:30PM', 'Chandan sir', 1],
    ['6:30-7:30PM', 'Chandan sir', 1],
    ['8:30-9:30PM', 'Gaurav sir', 1],
    ['9:30-10:30PM', 'Gaurav sir', 1],
  ];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  rowCells.forEach(([column, teacher, room]) => {
    const split = splitCellText(`${teacher}  ${room}`);
    const time = parseTimeRangeLabel(column);
    check(
      `${column} -> ${teacher} / room ${room}, with no batch involved`,
      split.teacherName === teacher &&
        split.roomNumber === room &&
        Boolean(time?.startTimeSlot),
      JSON.stringify({ split, time }),
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n10 — no organization context still extracts the schedule');
  // ══════════════════════════════════════════════════════════════════════════

  const noOrg = resolveBatchForClass({
    ...readRow('11th jee even'),
    batchRules: null,
  });
  eq('the batch is left open', noOrg.status, 'no-org-context');
  eq('with no batch invented', noOrg.batch, '');
  eq('and no batches offered', noOrg.availableBatches, []);
  eq(
    'the class is still read from the image',
    readRow('11th jee even').classLevel,
    '11',
  );
  check(
    'the raw hint still survives for review',
    noOrg.hint.length > 0,
    noOrg.hint,
  );
  check(
    'the route only loads batch data when an organization is present',
    routeSrc.includes(
      'orgId ? getStudentBatchConfigFromDatabase() : Promise.resolve(null)',
    ),
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n11 & 12 — isolation and existing behaviour');
  // ══════════════════════════════════════════════════════════════════════════

  // Two organizations with the same class and the same hint must resolve
  // against their OWN batches, never each other's.
  const orgA: BatchRules = { '11': ['JEE Morning', 'JEE Evening'] };
  const orgB: BatchRules = { '11': ['Physics Intensive'] };
  const a = resolveBatchForClass({
    classLevel: '11',
    hint: 'jee even',
    batchRules: orgA,
  });
  const b = resolveBatchForClass({
    classLevel: '11',
    hint: 'jee even',
    batchRules: orgB,
  });
  eq(
    'org A is asked to choose between its own two',
    a.status,
    'needs-selection',
  );
  eq('org B resolves to its own single batch', b.batch, 'Physics Intensive');
  check(
    "neither organization is ever offered the other's batches",
    !a.availableBatches.includes('Physics Intensive') &&
      !b.availableBatches.some((x) => orgA['11'].includes(x)),
  );
  check(
    'the batch gate is only applied inside an organization context',
    routeSrc.includes('if (currentOrgId()) {'),
  );

  // Existing behaviour: the subject line still reads the same when a batch IS
  // resolved, and the entry still carries everything it used to.
  eq(
    'a resolved batch still labels the subject',
    `Class 11${single.batch ? ' · ' + single.batch : ''}`,
    'Class 11 · JEE Morning',
  );
  check(
    'entries still expose the raw row hint',
    routeSrc.includes('batchHint,'),
  );
  check(
    'and the resolution status',
    routeSrc.includes('batchStatus: batchResolution.status,'),
  );
  check(
    'and the existing batch choices',
    routeSrc.includes('availableBatches: batchResolution.availableBatches,'),
  );

  // Suggestions are ordered but never authoritative.
  const sugg = suggestExistingBatches('comm cbse', EXISTING['11']);
  eq('"comm cbse" suggests Commerce CBSE first', sugg[0], 'Commerce CBSE');
  check(
    'suggestions are drawn only from existing batches',
    sugg.every((x) => ALL_EXISTING.has(x)),
  );

  console.log(
    `\n${failures ? '✗ FAILED' : '✓ PASSED'} — ${checks - failures}/${checks} checks\n`,
  );
  if (failures) process.exit(1);
}

main();
