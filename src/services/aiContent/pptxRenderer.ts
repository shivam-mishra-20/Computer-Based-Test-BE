/**
 * Renders a structured SlideDeck into:
 *  - a real .pptx Buffer via pptxgenjs (the downloadable artifact), and
 *  - a styled 16:9 preview HTML the app shows in a WebView before download.
 *
 * pptxgenjs cannot typeset LaTeX, so for slides we strip $...$ delimiters and
 * show the plain text; the HTML preview server-renders math with KaTeX.
 */
import katex from 'katex';
import type { SlideDeck } from './types';

// ── Themes ──────────────────────────────────────────────────────────────────
interface Theme {
  bg: string;
  title: string;
  body: string;
  accent: string;
}
const THEMES: Record<string, Theme> = {
  default: { bg: 'FFFFFF', title: '0F172A', body: '334155', accent: '0EA5E9' },
  ocean: { bg: 'F0F9FF', title: '075985', body: '0C4A6E', accent: '0284C7' },
  forest: { bg: 'F0FDF4', title: '14532D', body: '166534', accent: '16A34A' },
  sunset: { bg: 'FFF7ED', title: '7C2D12', body: '9A3412', accent: 'EA580C' },
  violet: { bg: 'FAF5FF', title: '581C87', body: '6B21A8', accent: '7C3AED' },
  dark: { bg: '0F172A', title: 'F8FAFC', body: 'CBD5E1', accent: '38BDF8' },
};
function theme(name?: string): Theme {
  return THEMES[(name || '').toLowerCase()] || THEMES.default;
}

/** Remove LaTeX delimiters for plain-text PPTX output (keeps the inner text). */
function stripLatex(s: string): string {
  return String(s ?? '')
    .replace(/\$\$([\s\S]*?)\$\$/g, '$1')
    .replace(/\$([^$]+?)\$/g, '$1')
    .trim();
}

// ── PPTX ────────────────────────────────────────────────────────────────────
export async function renderPptx(deck: SlideDeck): Promise<Buffer> {
  // pptxgenjs ships CJS; import lazily so build/runtime stay clean.
  const PptxGenJS = (await import('pptxgenjs')).default as any;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in (16:9)
  pptx.defineSlideMaster({
    title: 'MASTER',
    background: { color: theme(deck.theme).bg },
  });

  const t = theme(deck.theme);

  for (const s of deck.slides) {
    const slide = pptx.addSlide({ masterName: 'MASTER' });
    slide.background = { color: t.bg };

    if (s.layout === 'title') {
      slide.addText(stripLatex(s.title), {
        x: 0.7, y: 2.4, w: 12, h: 1.6,
        fontSize: 40, bold: true, color: t.title, align: 'center',
      });
      if (deck.subtitle) {
        slide.addText(stripLatex(deck.subtitle), {
          x: 0.7, y: 4.1, w: 12, h: 0.9,
          fontSize: 20, color: t.body, align: 'center',
        });
      }
      slide.addShape('rect', {
        x: 5.4, y: 4.0, w: 2.5, h: 0.06, fill: { color: t.accent },
      });
    } else if (s.layout === 'quiz' && s.quiz?.length) {
      slide.addText(stripLatex(s.title || 'Quick Quiz'), {
        x: 0.6, y: 0.4, w: 12.1, h: 0.9, fontSize: 30, bold: true, color: t.accent,
      });
      const body: any[] = [];
      s.quiz.forEach((q, qi) => {
        body.push({
          text: `${qi + 1}. ${stripLatex(q.question)}`,
          options: { bold: true, color: t.title, fontSize: 18, breakLine: true, paraSpaceAfter: 4 },
        });
        (q.options || []).forEach((opt, oi) => {
          body.push({
            text: `   ${String.fromCharCode(65 + oi)}. ${stripLatex(opt)}`,
            options: { color: t.body, fontSize: 16, breakLine: true },
          });
        });
        if (q.answer) {
          body.push({
            text: `   Answer: ${stripLatex(q.answer)}`,
            options: { italic: true, color: t.accent, fontSize: 15, breakLine: true, paraSpaceAfter: 10 },
          });
        }
      });
      slide.addText(body, { x: 0.7, y: 1.4, w: 11.9, h: 5.6, valign: 'top' });
    } else {
      // content / objectives / summary
      const heading =
        s.layout === 'objectives'
          ? s.title || 'Learning Objectives'
          : s.layout === 'summary'
            ? s.title || 'Summary'
            : s.title;
      slide.addText(stripLatex(heading), {
        x: 0.6, y: 0.4, w: 12.1, h: 0.9, fontSize: 30, bold: true, color: t.accent,
      });
      const bullets = (s.bullets || []).map((b) => ({
        text: stripLatex(b),
        options: {
          bullet: { code: '2022' },
          color: t.body,
          fontSize: 20,
          breakLine: true,
          paraSpaceAfter: 8,
        },
      }));
      if (bullets.length) {
        slide.addText(bullets as any, { x: 0.9, y: 1.5, w: 11.5, h: 5.4, valign: 'top' });
      }
    }

    if (s.notes) slide.addNotes(s.notes);
  }

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

// ── Preview HTML ────────────────────────────────────────────────────────────
const escHtml = (x: unknown) =>
  String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderMath(text: string): string {
  const src = String(text ?? '');
  const re = /\$\$([\s\S]*?)\$\$|\$([^$]+?)\$/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out += escHtml(src.slice(last, m.index));
    const display = m[1] != null;
    const expr = (m[1] ?? m[2]) || '';
    try {
      out += katex.renderToString(expr, {
        displayMode: display,
        throwOnError: false,
        output: 'html',
      });
    } catch {
      out += `<code>${escHtml(expr)}</code>`;
    }
    last = m.index + m[0].length;
  }
  out += escHtml(src.slice(last));
  return out;
}

export function buildDeckPreviewHtml(deck: SlideDeck): string {
  const t = theme(deck.theme);
  const slidesHtml = deck.slides
    .map((s, idx) => {
      let inner = '';
      if (s.layout === 'title') {
        inner = `<div class="title-slide">
          <h1>${renderMath(s.title)}</h1>
          ${deck.subtitle ? `<p class="subtitle">${renderMath(deck.subtitle)}</p>` : ''}
        </div>`;
      } else if (s.layout === 'quiz' && s.quiz?.length) {
        inner = `<h2>${renderMath(s.title || 'Quick Quiz')}</h2>` +
          s.quiz
            .map(
              (q, qi) => `<div class="quiz">
                <p class="q">${qi + 1}. ${renderMath(q.question)}</p>
                ${(q.options || [])
                  .map((o, oi) => `<p class="opt">${String.fromCharCode(65 + oi)}. ${renderMath(o)}</p>`)
                  .join('')}
                ${q.answer ? `<p class="ans">Answer: ${renderMath(q.answer)}</p>` : ''}
              </div>`,
            )
            .join('');
      } else {
        const heading =
          s.layout === 'objectives'
            ? s.title || 'Learning Objectives'
            : s.layout === 'summary'
              ? s.title || 'Summary'
              : s.title;
        inner = `<h2>${renderMath(heading)}</h2><ul>${(s.bullets || [])
          .map((b) => `<li>${renderMath(b)}</li>`)
          .join('')}</ul>`;
      }
      return `<div class="slide"><div class="slide-no">${idx + 1}</div>${inner}</div>`;
    })
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:12px}
    .slide{position:relative;background:#${t.bg};aspect-ratio:16/9;border-radius:12px;
      box-shadow:0 4px 16px rgba(0,0,0,.08);padding:26px 30px;margin:0 0 16px 0;overflow:hidden}
    .slide-no{position:absolute;top:10px;right:14px;font-size:11px;color:#${t.body};opacity:.5}
    h1{color:#${t.title};font-size:30px;margin:0}
    h2{color:#${t.accent};font-size:22px;margin:0 0 12px 0}
    .subtitle{color:#${t.body};font-size:16px;margin-top:10px}
    ul{margin:0;padding-left:22px}
    li{color:#${t.body};font-size:16px;margin:8px 0;line-height:1.4}
    .title-slide{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
    .quiz{margin-bottom:14px}
    .quiz .q{font-weight:700;color:#${t.title};margin:0 0 6px}
    .quiz .opt{color:#${t.body};margin:2px 0 2px 14px}
    .quiz .ans{color:#${t.accent};font-style:italic;margin:4px 0 0 14px}
  </style></head><body>${slidesHtml}</body></html>`;
}
