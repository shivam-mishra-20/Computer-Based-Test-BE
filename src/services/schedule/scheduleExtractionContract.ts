/**
 * The contract between the schedule prompt and the schedule validator.
 *
 * ── The failure this module exists to make impossible ───────────────────────
 * The extraction prompt ended with a one-line JSON example showing the shape to
 * return. Its values were realistic:
 *
 *     {"columns":["3:30-4:30PM"],"rows":["9th JEE"],
 *      "cells":[{"row":"9th JEE","column":"3:30-4:30PM","rawText":"Archit sir 4"}]}
 *
 * A small vision model handed a dense 23-row timetable answered by returning
 * that example, unchanged. The result was ONE schedule entry — class 9 JEE,
 * 3:30-4:30PM, "Archit sir", room 4 — none of which came from the photograph.
 * The real cell at that coordinate reads "Abhigyan sir 8".
 *
 * Nothing downstream could catch it. The structural validator rejects a cell
 * whose row/column is not declared in its own section, and the echoed example
 * is internally consistent: it declares the row and column its single cell
 * uses. The example was also indistinguishable from real data, because the
 * institute genuinely has a "9th JEE" row and a "3:30-4:30PM" column — which is
 * exactly why the wrong answer looked like a right one.
 *
 * So the example is now written in placeholders that CANNOT occur in a
 * timetable, and this module owns both halves — the text the prompt shows and
 * the check that rejects it coming back. They live in one file so they cannot
 * drift apart, which is the only way a guard like this stays true.
 */

/** Placeholder values used in the schema example. Not transcribable text. */
export const SCHEMA_PLACEHOLDERS = {
  row: '<ROW LABEL FROM IMAGE>',
  column: '<TIME HEADER FROM IMAGE>',
  cell: '<CELL TEXT FROM IMAGE>',
} as const;

/**
 * The shape the model must return, shown with placeholders.
 *
 * Angle-bracketed and upper-case so it reads as a slot to fill rather than a
 * worked example to copy — and so `detectTemplateEcho` can recognise it with a
 * literal comparison rather than a heuristic.
 */
export const SCHEDULE_SCHEMA_EXAMPLE =
  `{"scheduleDate":"YYYY-MM-DD","sections":[{"columns":["${SCHEMA_PLACEHOLDERS.column}"],` +
  `"rows":["${SCHEMA_PLACEHOLDERS.row}"],"cells":[{"row":"${SCHEMA_PLACEHOLDERS.row}",` +
  `"column":"${SCHEMA_PLACEHOLDERS.column}","rawText":"${SCHEMA_PLACEHOLDERS.cell}"}]}],"warnings":[]}`;

/**
 * Values the OLD prompt used as its example.
 *
 * Kept so a response echoing the historical template is still recognised — a
 * cached or pinned model deployment can keep producing it, and "Archit sir 4"
 * arriving as a transcription is the single most specific signal we have that
 * the model did not read the image.
 */
const LEGACY_EXAMPLE_VALUES = {
  rows: ['9th jee'],
  columns: ['3:30-4:30pm'],
  cells: ['archit sir 4'],
};

export interface ExtractedSection {
  columns?: unknown[];
  rows?: unknown[];
  cells?: unknown[];
}

export interface ExtractedDocument {
  scheduleDate?: string;
  sections?: ExtractedSection[];
  warnings?: string[];
}

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const norm = (v: unknown) => str(v).trim().toLowerCase().replace(/\s+/g, ' ');

/** Every declared row label, column header and cell text, flattened. */
function allDeclaredValues(doc: ExtractedDocument) {
  const sections = Array.isArray(doc?.sections) ? doc.sections : [];
  const rows: string[] = [];
  const columns: string[] = [];
  const cells: string[] = [];
  for (const section of sections) {
    if (Array.isArray(section?.rows)) rows.push(...section.rows.map(str));
    if (Array.isArray(section?.columns))
      columns.push(...section.columns.map(str));
    if (Array.isArray(section?.cells)) {
      cells.push(
        ...(section.cells as Array<Record<string, unknown>>).map((c) =>
          str(c?.rawText),
        ),
      );
    }
  }
  return { sections, rows, columns, cells };
}

export type EchoReason =
  | 'placeholder-returned'
  | 'legacy-example-returned'
  | 'degenerate-grid';

/**
 * Did the model return the template instead of reading the image?
 *
 * Three tells, in order of certainty:
 *
 *   placeholder-returned    A literal `<...>` slot came back. Unambiguous — no
 *                           timetable prints that.
 *   legacy-example-returned The old prompt's worked example arrived as data.
 *   degenerate-grid         The model declared a grid too small to be a
 *                           timetable. This is not a count threshold on the
 *                           ANSWER (a sparse timetable may have one class in
 *                           it); it is a structural claim about the GRID. A
 *                           timetable has at least two time columns or at least
 *                           two class rows — a 1x1 "grid" is the shape of an
 *                           example, not of a schedule sheet.
 *
 * Returns null when the response looks like a genuine reading.
 */
export function detectTemplateEcho(doc: ExtractedDocument): EchoReason | null {
  const { sections, rows, columns, cells } = allDeclaredValues(doc);

  const placeholders = Object.values(SCHEMA_PLACEHOLDERS).map((p) =>
    p.toLowerCase(),
  );
  const hasPlaceholder = [...rows, ...columns, ...cells].some((v) => {
    const n = norm(v);
    return placeholders.includes(n) || /^<[a-z0-9 _-]+>$/i.test(n);
  });
  if (hasPlaceholder) return 'placeholder-returned';

  // The legacy example only counts as an echo when the response is ALSO the
  // degenerate shape. A real timetable containing a "9th JEE" row must never be
  // rejected merely for saying so — it is the combination of that exact cell
  // text with a one-cell grid that identifies the template.
  const looksLegacy =
    cells.some((c) => LEGACY_EXAMPLE_VALUES.cells.includes(norm(c))) &&
    rows.some((r) => LEGACY_EXAMPLE_VALUES.rows.includes(norm(r))) &&
    columns.some((c) => LEGACY_EXAMPLE_VALUES.columns.includes(norm(c)));
  if (looksLegacy && rows.length <= 1 && columns.length <= 1)
    return 'legacy-example-returned';

  if (sections.length === 0) return 'degenerate-grid';
  if (rows.length < 2 && columns.length < 2) return 'degenerate-grid';

  return null;
}

/**
 * Closure markers. A cell reading "OFF" is a statement that there is NO class.
 *
 * It was previously kept: `looksLikeScheduleCell("OFF")` sees one short word
 * with no prose markers and says yes, so every OFF box became a schedule entry
 * with a teacher literally named "OFF". Counting them separately is what lets
 * the review screen say "7 OFF cells ignored" instead of quietly inventing
 * seven classes.
 */
const OFF_CELL_RE =
  /^(?:off|--+|-|x|n\/?a|no\s*class(?:es)?|holiday|closed|leave)$/i;

export function isOffCell(rawText: string): boolean {
  return OFF_CELL_RE.test(String(rawText || '').trim());
}

export interface ExtractionSummary {
  /** Timetable grids the model reported finding. */
  sections: number;
  /** Distinct class/batch row labels across all grids. */
  rowLabels: number;
  /** Distinct time-slot column headers across all grids. */
  timeColumns: number;
  /** Grid intersections the model reported as having text. */
  populatedCells: number;
  /** Of those, closure markers, which never become entries. */
  offCells: number;
  /** Cells rejected by structural validation, with reasons in `meta.rejected`. */
  rejectedCells: number;
  /** Entries handed to the review screen. */
  entries: number;
  /** Of those, entries with at least one unresolved field. */
  needsReview: number;
  /** Entries every field of which resolved against organization master data. */
  resolved: number;
  /**
   * Entries whose batch could not be decided from the organization's existing
   * batches. Never a failure — an explicit question for the admin.
   */
  needsBatchSelection: number;
}

/**
 * Is this reading too thin to trust, given the grid the model itself declared?
 *
 * Deliberately NOT a count of entries: a quiet Sunday timetable with three
 * classes is legitimate, and blocking it would be the same class of error as
 * the bug being fixed. The question asked here is about INTERNAL CONSISTENCY —
 * the model told us how big the grid is, and then told us how much of it it
 * read. A single cell reported out of a 23x8 grid is not a quiet day; it is a
 * reading that stopped.
 */
export function extractionLooksIncomplete(summary: ExtractionSummary): boolean {
  if (summary.sections === 0) return true;
  if (summary.entries === 0) return true;
  // A grid worth more than a handful of intersections that yielded a single
  // cell has not been read — it has been sampled.
  const gridSize = summary.rowLabels * summary.timeColumns;
  if (gridSize >= 12 && summary.populatedCells <= 1) return true;
  return false;
}
