'use strict';

/**
 * Table detection and extraction from PDF page operator primitives.
 *
 * Strategy:
 *  1. Filter lines into horizontal (H) and vertical (V) groups.
 *  2. Snap nearby parallel lines to canonical positions (within SNAP px).
 *  3. Validate that H-lines span the V-range (and vice versa) → ruling lines.
 *  4. Build a (rows × cols) cell grid from the intersecting Y and X positions.
 *  5. Map text items (from getTextContent) into cells by bounding-box overlap.
 *  6. Detect header row heuristically, generate JSON + HTML output.
 */

const SNAP        = 5;   // px tolerance for grouping parallel lines
const MIN_LEN     = 18;  // px minimum length to count as a ruling line
const MIN_CELLS   = 4;   // minimum total cells (rows × cols) to be a table

// ── Line classification ───────────────────────────────────────────────────────

function isH(l) { return Math.abs(l.y1 - l.y2) <= SNAP && Math.abs(l.x2 - l.x1) >= MIN_LEN; }
function isV(l) { return Math.abs(l.x1 - l.x2) <= SNAP && Math.abs(l.y2 - l.y1) >= MIN_LEN; }

// ── Coordinate bucketing ──────────────────────────────────────────────────────

/**
 * Group nearby values (within `snap`) into a single canonical average.
 * Returns sorted canonical values.
 */
function bucket(values, snap) {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const groups = [];
  let group = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - group[group.length - 1] <= snap) {
      group.push(sorted[i]);
    } else {
      groups.push(avg(group));
      group = [sorted[i]];
    }
  }
  groups.push(avg(group));
  return groups;
}

function avg(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

// ── Text-in-cell placement ────────────────────────────────────────────────────

function inCell(item, x0, y0, x1, y1) {
  const cx = item.x + item.w * 0.5;
  const cy = item.y + item.h * 0.5;
  return cx >= x0 - SNAP && cx <= x1 + SNAP && cy >= y0 - SNAP && cy <= y1 + SNAP;
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildHtml(headers, rows) {
  const cellStyle = 'border:1px solid #d1d5db;padding:5px 8px;';
  let html = `<table style="border-collapse:collapse;width:100%;font-size:0.875rem;line-height:1.4">`;
  if (headers.some(h => h)) {
    html += '<thead><tr>' +
      headers.map(h => `<th style="${cellStyle}background:#f9fafb;font-weight:600;text-align:left">${escHtml(h)}</th>`).join('') +
      '</tr></thead>';
  }
  html += '<tbody>';
  for (const row of rows) {
    html += '<tr>' + row.map(c => `<td style="${cellStyle}">${escHtml(c)}</td>`).join('') + '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Detect and extract tables from a single page's primitives.
 *
 * @param {Array<{x1,y1,x2,y2}>}          lines     - from parsePageOperators
 * @param {Array<{str,x,y,w,h}>}           textItems - from page.getTextContent()
 * @param {number}                          pageHeight
 * @returns {Array<{bbox, headers, rows, html, caption}>}
 */
function extractTables(lines, textItems, pageHeight) {
  const hLines = lines.filter(isH);
  const vLines = lines.filter(isV);

  if (hLines.length < 2 || vLines.length < 2) return [];

  // Canonical Y-values (row separators) and X-values (column separators)
  const hYs = bucket(hLines.map(l => (l.y1 + l.y2) / 2), SNAP).sort((a, b) => a - b);
  const vXs = bucket(vLines.map(l => (l.x1 + l.x2) / 2), SNAP).sort((a, b) => a - b);

  if (hYs.length < 2 || vXs.length < 2) return [];

  const numRows = hYs.length - 1;
  const numCols = vXs.length - 1;

  if (numRows * numCols < MIN_CELLS) return [];

  // Validate: at least half the H-lines must span ≥50% of the V-range
  const vRange = vXs[vXs.length - 1] - vXs[0];
  const spanningH = hLines.filter(l => {
    const span = Math.abs(l.x2 - l.x1);
    const xMin = Math.min(l.x1, l.x2);
    return xMin <= vXs[0] + vRange * 0.4 && span >= vRange * 0.4;
  });
  if (spanningH.length < 2) return [];

  // Build grid
  const grid = Array.from({ length: numRows }, () => Array(numCols).fill(''));

  for (const item of textItems) {
    if (!item.str || !item.str.trim()) continue;
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < numCols; c++) {
        if (inCell(item, vXs[c], hYs[r], vXs[c + 1], hYs[r + 1])) {
          grid[r][c] += (grid[r][c] ? ' ' : '') + item.str.trim();
        }
      }
    }
  }

  // Drop entirely empty rows
  const nonEmpty = grid.filter(row => row.some(c => c.trim()));
  if (nonEmpty.length === 0) return [];

  // Header heuristic: first row has short cells and no sentence-ending punctuation
  const firstRow = nonEmpty[0];
  const isHeader = firstRow.some(c => c.trim()) &&
    firstRow.every(c => c.trim().length < 80 && !/[.!?]$/.test(c.trim()));

  const headers  = isHeader ? firstRow.map(c => c.trim()) : [];
  const dataRows = (isHeader ? nonEmpty.slice(1) : nonEmpty)
    .map(r => r.map(c => c.trim()))
    .filter(r => r.some(c => c));

  if (dataRows.length === 0 && headers.length === 0) return [];

  return [{
    bbox: { x: vXs[0], y: hYs[0], x2: vXs[vXs.length - 1], y2: hYs[hYs.length - 1] },
    headers,
    rows: dataRows,
    html: buildHtml(headers, dataRows),
    caption: '',
  }];
}

module.exports = { extractTables };
