/**
 * Renders the regression fixture for schedule image extraction.
 *
 * ── Why a RENDERED fixture and not the photograph ───────────────────────────
 * The failure was reported against a screenshot of the institute's real
 * 14-09-2026 daily schedule — two stacked grids, 23 row labels, 16 column
 * headers across the two. This script reproduces that timetable's CONTENT
 * exactly (every row label, every column header, every populated cell, every
 * OFF marker, every blank) as a deterministic PNG.
 *
 * Deterministic matters more than photographic here. A checked-in photo is a
 * binary nobody can diff, re-crop or extend; this is a text file that produces
 * the same bytes on every machine, so a test that says "9th JEE / 3:30-4:30PM
 * is 'Abhigyan sir 8'" can be read and verified without opening an image
 * viewer. To run the live model against the original photograph instead, pass
 * its path to `scripts/safety/schedule-extract-probe.ts`.
 *
 *   npx ts-node --transpile-only scripts/safety/fixtures/make-schedule-fixture.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import sharp from 'sharp';

/** A grid exactly as printed: a date cell, time headers, and labelled rows. */
export interface FixtureGrid {
  date: string;
  columns: string[];
  rows: Array<{ label: string; cells: Record<string, string> }>;
}

/**
 * The source timetable, transcribed by hand from the reported screenshot.
 *
 * This object is the ANSWER KEY. The tests assert the pipeline's output against
 * it, so an error here is an error in every assertion — it is written out in
 * full, one row per line, to be proofread against the image rather than trusted.
 */
export const FIXTURE_GRIDS: FixtureGrid[] = [
  {
    date: '14-09-2026',
    columns: [
      '2:30 -3:30 PM',
      '3:30-4:30PM',
      '4:30-5:30PM',
      '5:30-6:30PM',
      '6:30-7:30PM',
      '7:30-8:30PM',
      '8:30-9:30PM',
      '9:30-10:30PM',
    ],
    rows: [
      {
        label: '7th',
        cells: {
          '3:30-4:30PM': "Dhara ma'am  11",
          '4:30-5:30PM': 'Chandan sir  11',
          '5:30-6:30PM': 'Nitish sir ss  11',
          '6:30-7:30PM': 'Prakash sir  11',
        },
      },
      {
        label: '8th adv',
        cells: {
          '3:30-4:30PM': 'Nitish sir ss  1',
          '4:30-5:30PM': 'Nitesh sir  1',
        },
      },
      {
        label: '8th jee',
        cells: {
          '3:30-4:30PM': 'Nitish sir ss  1',
          '4:30-5:30PM': 'Nitesh sir  1',
        },
      },
      { label: '8th gseb', cells: { '5:30-6:30PM': 'OFF' } },
      {
        label: '9th Adv',
        cells: {
          '3:30-4:30PM': 'Abhigyan sir  8',
          '4:30-5:30PM': 'Nitish sir ss  8',
        },
      },
      {
        label: '9th  JEE',
        cells: {
          '3:30-4:30PM': 'Abhigyan sir  8',
          '4:30-5:30PM': 'Nitish sir ss  8',
        },
      },
      { label: '9th GSEB', cells: { '3:30-4:30PM': 'OFF' } },
      {
        label: '10th adv',
        cells: {
          '3:30-4:30PM': 'Nitesh sir  9',
          '4:30-5:30PM': "Dhara ma'am  9",
        },
      },
      {
        label: '10th jee',
        cells: {
          '2:30 -3:30 PM': 'Chandan sir  4',
          '3:30-4:30PM': 'Chandan sir  4',
        },
      },
      { label: '11th jee morn', cells: {} },
      {
        label: '11th jee even',
        cells: {
          '5:30-6:30PM': 'Chandan sir  1',
          '6:30-7:30PM': 'Chandan sir  1',
          '8:30-9:30PM': 'Gaurav sir  1',
          '9:30-10:30PM': 'Gaurav sir  1',
        },
      },
      { label: '11th Comm CBSE', cells: {} },
      { label: '12th jee', cells: {} },
      { label: '11th comm GSEB', cells: {} },
      { label: '12th comm gseb', cells: {} },
      { label: '12th comm CBSE', cells: {} },
    ],
  },
  {
    date: '14-09-2026',
    columns: [
      '9.30-10.30AM',
      '10.30-11.30AM',
      '11.30-12.30PM',
      '12.30-1.30PM',
      '1.10-2.10PM',
      '2.10-3.10PM',
      '12.00-1.30PM',
      '1.30-3.00',
    ],
    rows: [
      { label: '11th jee B1', cells: {} },
      { label: '11th jee B2', cells: {} },
      {
        label: '8th morning',
        cells: { '9.30-10.30AM': 'OFF', '10.30-11.30AM': 'OFF' },
      },
      {
        label: '11th comm  morng',
        cells: {
          '9.30-10.30AM': 'OFF',
          '10.30-11.30AM': 'Test  B.ST',
          '11.30-12.30PM': 'Test   B.ST',
          '12.30-1.30PM': 'Test  B.ST',
        },
      },
      {
        label: '12th comm CBSE',
        cells: {
          '10.30-11.30AM': 'Account test',
          '11.30-12.30PM': 'Account test',
          '12.30-1.30PM': 'Account test',
          '1.10-2.10PM': 'Abhigyan sir   6',
        },
      },
      {
        label: '12th comm GSEB',
        cells: { '9.30-10.30AM': 'OFF', '10.30-11.30AM': 'OFF' },
      },
      { label: '11th comm eve', cells: {} },
    ],
  },
];

/** Cells that print a closure marker rather than an allocation. */
export const OFF_MARKER = 'OFF';

const LABEL_W = 170;
const COL_W = 172;
const ROW_H = 28;
const HEADER_H = 32;
const TITLE_H = 46;
const GAP = 22;
const PAD = 6;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderSvg(): { svg: string; width: number; height: number } {
  const width = PAD * 2 + LABEL_W + COL_W * 8;
  const gridHeights = FIXTURE_GRIDS.map(
    (g) => HEADER_H + g.rows.length * ROW_H,
  );
  const height =
    PAD * 2 +
    TITLE_H +
    gridHeights.reduce((a, b) => a + b, 0) +
    GAP * FIXTURE_GRIDS.length;

  const parts: string[] = [];
  parts.push(
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`,
  );

  // Title band, as printed across the top of the sheet.
  parts.push(
    `<rect x="${PAD}" y="${PAD}" width="${LABEL_W + COL_W * 6}" height="${TITLE_H}" fill="#c8bd95" stroke="#333" stroke-width="1"/>`,
  );
  parts.push(
    `<text x="${PAD + (LABEL_W + COL_W * 6) / 2}" y="${PAD + TITLE_H / 2 + 9}" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="bold" text-anchor="middle" fill="#111">Abhigyan Gurukul - Daily Schedule</text>`,
  );

  let y = PAD + TITLE_H + 4;

  FIXTURE_GRIDS.forEach((grid, gridIdx) => {
    const headerFill = gridIdx === 0 ? '#cfcbe8' : '#c9d4ea';
    const dateFill = gridIdx === 0 ? '#cfcbe8' : '#e8b9a8';

    // Date cell + time headers.
    parts.push(
      `<rect x="${PAD}" y="${y}" width="${LABEL_W}" height="${HEADER_H}" fill="${dateFill}" stroke="#333" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${PAD + LABEL_W / 2}" y="${y + HEADER_H / 2 + 6}" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="bold" text-anchor="middle" fill="#111">${esc(grid.date)}</text>`,
    );
    grid.columns.forEach((col, i) => {
      const x = PAD + LABEL_W + i * COL_W;
      parts.push(
        `<rect x="${x}" y="${y}" width="${COL_W}" height="${HEADER_H}" fill="${headerFill}" stroke="#333" stroke-width="1"/>`,
      );
      parts.push(
        `<text x="${x + COL_W / 2}" y="${y + HEADER_H / 2 + 6}" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="bold" text-anchor="middle" fill="#111">${esc(col)}</text>`,
      );
    });
    y += HEADER_H;

    grid.rows.forEach((row) => {
      parts.push(
        `<rect x="${PAD}" y="${y}" width="${LABEL_W}" height="${ROW_H}" fill="${gridIdx === 0 ? '#d8d2ea' : '#e4d7e8'}" stroke="#333" stroke-width="1"/>`,
      );
      parts.push(
        `<text x="${PAD + LABEL_W / 2}" y="${y + ROW_H / 2 + 5}" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="bold" text-anchor="middle" fill="#111">${esc(row.label)}</text>`,
      );
      grid.columns.forEach((col, i) => {
        const x = PAD + LABEL_W + i * COL_W;
        const text = row.cells[col] || '';
        parts.push(
          `<rect x="${x}" y="${y}" width="${COL_W}" height="${ROW_H}" fill="#ffffff" stroke="#333" stroke-width="1"/>`,
        );
        if (text) {
          parts.push(
            `<text x="${x + 6}" y="${y + ROW_H / 2 + 5}" font-family="Arial, Helvetica, sans-serif" font-size="15" fill="#111">${esc(text)}</text>`,
          );
        }
      });
      y += ROW_H;
    });

    y += GAP;
  });

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`,
    width,
    height,
  };
}

export const FIXTURE_PATH = join(__dirname, 'schedule-two-grid.png');

export async function buildFixture(): Promise<{
  path: string;
  width: number;
  height: number;
  bytes: number;
}> {
  const { svg, width, height } = renderSvg();
  const png = await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toBuffer();
  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, png);
  return { path: FIXTURE_PATH, width, height, bytes: png.length };
}

if (require.main === module) {
  buildFixture()
    .then((r) => {
      const populated = FIXTURE_GRIDS.reduce(
        (n, g) =>
          n + g.rows.reduce((m, row) => m + Object.keys(row.cells).length, 0),
        0,
      );
      const off = FIXTURE_GRIDS.reduce(
        (n, g) =>
          n +
          g.rows.reduce(
            (m, row) =>
              m +
              Object.values(row.cells).filter(
                (v) => v.trim().toUpperCase() === OFF_MARKER,
              ).length,
            0,
          ),
        0,
      );
      console.log(`wrote ${r.path}`);
      console.log(
        `  ${r.width}x${r.height}px, ${(r.bytes / 1024).toFixed(1)} KB`,
      );
      console.log(`  grids: ${FIXTURE_GRIDS.length}`);
      console.log(
        `  rows:  ${FIXTURE_GRIDS.reduce((n, g) => n + g.rows.length, 0)}`,
      );
      console.log(
        `  cols:  ${FIXTURE_GRIDS.reduce((n, g) => n + g.columns.length, 0)}`,
      );
      console.log(
        `  populated cells: ${populated} (of which OFF: ${off}, allocations: ${populated - off})`,
      );
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
