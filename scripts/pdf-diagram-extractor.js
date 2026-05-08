'use strict';

/**
 * Diagram/figure detection and SVG extraction from PDF page primitives.
 *
 * Strategy:
 *  1. Embedded raster images (paintImageXObject) → always a diagram region.
 *  2. Vector graphics outside known table regions:
 *     - Detect clusters of path operations not matching a grid pattern.
 *     - Diagrams signal: ≥2 Bezier curves OR ≥2 diagonal (non-orthogonal) lines.
 *  3. Reconstruct vector regions as inline SVG from path primitives.
 *     The SVG viewBox is set to the bounding box of the detected region.
 */

const MIN_POINTS  = 8;   // minimum path endpoint count for a vector region
const MIN_DIM     = 40;  // minimum px dimension for a valid region
const PAD         = 8;   // padding around detected bounding box

// ── Geometry helpers ──────────────────────────────────────────────────────────

function getBbox(points) {
  if (!points.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { x, y } of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX - PAD, y: minY - PAD, x2: maxX + PAD, y2: maxY + PAD };
}

function ptInBbox({ x, y }, bbox) {
  return x >= bbox.x - PAD && x <= bbox.x2 + PAD &&
         y >= bbox.y - PAD && y <= bbox.y2 + PAD;
}

// ── SVG builder ───────────────────────────────────────────────────────────────

/**
 * Build an inline SVG string from lines and curves clipped to a bounding box.
 * Lines and curves outside the bbox (or inside table regions) are excluded.
 */
function buildSVG(lines, curves, bbox, tableBboxes) {
  const W = Math.round(bbox.x2 - bbox.x);
  const H = Math.round(bbox.y2 - bbox.y);
  if (W <= 0 || H <= 0) return null;

  const ox = bbox.x;
  const oy = bbox.y;
  const inTable = (p) => tableBboxes.some(t => ptInBbox(p, t));

  let d = '';

  for (const l of lines) {
    const p1 = { x: l.x1, y: l.y1 };
    const p2 = { x: l.x2, y: l.y2 };
    if (inTable(p1) && inTable(p2)) continue; // skip table border lines
    if (!ptInBbox(p1, bbox) && !ptInBbox(p2, bbox)) continue;
    d += `M${(l.x1 - ox).toFixed(1)} ${(l.y1 - oy).toFixed(1)}` +
         `L${(l.x2 - ox).toFixed(1)} ${(l.y2 - oy).toFixed(1)}`;
  }

  for (const c of curves) {
    if (!ptInBbox({ x: c.x1, y: c.y1 }, bbox)) continue;
    d += `M${(c.x1 - ox).toFixed(1)} ${(c.y1 - oy).toFixed(1)}` +
         `C${(c.cx1 - ox).toFixed(1)} ${(c.cy1 - oy).toFixed(1)} ` +
         `${(c.cx2 - ox).toFixed(1)} ${(c.cy2 - oy).toFixed(1)} ` +
         `${(c.x2 - ox).toFixed(1)} ${(c.y2 - oy).toFixed(1)}`;
  }

  if (!d.trim()) return null;

  // Respect 560×400 display budget while preserving aspect ratio
  const scale = Math.min(560 / W, 400 / H, 1);
  const svgW  = Math.round(W * scale);
  const svgH  = Math.round(H * scale);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="0 0 ${W} ${H}" width="${svgW}" height="${svgH}" ` +
    `style="max-width:100%;height:auto;display:block">` +
    `<path d="${d}" stroke="#111827" fill="none" ` +
    `stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Detect diagram regions on a page.
 *
 * @param {{ lines, curves, rects, images, pageHeight }} primitives
 * @param {Array<{x,y,x2,y2}>} tableBboxes - known table regions to exclude
 * @returns {Array<{type:'vector'|'image', svgInline?, objId?, bbox}>}
 */
function detectDiagramRegions(primitives, tableBboxes) {
  const { lines, curves, images } = primitives;
  const regions = [];

  // 1. Raster images
  for (const img of images) {
    if (img.w > MIN_DIM && img.h > MIN_DIM) {
      regions.push({
        type: 'image',
        objId: img.objId,
        bbox: { x: img.x, y: img.y, x2: img.x + img.w, y2: img.y + img.h },
      });
    }
  }

  // 2. Vector content outside table regions
  const nonTablePts = [
    ...lines.flatMap(l => [{ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }]),
    ...curves.flatMap(c => [{ x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 }]),
  ].filter(pt => !tableBboxes.some(tb => ptInBbox(pt, tb)));

  if (nonTablePts.length < MIN_POINTS) return regions;

  // Diagram signals
  const nonTableCurves = curves.filter(c => !tableBboxes.some(tb => ptInBbox({ x: c.x1, y: c.y1 }, tb)));
  const diagonalLines  = lines.filter(l =>
    Math.abs(l.x2 - l.x1) > 10 && Math.abs(l.y2 - l.y1) > 10 &&
    !tableBboxes.some(tb => ptInBbox({ x: l.x1, y: l.y1 }, tb))
  );

  const hasCurves    = nonTableCurves.length >= 2;
  const hasDiagonal  = diagonalLines.length  >= 2;
  const hasDenseVec  = nonTablePts.length     >= 30;

  if (!hasCurves && !hasDiagonal && !hasDenseVec) return regions;

  const bbox = getBbox(nonTablePts);
  if (!bbox) return regions;

  const W = bbox.x2 - bbox.x;
  const H = bbox.y2 - bbox.y;
  if (W < MIN_DIM || H < MIN_DIM) return regions;

  const svgInline = buildSVG(lines, nonTableCurves, bbox, tableBboxes);
  if (svgInline) {
    regions.push({ type: 'vector', bbox, svgInline, hasCurves });
  }

  return regions;
}

module.exports = { detectDiagramRegions };
