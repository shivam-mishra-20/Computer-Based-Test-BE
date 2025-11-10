import type { IPaper } from '../models/Paper';
import fs from 'fs';

const esc = (x: unknown) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderMathServer(text: string): string {
  // Try to render LaTeX ($..$, $$..$$) to HTML via KaTeX, fallback to escaped with <br/>
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const katex = require('katex') as { renderToString: (expr: string, opts: any) => string };
    const parts: string[] = [];
    let i = 0;
    const displayRe = /\$\$([\s\S]*?)\$\$/g;
    const inlineRe = /\$([^$]+?)\$/g;
    const matches: Array<{ start: number; end: number; content: string; display: boolean }> = [];
    let m: RegExpExecArray | null;
    while ((m = displayRe.exec(text)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, content: m[1], display: true });
    }
    while ((m = inlineRe.exec(text)) !== null) {
      // ignore inline matches that are inside display ranges
      if (!matches.some((dm) => m!.index >= dm.start && m!.index < dm.end)) {
        matches.push({ start: m.index, end: m.index + m[0].length, content: m[1], display: false });
      }
    }
    matches.sort((a, b) => a.start - b.start);
    for (const match of matches) {
      if (i < match.start) {
        parts.push(esc(text.slice(i, match.start)).replace(/\n/g, '<br/>'));
      }
      try {
        const html = katex.renderToString(match.content, { displayMode: match.display, throwOnError: false, output: 'html' });
        parts.push(html);
      } catch {
        parts.push(`<code>${esc(match.content)}</code>`);
      }
      i = match.end;
    }
    if (i < text.length) parts.push(esc(text.slice(i)).replace(/\n/g, '<br/>'));
    return parts.join('');
  } catch {
    // Fallback: exact text with preserved line breaks
    return esc(text).replace(/\n/g, '<br/>');
  }
}

export function buildPaperHtml(paper: IPaper, options?: { includeSolutions?: boolean }) {
  const includeSolutions = !!options?.includeSolutions;
  // Try load KaTeX CSS to inline (optional)
  let katexCss = '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cssPath = require.resolve('katex/dist/katex.min.css');
    katexCss = fs.readFileSync(cssPath, 'utf8');
  } catch {}
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const guessMime = (file: string) => {
    const ext = file.toLowerCase().split('.').pop() || '';
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'svg') return 'image/svg+xml';
    return 'application/octet-stream';
  };
  const embedIfLocal = (u?: string) => {
    if (!u) return '';
    // If it's already absolute remote URL, don't embed
    if (/^https?:\/\//i.test(u)) return u;
    // Only embed from our local uploads folder
    if (u.startsWith('/uploads/')) {
      try {
        const abs = require('path').join(process.cwd(), u.replace(/^\//, ''));
        const buf = fs.readFileSync(abs);
        const mime = guessMime(abs);
        const b64 = buf.toString('base64');
        return `data:${mime};base64,${b64}`;
      } catch {
        // Fall back to public URL
        return base ? `${base}${u}` : u;
      }
    }
    return base ? `${base}${u}` : u;
  };
  return `<!doctype html><html><head><meta charset="utf-8"/><title>${esc(paper.examTitle)}</title>
    <style>
      ${katexCss}
      body{font-family:Arial,Helvetica,sans-serif;margin:24px;color:#111;font-size:13.5px;line-height:1.55}
      h1{text-align:center;font-size:22px;margin:0 0 8px 0}
      h2{margin:18px 0 10px 0;font-size:16px}
      ol{margin:0 0 16px 22px}
      li{margin:8px 0}
      .muted{color:#666;font-size:12.5px;margin-bottom:4px}
      .sol{background:#f8fafc;border:1px solid #e5e7eb;padding:10px;border-radius:8px;margin:10px 0}
      .meta{margin-bottom:6px}
      .diagram{margin:8px 0}
      .diagram img{max-width:100%; height:auto;}
      /* KaTeX minimal alignment (if server-rendered) */
      .katex-display{margin:0.5em 0;}
      .options{list-style:none;padding-left:0;margin:6px 0}
      .options li{margin:4px 0}
      .opt-label{display:inline-block;width:22px;font-weight:bold}
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
        .map((q: any, i: number) => {
          const qHtml = renderMathServer(String(q.text ?? ''));
          const imgUrl = embedIfLocal(q.diagramUrl);
          const img = imgUrl ? `<div class="diagram"><img src="${esc(imgUrl)}" alt="diagram"/></div>` : '';
          const options = Array.isArray(q.options) && q.options.length
            ? `<ul class="options">${q.options
                .map((opt: any, idx: number) => `<li><span class="opt-label">${String.fromCharCode(65 + idx)}.</span> ${renderMathServer(String(opt.text ?? ''))}</li>`)
                .join('')}</ul>`
            : '';
          const explanation = includeSolutions && q.explanation ? `<div class=\"sol\"><strong>Explanation:</strong><br/>${renderMathServer(String(q.explanation))}</div>` : '';
          const sol = includeSolutions && sols[i]?.solutionText ? `<div class=\"sol\"><strong>Solution:</strong><br/>${renderMathServer(String(sols[i].solutionText))}</div>` : '';
          return `<li>${qHtml}${img}${options}${explanation || sol}</li>`;
        })
        .join('')}
      </ol></section>`;
    })
    .join('')}
  </body></html>`;
}
