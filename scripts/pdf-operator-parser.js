'use strict';

/**
 * Low-level PDF operator stream parser using pdfjs-dist (legacy Node.js build).
 * Extracts geometric primitives — line segments, Bezier curves, rectangles,
 * and embedded image references — from a page's content stream.
 * Applies the Current Transformation Matrix (CTM) so coordinates are in
 * page-space (top-left origin, y increases downward).
 */

const pdfjsLib = require('pdfjs-dist');
const { OPS } = pdfjsLib;

// ── Matrix helpers ────────────────────────────────────────────────────────────

function multiplyMatrix(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parse a single pdfjs-dist page and return its drawing primitives.
 *
 * @param {import('pdfjs-dist').PDFPageProxy} page
 * @returns {Promise<{
 *   lines: Array<{x1,y1,x2,y2}>,
 *   curves: Array<{x1,y1,cx1,cy1,cx2,cy2,x2,y2}>,
 *   rects: Array<{x,y,w,h}>,
 *   images: Array<{objId:string, x:number, y:number, w:number, h:number}>,
 *   pageWidth: number,
 *   pageHeight: number,
 * }>}
 */
async function parsePageOperators(page) {
  const viewport = page.getViewport({ scale: 1.0 });
  const { width: pageWidth, height: pageHeight } = viewport;

  const opList = await page.getOperatorList();
  const { fnArray, argsArray } = opList;

  const lines  = [];
  const curves = [];
  const rects  = [];
  const images = [];

  // Graphics state stack
  const ctmStack = [[1, 0, 0, 1, 0, 0]]; // identity
  let curX = 0, curY = 0;
  let pathStartX = 0, pathStartY = 0;

  const ctm = () => ctmStack[ctmStack.length - 1];

  // PDF y-axis is bottom-up; flip to screen top-down.
  function toScreen(x, y) {
    const [tx, ty] = applyMatrix(ctm(), x, y);
    return { x: tx, y: pageHeight - ty };
  }

  function pushLine(x1, y1, x2, y2) {
    const p1 = toScreen(x1, y1);
    const p2 = toScreen(x2, y2);
    lines.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
  }

  for (let i = 0; i < fnArray.length; i++) {
    const fn   = fnArray[i];
    const args = argsArray[i];

    switch (fn) {
      case OPS.save:
        ctmStack.push([...ctm()]);
        break;

      case OPS.restore:
        if (ctmStack.length > 1) ctmStack.pop();
        break;

      case OPS.transform:
        // args = [a,b,c,d,e,f] — post-multiply (PDF spec: cm operator)
        ctmStack[ctmStack.length - 1] = multiplyMatrix(args, ctm());
        break;

      case OPS.constructPath: {
        if (!args || !args[0]) break;
        const cmds   = args[0]; // sub-opcodes (OPS.moveTo, lineTo, etc.)
        const coords = args[1]; // flat coordinate array
        let ci = 0;

        for (const cmd of cmds) {
          // Guard against malformed streams
          if (cmd === OPS.moveTo) {
            if (ci + 2 > coords.length) break;
            curX = coords[ci++]; curY = coords[ci++];
            pathStartX = curX;   pathStartY = curY;

          } else if (cmd === OPS.lineTo) {
            if (ci + 2 > coords.length) break;
            const nx = coords[ci++], ny = coords[ci++];
            pushLine(curX, curY, nx, ny);
            curX = nx; curY = ny;

          } else if (cmd === OPS.curveTo) {
            if (ci + 6 > coords.length) { ci += 6; break; }
            const cx1r = coords[ci++], cy1r = coords[ci++];
            const cx2r = coords[ci++], cy2r = coords[ci++];
            const ex   = coords[ci++], ey   = coords[ci++];
            const p1  = toScreen(curX, curY);
            const cp1 = toScreen(cx1r, cy1r);
            const cp2 = toScreen(cx2r, cy2r);
            const p2  = toScreen(ex,   ey);
            curves.push({ x1: p1.x, y1: p1.y, cx1: cp1.x, cy1: cp1.y, cx2: cp2.x, cy2: cp2.y, x2: p2.x, y2: p2.y });
            curX = ex; curY = ey;

          } else if (cmd === OPS.curveTo2) {
            // control point 1 = current point
            if (ci + 4 > coords.length) { ci += 4; break; }
            const cx2r = coords[ci++], cy2r = coords[ci++];
            const ex   = coords[ci++], ey   = coords[ci++];
            const p1  = toScreen(curX, curY);
            const cp2 = toScreen(cx2r, cy2r);
            const p2  = toScreen(ex,   ey);
            curves.push({ x1: p1.x, y1: p1.y, cx1: p1.x, cy1: p1.y, cx2: cp2.x, cy2: cp2.y, x2: p2.x, y2: p2.y });
            curX = ex; curY = ey;

          } else if (cmd === OPS.curveTo3) {
            // control point 2 = end point
            if (ci + 4 > coords.length) { ci += 4; break; }
            const cx1r = coords[ci++], cy1r = coords[ci++];
            const ex   = coords[ci++], ey   = coords[ci++];
            const p1  = toScreen(curX, curY);
            const cp1 = toScreen(cx1r, cy1r);
            const p2  = toScreen(ex,   ey);
            curves.push({ x1: p1.x, y1: p1.y, cx1: cp1.x, cy1: cp1.y, cx2: p2.x, cy2: p2.y, x2: p2.x, y2: p2.y });
            curX = ex; curY = ey;

          } else if (cmd === OPS.rectangle) {
            if (ci + 4 > coords.length) { ci += 4; break; }
            const rx = coords[ci++], ry = coords[ci++];
            const rw = coords[ci++], rh = coords[ci++];
            // 4 sides
            pushLine(rx,      ry,      rx + rw, ry);
            pushLine(rx + rw, ry,      rx + rw, ry + rh);
            pushLine(rx + rw, ry + rh, rx,      ry + rh);
            pushLine(rx,      ry + rh, rx,      ry);
            const tl = toScreen(rx, ry + rh); // top-left in screen coords
            rects.push({ x: tl.x, y: tl.y, w: Math.abs(rw), h: Math.abs(rh) });
            curX = rx; curY = ry;

          } else if (cmd === OPS.closePath) {
            pushLine(curX, curY, pathStartX, pathStartY);
            curX = pathStartX; curY = pathStartY;
          }
        }
        break;
      }

      case OPS.paintJpegXObject:
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject: {
        if (!args) break;
        const objId = fn === OPS.paintInlineImageXObject ? `inline_${i}` : String(args[0] || `img_${i}`);
        // CTM maps the unit square [0,1]×[0,1] onto the image's page region.
        // Top-left = (0,1) and bottom-right = (1,0) in PDF image space.
        const m  = ctm();
        const tl = toScreen(0, 1);
        const br = toScreen(1, 0);
        const x  = Math.min(tl.x, br.x);
        const y  = Math.min(tl.y, br.y);
        const w  = Math.abs(br.x - tl.x);
        const h  = Math.abs(br.y - tl.y);
        if (w > 10 && h > 10) {
          images.push({ objId, x, y, w, h });
        }
        break;
      }
    }
  }

  return { lines, curves, rects, images, pageWidth, pageHeight };
}

module.exports = { parsePageOperators };
