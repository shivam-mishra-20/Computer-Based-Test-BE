/**
 * Branded, print-ready question-paper rendering. Produces a clean school-exam
 * layout (logo header, faint watermark, running footer, A4 margins), with MCQ
 * options in a compact 2×2 grid and each question kept whole (no page break
 * inside a question). Same HTML is used for the in-app WebView preview and the
 * downloadable PDF, so what teachers see is what they get.
 */
import fs from 'fs';
import katex from 'katex';
import { htmlToPdfBufferAdvanced } from '../../utils/launchBrowser';
import { LOGO_DATA_URL } from './brandAssets';
import type { PaperJSON } from './types';

const INSTITUTE_NAME = 'Abhigyan Gurukul';
const INSTITUTE_ADDRESS =
  'Akshar Pavilion, Road 4, Vasna – Bhayli Main Rd, opp. to Rosedale Heights, Yogi Nagar Twp, Gokul Nagar, Vadodara, Gujarat 391410';

const esc = (x: unknown) =>
  String(x ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** Server-render inline/display LaTeX ($…$, $$…$$); fall back to escaped text. */
function renderMath(text: string): string {
  const src = String(text ?? '');
  const re = /\$\$([\s\S]*?)\$\$|\$([^$]+?)\$/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out += esc(src.slice(last, m.index)).replace(/\n/g, '<br/>');
    const display = m[1] != null;
    const expr = (m[1] ?? m[2]) || '';
    try {
      out += katex.renderToString(expr, {
        displayMode: display,
        throwOnError: false,
        output: 'html',
      });
    } catch {
      out += `<code>${esc(expr)}</code>`;
    }
    last = m.index + m[0].length;
  }
  out += esc(src.slice(last)).replace(/\n/g, '<br/>');
  return out;
}

let _katexCss: string | null = null;
function katexCss(): string {
  if (_katexCss != null) return _katexCss;
  try {
    _katexCss = fs.readFileSync(require.resolve('katex/dist/katex.min.css'), 'utf8');
  } catch {
    _katexCss = '';
  }
  return _katexCss;
}

function durationLabel(mins?: number): string {
  if (!mins || mins <= 0) return '____________';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function computeTotalMarks(paper: PaperJSON): number | undefined {
  if (typeof paper.totalMarks === 'number' && paper.totalMarks > 0) {
    return paper.totalMarks;
  }
  let sum = 0;
  for (const s of paper.sections) {
    const per = Number(s.marksPerQuestion) || 0;
    sum += per * (s.questions?.length || 0);
  }
  return sum > 0 ? sum : undefined;
}

// ── Body sections ─────────────────────────────────────────────────────────────
function headerHtml(paper: PaperJSON): string {
  const total = computeTotalMarks(paper);
  // Avoid "Class: Class 7" — the value often already carries the word "Class".
  const classValue = (paper.className || '').replace(/^class\s+/i, '').trim() || '—';
  return `<div class="doc-header">
    <div class="brand-row">
      <img class="logo" src="${LOGO_DATA_URL}" alt="logo"/>
      <div class="brand-name">${esc(INSTITUTE_NAME)}</div>
      <div class="logo-spacer"></div>
    </div>
    <div class="hr thick"></div>
    <div class="meta-row">
      <div class="test-label">${esc(paper.examTitle || 'Class Test')}</div>
      <div>Date: <span class="fill">&nbsp;</span></div>
    </div>
    <div class="meta-row">
      <div><b>Subject:</b> ${esc(paper.subject || '—')}</div>
      <div><b>Class:</b> ${esc(classValue)}</div>
    </div>
    <div class="meta-row">
      <div><b>Time:</b> ${esc(durationLabel(paper.meta?.durationMins))}</div>
      <div><b>Total Marks:</b> ${total != null ? total : '____'}</div>
    </div>
    <div class="hr thick"></div>
    ${
      paper.generalInstructions?.length
        ? `<div class="instructions"><b>General Instructions:</b><ol>${paper.generalInstructions
            .map((i) => `<li>${esc(i)}</li>`)
            .join('')}</ol></div>`
        : ''
    }
  </div>`;
}

function questionsHtml(paper: PaperJSON): string {
  let qNo = 0;
  return paper.sections
    .map((sec, sIdx) => {
      const letter = String.fromCharCode(65 + sIdx);
      const per = Number(sec.marksPerQuestion) || 0;
      const marksTag = per > 0 ? `<span class="sec-marks">(${per} ${per === 1 ? 'mark' : 'marks'} each)</span>` : '';
      const questions = sec.questions
        .map((q) => {
          qNo += 1;
          const hasOptions = Array.isArray(q.options) && q.options.length > 0;
          const opts = hasOptions
            ? `<div class="options ${q.options!.length <= 2 ? 'two' : 'grid'}">${q
                .options!.map(
                  (o, i) =>
                    `<div class="opt"><span class="opt-lbl">${String.fromCharCode(
                      65 + i,
                    )})</span> <span>${renderMath(String(o.text ?? ''))}</span></div>`,
                )
                .join('')}</div>`
            : '';
          const markRight = per > 0 ? `<span class="q-mark">[${per}]</span>` : '';
          return `<li class="q">
            <div class="q-head"><span class="q-text">${renderMath(String(q.text ?? ''))}</span>${markRight}</div>
            ${opts}
          </li>`;
        })
        .join('');
      return `<section class="sec">
        <div class="sec-title">Section ${letter}: ${esc(sec.title)} ${marksTag}</div>
        ${sec.instructions ? `<div class="sec-instr">${esc(sec.instructions)}</div>` : ''}
        <ol class="q-list" start="${qNo - sec.questions.length + 1}">${questions}</ol>
      </section>`;
    })
    .join('');
}

function answerKeyHtml(paper: PaperJSON): string {
  let qNo = 0;
  const rows: string[] = [];
  for (const sec of paper.sections) {
    for (const q of sec.questions) {
      qNo += 1;
      if (q.explanation) {
        rows.push(
          `<div class="ans"><span class="ans-no">${qNo}.</span> <span>${renderMath(
            String(q.explanation),
          )}</span></div>`,
        );
      }
    }
  }
  if (!rows.length) return '';
  return `<div class="answer-key">
    <div class="hr thick"></div>
    <div class="ak-title">Answer Key</div>
    <div class="ak-list">${rows.join('')}</div>
  </div>`;
}

const STYLES = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: 'Times New Roman', Georgia, serif; color: #111; background: #ffffff; font-size: 12.5px; line-height: 1.4; }
  .watermark { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 0; }
  .watermark img { width: 60%; max-width: 360px; opacity: 0.06; }
  .content { position: relative; z-index: 1; }

  .doc-header { margin-bottom: 8px; }
  .brand-row { display: grid; grid-template-columns: 54px 1fr 54px; align-items: center; }
  .logo { width: 50px; height: 50px; object-fit: contain; }
  .brand-name { text-align: center; font-size: 26px; font-weight: 700; letter-spacing: .5px; }
  .hr { border: 0; border-top: 1px solid #111; margin: 6px 0; }
  .hr.thick { border-top: 2px solid #111; }
  .meta-row { display: flex; justify-content: space-between; gap: 16px; margin: 3px 0; font-size: 13px; }
  .test-label { font-weight: 700; }
  .fill { display: inline-block; min-width: 120px; border-bottom: 1px solid #555; }
  .instructions { font-size: 11.5px; margin-top: 6px; }
  .instructions ol { margin: 4px 0 0 18px; padding: 0; }
  .instructions li { margin: 1px 0; }

  .sec { margin-top: 10px; }
  .sec-title { font-weight: 700; font-size: 13.5px; margin-bottom: 2px; break-after: avoid; page-break-after: avoid; }
  .sec-marks { font-weight: 600; font-size: 11.5px; color: #444; }
  .sec-instr { font-size: 11.5px; color: #444; font-style: italic; margin-bottom: 4px; }

  ol.q-list { margin: 0; padding-left: 22px; }
  li.q { margin: 0 0 8px 0; padding: 0; break-inside: avoid; page-break-inside: avoid; }
  .q-head { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
  .q-text { flex: 1; }
  .q-mark { font-weight: 700; white-space: nowrap; color: #333; }

  /* MCQ options — compact 2×2 grid; single-row for ≤2 options */
  .options { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 24px; margin: 4px 0 0 4px; }
  .options.two { grid-template-columns: 1fr 1fr; }
  .opt { display: flex; gap: 5px; align-items: flex-start; font-size: 12.5px; break-inside: avoid; }
  .opt-lbl { font-weight: 700; }

  .answer-key { margin-top: 16px; page-break-before: always; }
  .ak-title { font-weight: 700; font-size: 14px; text-align: center; margin: 6px 0 8px; }
  .ak-list { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; font-size: 11.5px; }
  .ans { break-inside: avoid; }
  .ans-no { font-weight: 700; }

  .katex { font-size: 1em; }
  .katex-display { margin: 4px 0; }
`;

export function buildBrandedPaperHtml(
  paper: PaperJSON,
  opts: { includeAnswerKey?: boolean; inBodyFooter?: string } = {},
): string {
  return `<!doctype html><html><head><meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${esc(paper.examTitle || 'Question Paper')}</title>
  <style>${katexCss()}${STYLES}</style></head>
  <body>
    <div class="watermark"><img src="${LOGO_DATA_URL}" alt=""/></div>
    <div class="content">
      ${headerHtml(paper)}
      ${questionsHtml(paper)}
      ${opts.includeAnswerKey ? answerKeyHtml(paper) : ''}
      ${opts.inBodyFooter || ''}
    </div>
  </body></html>`;
}

/** Native running footer (rendered in the bottom page margin on every page). */
function footerTemplate(): string {
  return `<div style="width:100%; font-family:Arial, sans-serif; font-size:7px; color:#6b7280; padding:0 12mm;">
    <div style="border-top:1px solid #cbb6a0; padding-top:3px; display:flex; justify-content:space-between; align-items:center;">
      <span style="max-width:80%; line-height:1.2;">${esc(INSTITUTE_ADDRESS)}</span>
      <span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>
    </div>
  </div>`;
}

export function buildPaperPreviewHtml(paper: PaperJSON): string {
  // Preview mirrors the PDF; append an in-body footer since the WebView can't
  // render Chromium's native running footer.
  const footer = `<div style="margin-top:14px;border-top:1px solid #cbb6a0;padding-top:6px;font-size:10px;color:#6b7280;font-family:Arial,sans-serif;">${esc(
    INSTITUTE_ADDRESS,
  )}</div>`;
  return buildBrandedPaperHtml(paper, { includeAnswerKey: true, inBodyFooter: footer });
}

export async function renderPaperPdf(paper: PaperJSON): Promise<Buffer> {
  const html = buildBrandedPaperHtml(paper, { includeAnswerKey: true });
  return htmlToPdfBufferAdvanced(html, {
    margin: { top: '10mm', right: '12mm', bottom: '16mm', left: '12mm' },
    footerTemplate: footerTemplate(),
  });
}
