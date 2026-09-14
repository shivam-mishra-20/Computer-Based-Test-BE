/**
 * Schedule image extraction — the 14-09-2026 two-grid timetable.
 *
 * ── The failure this locks down ─────────────────────────────────────────────
 * A two-grid timetable — 23 class rows, 16 time columns across the two grids,
 * 34 filled cells — produced exactly ONE schedule entry, and that entry was
 * fabricated: "9th JEE / 3:30-4:30PM / Archit sir / room 4" when the printed
 * cell reads "Abhigyan sir  8".
 *
 * Those three values were not a misreading. They were the prompt's own worked
 * example, returned verbatim. See `scheduleExtractionContract.ts`.
 *
 * ── What runs here ──────────────────────────────────────────────────────────
 * The real parsers, the real contract, the real image preparation, and the real
 * validation pipeline, against a fixture that reproduces the reported timetable
 * cell for cell (`fixtures/make-schedule-fixture.ts` — the answer key is a
 * readable TypeScript object, not an opaque binary).
 *
 * The VISION MODEL is not called. It is non-deterministic — the same request at
 * temperature 0 was measured converging in 38s on one run and looping to the
 * token ceiling on the next — so asserting on its output would produce a test
 * that fails for reasons unrelated to the code under test. What is asserted
 * instead is everything the codebase actually controls: that the full frame is
 * what gets sent, that a template echo is refused, that OFF is ignored, and
 * that a correct transcription becomes the correct entries. To exercise the
 * live model, run `scripts/safety/schedule-extract-probe.ts`.
 *
 *   npx ts-node --transpile-only scripts/safety/schedule-extraction.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import {
  prepareScheduleImageForVision,
  visionImageDiagnostics,
  MIN_WIDTH,
} from '../../src/services/schedule/scheduleImagePrep';
import {
  SCHEDULE_SCHEMA_EXAMPLE,
  SCHEMA_PLACEHOLDERS,
  detectTemplateEcho,
  extractionLooksIncomplete,
  isOffCell,
} from '../../src/services/schedule/scheduleExtractionContract';
import {
  looksLikeScheduleCell,
  matchTeacherName,
  parseRowLabel,
  parseTimeRangeLabel,
  splitCellText,
} from '../../src/services/scheduleImageParsers';
import {
  FIXTURE_GRIDS,
  FIXTURE_PATH,
  OFF_MARKER,
  buildFixture,
} from './fixtures/make-schedule-fixture';

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
 * The model's job, performed perfectly.
 *
 * Turns the fixture's answer key into the exact JSON a correct transcription
 * would produce. Everything downstream of the model is then exercised for real
 * — which is where every bug in this report actually lived.
 */
function perfectTranscription() {
  return {
    scheduleDate: '2026-09-14',
    sections: FIXTURE_GRIDS.map((grid) => ({
      columns: grid.columns.slice(),
      rows: grid.rows.map((r) => r.label),
      cells: grid.rows.flatMap((row) =>
        Object.entries(row.cells).map(([column, rawText]) => ({
          row: row.label,
          column,
          rawText,
        })),
      ),
    })),
    warnings: [] as string[],
  };
}

/** The teachers the institute actually has, as `User.find({role:'teacher'})` returns them. */
const TEACHERS = [
  { id: 't1', name: 'Abhigyan' },
  { id: 't2', name: 'Chandan' },
  { id: 't3', name: 'Nitesh' },
  { id: 't4', name: 'Nitish' },
  { id: 't5', name: 'Dhara' },
  { id: 't6', name: 'Prakash' },
  { id: 't7', name: 'Gaurav' },
];

async function main() {
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nthe fixture is the reported timetable');
  // ══════════════════════════════════════════════════════════════════════════

  await buildFixture();
  check('fixture renders', existsSync(FIXTURE_PATH));

  eq('two stacked grids', FIXTURE_GRIDS.length, 2);
  const totalRows = FIXTURE_GRIDS.reduce((n, g) => n + g.rows.length, 0);
  const totalCols = FIXTURE_GRIDS.reduce((n, g) => n + g.columns.length, 0);
  const filled = FIXTURE_GRIDS.reduce(
    (n, g) => n + g.rows.reduce((m, r) => m + Object.keys(r.cells).length, 0),
    0,
  );
  const offs = FIXTURE_GRIDS.reduce(
    (n, g) =>
      n +
      g.rows.reduce(
        (m, r) =>
          m +
          Object.values(r.cells).filter((v) => v.trim() === OFF_MARKER).length,
        0,
      ),
    0,
  );
  check('many class rows', totalRows > 10, String(totalRows));
  check('many time columns', totalCols > 10, String(totalCols));
  check('many filled cells', filled > 10, String(filled));
  check('and some OFF markers', offs > 0, String(offs));
  eq(
    'the reported cell is in the fixture',
    FIXTURE_GRIDS[0].rows.find((r) => /9th\s+JEE/i.test(r.label))?.cells[
      '3:30-4:30PM'
    ],
    'Abhigyan sir  8',
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n1 — the model receives the WHOLE image, upright and legible');
  // ══════════════════════════════════════════════════════════════════════════

  const bytes = readFileSync(FIXTURE_PATH);
  const prepared = await prepareScheduleImageForVision(bytes);
  const diag = visionImageDiagnostics(prepared);

  eq('nothing failed in preparation', diag.normalizeError, null);
  check(
    'the source is measurable',
    prepared.source.width > 0 && prepared.source.height > 0,
    JSON.stringify(prepared.source),
  );
  check(
    'the FULL frame is sent — aspect ratio preserved, so no crop and no tiling',
    diag.fullFrame,
    `${diag.sourceSize} -> ${diag.sentSize}`,
  );
  check(
    'a dense grid is sent at a width the model can read',
    prepared.sent.width >= MIN_WIDTH,
    `${prepared.sent.width}px`,
  );
  check(
    'a real image type is declared',
    /^image\/(png|jpeg|webp)$/.test(prepared.mimeType),
    prepared.mimeType,
  );
  check(
    'bytes actually change hands',
    prepared.buffer.length > 1000,
    String(prepared.buffer.length),
  );
  // Both grids survive: the sent height/width ratio still covers the second
  // grid's rows, which a top-crop would have removed.
  check(
    'the sent image is tall enough to still contain both grids',
    prepared.sent.height / prepared.sent.width > 0.3,
    `${diag.sentSize}`,
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n4 — the prompt example can no longer be mistaken for data');
  // ══════════════════════════════════════════════════════════════════════════

  check(
    'the schema example contains no transcribable text',
    !/archit|9th jee|3:30-4:30pm/i.test(SCHEDULE_SCHEMA_EXAMPLE),
    SCHEDULE_SCHEMA_EXAMPLE,
  );
  check(
    'every example value is an angle-bracketed slot',
    Object.values(SCHEMA_PLACEHOLDERS).every((p) =>
      SCHEDULE_SCHEMA_EXAMPLE.includes(p),
    ),
  );

  // The exact response that caused the incident.
  const legacyEcho = {
    scheduleDate: '2026-09-14',
    sections: [
      {
        columns: ['3:30-4:30PM'],
        rows: ['9th JEE'],
        cells: [
          { row: '9th JEE', column: '3:30-4:30PM', rawText: 'Archit sir 4' },
        ],
      },
    ],
  };
  eq(
    'the ORIGINAL bad response is refused',
    detectTemplateEcho(legacyEcho),
    'legacy-example-returned',
  );

  const placeholderEcho = {
    sections: [
      {
        columns: [SCHEMA_PLACEHOLDERS.column],
        rows: [SCHEMA_PLACEHOLDERS.row],
        cells: [
          {
            row: SCHEMA_PLACEHOLDERS.row,
            column: SCHEMA_PLACEHOLDERS.column,
            rawText: SCHEMA_PLACEHOLDERS.cell,
          },
        ],
      },
    ],
  };
  eq(
    'the NEW template coming back is refused',
    detectTemplateEcho(placeholderEcho),
    'placeholder-returned',
  );

  eq(
    'a 1x1 grid is refused as structurally impossible for a timetable',
    detectTemplateEcho({
      sections: [
        {
          columns: ['9-10AM'],
          rows: ['11th'],
          cells: [{ row: '11th', column: '9-10AM', rawText: 'X sir 2' }],
        },
      ],
    }),
    'degenerate-grid',
  );
  eq(
    'an empty response is refused',
    detectTemplateEcho({ sections: [] }),
    'degenerate-grid',
  );

  // ...and the guard must not fire on the real thing.
  eq(
    'a correct reading of this timetable is NOT refused',
    detectTemplateEcho(perfectTranscription()),
    null,
  );
  // A genuine timetable that really does contain a "9th JEE" row must survive,
  // or the guard would be worse than the bug.
  eq(
    'a real grid containing a 9th JEE row is NOT refused',
    detectTemplateEcho({
      sections: [
        {
          columns: ['3:30-4:30PM', '4:30-5:30PM'],
          rows: ['9th JEE', '10th adv'],
          cells: [
            { row: '9th JEE', column: '3:30-4:30PM', rawText: 'Archit sir 4' },
          ],
        },
      ],
    }),
    null,
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n3 & 5 — a correct transcription yields the whole timetable');
  // ══════════════════════════════════════════════════════════════════════════

  const doc = perfectTranscription();
  const result = runValidationPipeline(doc);

  eq('both grids are detected', result.summary.sections, 2);
  eq('every class row is detected', result.summary.rowLabels, totalRows);
  eq('every time column is detected', result.summary.timeColumns, totalCols);
  eq('every filled cell is seen', result.summary.populatedCells, filled);
  eq('OFF cells are counted', result.summary.offCells, offs);
  eq(
    'and OFF cells produce no entries',
    result.entries.filter((e: any) => /^off$/i.test(e.teacherName)).length,
    0,
  );
  check(
    'far more than one entry is produced',
    result.entries.length > 1,
    String(result.entries.length),
  );
  eq(
    'every non-OFF filled cell becomes an entry',
    result.entries.length,
    filled - offs,
  );
  check(
    'blank cells produce nothing',
    result.summary.populatedCells === filled,
    String(result.summary.populatedCells),
  );
  eq(
    'this reading is NOT flagged incomplete',
    extractionLooksIncomplete(result.summary),
    false,
  );

  // Entries come from BOTH grids, not just the first.
  const bySection = [0, 1].map(
    (i) =>
      result.entries.filter((e: any) => e.source.sectionIndex === i).length,
  );
  check('grid 1 contributes entries', bySection[0] > 0, String(bySection[0]));
  check('grid 2 contributes entries', bySection[1] > 0, String(bySection[1]));

  // Each grid keeps its OWN time axis — grid 2's morning columns must never be
  // read against grid 1's afternoon headers.
  const morning = result.entries.filter(
    (e: any) => e.source.sectionIndex === 1 && e.startTimeSlot,
  );
  check(
    "grid 2's entries carry morning times, not grid 1's",
    morning.length > 0 && morning.every((e: any) => e.startTimeSlot < '15:00'),
    JSON.stringify(
      morning
        .slice(0, 3)
        .map((e: any) => [e.source.columnLabel, e.startTimeSlot]),
    ),
  );

  // Non-teacher cell content survives rather than being discarded.
  const tests = result.entries.filter((e: any) =>
    /test/i.test(e.source.rawText),
  );
  check(
    '"Test B.ST" / "Account test" cells are kept',
    tests.length >= 6,
    String(tests.length),
  );
  check(
    'and are flagged for review rather than resolved to a teacher',
    tests.every((e: any) => e.needsReview),
    JSON.stringify(tests.slice(0, 2)),
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n4 — the reported cell resolves to what is printed');
  // ══════════════════════════════════════════════════════════════════════════

  const target = result.entries.find(
    (e: any) =>
      /9th\s+JEE/i.test(e.source.rowLabel) &&
      e.source.columnLabel === '3:30-4:30PM',
  );
  check(
    'the 9th JEE / 3:30-4:30PM entry exists',
    Boolean(target),
    'entry missing entirely',
  );
  if (target) {
    eq(
      'its raw cell text is preserved verbatim',
      target.source.rawText,
      'Abhigyan sir  8',
    );
    eq('the teacher is Abhigyan', target.teacherName, 'Abhigyan');
    eq('the room is 8', target.roomNumber, 8);
    eq('the class is 9', target.classLevel, '9');
    eq('the time is 15:30', target.startTimeSlot, '15:30');
    eq('to 16:30', target.endTimeSlot, '16:30');
    check(
      'it is NOT "Archit sir"',
      !/archit/i.test(target.teacherName),
      target.teacherName,
    );
    check(
      'it is NOT room 4',
      target.roomNumber !== 4,
      String(target.roomNumber),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n4 — an unknown teacher is preserved, never substituted');
  // ══════════════════════════════════════════════════════════════════════════

  // The specific substitution that must be impossible: a name the institute
  // does not have must not become a different, real teacher.
  const unknown = matchTeacherName('Abhigyan sir', [
    { id: 'x', name: 'Archit' },
  ]);
  eq('an unmatched name resolves to no teacher id', unknown.id, null);
  eq('and keeps the printed text', unknown.name, 'Abhigyan sir');

  const ambiguous = matchTeacherName('Nitish sir', [
    { id: 'a', name: 'Nitish Kumar' },
    { id: 'b', name: 'Nitish Sharma' },
  ]);
  eq('two equally-good matches resolve to neither', ambiguous.id, null);
  eq('and are reported ambiguous', ambiguous.ambiguous, true);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n8 — an incomplete reading is detectable, a sparse one is not');
  // ══════════════════════════════════════════════════════════════════════════

  const base = {
    sections: 1,
    rowLabels: 23,
    timeColumns: 8,
    populatedCells: 1,
    offCells: 0,
    rejectedCells: 0,
    entries: 1,
    needsReview: 0,
    resolved: 1,
  };
  eq(
    'one cell out of a 23x8 grid is incomplete',
    extractionLooksIncomplete(base),
    true,
  );
  eq(
    'but a genuinely quiet day is NOT blocked',
    extractionLooksIncomplete({
      ...base,
      rowLabels: 3,
      timeColumns: 2,
      populatedCells: 1,
    }),
    false,
  );
  eq(
    'zero entries is incomplete',
    extractionLooksIncomplete({ ...base, entries: 0 }),
    true,
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nOFF markers, and only OFF markers');
  // ══════════════════════════════════════════════════════════════════════════

  ['OFF', 'off', ' Off ', '-', '--', 'No class', 'holiday'].forEach((t) =>
    check(`"${t}" is a closure marker`, isOffCell(t)),
  );
  ['Abhigyan sir 8', 'Test B.ST', 'Account test', 'Officer sir 3', ''].forEach(
    (t) => check(`"${t}" is NOT a closure marker`, !isOffCell(t)),
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nblank cells the model volunteers are dropped, not counted');
  // ══════════════════════════════════════════════════════════════════════════

  // Measured live: this model lists empty intersections alongside filled ones
  // (33 of 55 cells in one run carried `rawText: ""`). They must not inflate
  // the completeness summary the admin is being asked to trust.
  const withBlanks = perfectTranscription();
  withBlanks.sections[0].cells.push(
    { row: '12th jee', column: '3:30-4:30PM', rawText: '' },
    { row: '12th jee', column: '4:30-5:30PM', rawText: '   ' },
  );
  const blankResult = runValidationPipeline(withBlanks);
  eq(
    'blank cells do not count as populated',
    blankResult.summary.populatedCells,
    filled,
  );
  eq(
    'blank cells produce no entries',
    blankResult.entries.length,
    filled - offs,
  );
  eq(
    'and are not reported as rejections',
    blankResult.summary.rejectedCells,
    0,
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nthe mirrored pipeline has not drifted from the route');
  // ══════════════════════════════════════════════════════════════════════════

  // `runValidationPipeline` reproduces logic that lives inside the route
  // handler and cannot be imported without Express, Mongo and Redis. A mirror
  // that drifts is a test that proves nothing, so the load-bearing lines are
  // checked against the route SOURCE. The dedup key especially: omitting
  // `batch` from it here is exactly what made this suite report a missing
  // "9th JEE" entry that the route does in fact produce.
  const routeSrc = readFileSync(
    join(process.cwd(), 'src', 'routes', 'api', 'scheduleRoutes.ts'),
    'utf8',
  );
  const has = (needle: string) => routeSrc.includes(needle);

  check(
    'the route dedups on class|batch|start|end|teacher|room',
    has(
      '${entry.classLevel}|${entry.batch}|${entry.startTimeSlot}|${entry.endTimeSlot}|${entry.teacherId}|${entry.roomNumber}',
    ),
  );
  check(
    'the route skips OFF cells before building an entry',
    has('if (isOffCell(rawText)) {'),
  );
  check('the route counts them', has('offCellCount += 1;'));
  check(
    'the route counts only non-blank cells as populated',
    has('populatedCellCount += 1;'),
  );
  check(
    'the route excludes blanks from the rejection count',
    has("rejected.filter((r) => r.reason !== 'blank cell')"),
  );
  check(
    'the route rejects template echoes',
    has('detectTemplateEcho(parsed as any)'),
  );
  check(
    'the route sends the prepared full frame',
    has('prepareScheduleImageForVision(req.file.buffer)'),
  );
  check(
    'the route logs the image measurements',
    has('visionImageDiagnostics(prepared)'),
  );
  check(
    'the route reports a summary',
    has('const summary: ExtractionSummary = {'),
  );
  check(
    'the route flags an incomplete reading',
    has('extractionLooksIncomplete(summary)'),
  );
  check(
    'entries carry their source evidence',
    has('sectionIndex: opts.sectionIndex,'),
  );
  check(
    'the prompt no longer contains a transcribable example',
    !has('Archit sir 4'),
  );

  console.log(
    `\n${failures ? '✗ FAILED' : '✓ PASSED'} — ${checks - failures}/${checks} checks\n`,
  );
  if (failures) process.exit(1);
}

/**
 * The route's validation pipeline, in the same order and with the same rules.
 *
 * It lives inside the route handler, so it cannot be imported without booting
 * Express, Mongo and Redis. This mirrors it — and `schedule-pipeline-parity`
 * below asserts against the route SOURCE that the mirror has not drifted from
 * the original.
 */
function runValidationPipeline(doc: any) {
  const entries: any[] = [];
  const rejected: any[] = [];
  let populatedCells = 0;
  let offCells = 0;
  const rowLabels = new Set<string>();
  const columnLabels = new Set<string>();
  const seen = new Set<string>();
  const seenResolved = new Set<string>();

  const normalize = (s: string) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  (doc.sections || []).forEach((section: any, sectionIdx: number) => {
    const declaredRows: string[] = (section.rows || []).map((r: any) =>
      String(r ?? ''),
    );
    const declaredColumns: string[] = (section.columns || []).map((c: any) =>
      String(c ?? ''),
    );
    declaredRows.forEach((r) => rowLabels.add(`${sectionIdx}|${normalize(r)}`));
    declaredColumns.forEach((c) =>
      columnLabels.add(`${sectionIdx}|${normalize(c)}`),
    );

    const rowByNorm = new Map(declaredRows.map((r) => [normalize(r), r]));
    const columnByNorm = new Map(declaredColumns.map((c) => [normalize(c), c]));

    (section.cells || []).forEach((cell: any) => {
      const matchedRow = rowByNorm.get(normalize(cell?.row));
      const matchedColumn = columnByNorm.get(normalize(cell?.column));
      const rawText = String(cell?.rawText ?? '');

      if (!matchedRow || !matchedColumn) {
        rejected.push({ reason: 'undeclared coordinate', rawText });
        return;
      }
      if (!rawText.trim()) {
        rejected.push({ reason: 'blank', rawText });
        return;
      }
      populatedCells += 1;
      const key = `${sectionIdx}|${normalize(matchedRow)}|${normalize(matchedColumn)}`;
      if (seen.has(key)) {
        rejected.push({ reason: 'duplicate', rawText });
        return;
      }
      if (isOffCell(rawText)) {
        offCells += 1;
        return;
      }
      if (!looksLikeScheduleCell(rawText)) {
        rejected.push({ reason: 'announcement', rawText });
        return;
      }
      seen.add(key);

      const rowParsed = parseRowLabel(matchedRow);
      const columnParsed = parseTimeRangeLabel(matchedColumn);
      const split = splitCellText(rawText);
      const teacherRaw = split.teacherName
        .replace(/[\s,\-–—]*\d{1,2}\s*$/, '')
        .trim();
      const matched = matchTeacherName(teacherRaw, TEACHERS);

      const uncertain = new Set<string>();
      if (!teacherRaw || !matched.id || matched.ambiguous)
        uncertain.add('teacherName');
      if (split.roomNumber === null) uncertain.add('roomNumber');
      if (!columnParsed) {
        uncertain.add('startTimeSlot');
      } else if (columnParsed.assumedMeridiem) {
        uncertain.add('startTimeSlot');
      }
      if (rowParsed.needsReview) uncertain.add('classLevel');

      const entry = {
        classLevel: rowParsed.classLevel,
        // The batch is part of a slot's identity. Two rows of the same class
        // ("9th Adv" and "9th JEE") legitimately run the same teacher in the
        // same room at the same time as one combined session — the institute's
        // schedule policy treats that as valid — so the dedup key MUST carry
        // the batch, or one of the two rows silently disappears.
        batch: rowParsed.batch,
        startTimeSlot: columnParsed?.startTimeSlot || '',
        endTimeSlot: columnParsed?.endTimeSlot || '',
        roomNumber: split.roomNumber,
        teacherId: matched.id || '',
        teacherName: matched.name || teacherRaw,
        needsReview: uncertain.size > 0,
        uncertainFields: Array.from(uncertain),
        source: {
          sectionIndex: sectionIdx,
          rowLabel: matchedRow,
          columnLabel: matchedColumn,
          rawText,
          teacherRaw,
          status: uncertain.size === 0 ? 'resolved' : 'needs-review',
        },
      };

      const fullyResolved = Boolean(
        entry.startTimeSlot && entry.endTimeSlot && entry.teacherId,
      );
      const resolvedKey = fullyResolved
        ? `${entry.classLevel}|${entry.batch}|${entry.startTimeSlot}|${entry.endTimeSlot}|${entry.teacherId}|${entry.roomNumber}`
        : `coord:${key}`;
      if (seenResolved.has(resolvedKey)) {
        rejected.push({ reason: 'duplicate resolved slot', rawText });
        return;
      }
      seenResolved.add(resolvedKey);
      entries.push(entry);
    });
  });

  return {
    entries,
    rejected,
    summary: {
      sections: (doc.sections || []).length,
      rowLabels: rowLabels.size,
      timeColumns: columnLabels.size,
      populatedCells,
      offCells,
      rejectedCells: rejected.filter((r) => r.reason !== 'blank').length,
      entries: entries.length,
      needsReview: entries.filter((e) => e.needsReview).length,
      resolved: entries.filter((e) => !e.needsReview).length,
    },
  };
}

main().catch((err) => {
  console.error('\nharness error:', err);
  process.exit(1);
});
