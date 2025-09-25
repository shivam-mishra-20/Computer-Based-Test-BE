import type { IPaper } from '../models/Paper';

const esc = (x: unknown) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildPaperHtml(paper: IPaper, options?: { includeSolutions?: boolean }) {
  const includeSolutions = !!options?.includeSolutions;
  return `<!doctype html><html><head><meta charset="utf-8"/><title>${esc(paper.examTitle)}</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;margin:24px;color:#111;font-size:13.5px;line-height:1.55}
      h1{text-align:center;font-size:22px;margin:0 0 8px 0}
      h2{margin:18px 0 10px 0;font-size:16px}
      ol{margin:0 0 16px 22px}
      li{margin:8px 0}
      .muted{color:#666;font-size:12.5px;margin-bottom:4px}
      .sol{background:#f8fafc;border:1px solid #e5e7eb;padding:10px;border-radius:8px;margin:10px 0}
      .meta{margin-bottom:6px}
    </style>
  </head><body>
  <h1>${esc(paper.examTitle)}</h1>
  ${paper.subject ? `<div style="text-align:center; margin-bottom:6px"><strong>Subject:</strong> ${esc(paper.subject)}</div>` : ''}
  <div style="text-align:center; margin-bottom:10px" class="muted">
    ${typeof (paper as any).totalMarks === 'number' ? `<strong>Total Marks:</strong> ${(paper as any).totalMarks}` : ''}
    ${(paper as any).meta?.durationMins ? ` &nbsp; | &nbsp; <strong>Time:</strong> ${(paper as any).meta?.durationMins} mins` : ''}
  </div>
  ${Array.isArray(paper.generalInstructions) && paper.generalInstructions.length ? `<ol>${paper.generalInstructions.map((i) => `<li>${esc(i)}</li>`).join('')}</ol>` : ''}
  ${paper.sections
    .map((sec: any, sIdx: number) => {
      const sols = (paper as any).solutions?.sections?.[sIdx]?.solutions || [];
      const marksPerQ = sec.marksPerQuestion ? ` (Marks/Q: ${sec.marksPerQuestion})` : '';
      return `<section><h2>${esc(sec.title)}${marksPerQ}</h2>${sec.instructions ? `<div class="muted">${esc(sec.instructions)}</div>` : ''}
      <ol>
      ${sec.questions
        .map((q: any, i: number) => `<li>${esc(q.text)}${includeSolutions && sols[i]?.solutionText ? `<div class=\"sol\"><strong>Solution:</strong><br/>${esc(sols[i].solutionText)}</div>` : ''}</li>`)
        .join('')}
      </ol></section>`;
    })
    .join('')}
  </body></html>`;
}
