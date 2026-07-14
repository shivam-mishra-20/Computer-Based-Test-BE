/**
 * Stage 13 — PowerPoint Builder. Renders GeneratedSlide[] through a ThemeJSON
 * into a real, fully-editable .pptx (pptxgenjs native shapes/text — never
 * text-in-image, per the hard requirement) plus matching preview HTML.
 *
 * Formula rendering constraint (flagged, not solved): pptxgenjs has no LaTeX/
 * OOXML math-object API, and rasterizing an equation into an image would
 * violate "everything must be editable". v1 renders formulaBox content as
 * styled, unicode-approximated plain text inside an accent-bordered highlight
 * shape (see latexToUnicode below) — editable and visually distinct, not
 * typeset math. True editable equations (OOXML <m:oMath> injection) are an
 * unscheduled future phase.
 *
 * Card layout types (definition_card, formula_highlight, example_box,
 * solved_example, mcq_card, table, summary_card, homework) all render as a
 * heading (icon glyph + text, from theme.iconMap) followed by one or more
 * roundRect card shapes using theme.cardStyles. objectives/content_bullets
 * share a simple bulleted-list layout.
 */
import { emptyMetrics } from '../../aiOrchestrator/interfaces';
import type {
  ContentType,
  GeneratedSlide,
  PipelineContext,
  PptRenderer,
  StageResult,
  ThemeJSON,
} from '../../aiOrchestrator/interfaces';
import type { RenderedArtifact } from '../types';
import { iconFor } from './theme/icons';

// ── LaTeX → readable plain text ─────────────────────────────────────────────

const LATEX_SYMBOL_MAP: [RegExp, string][] = [
  [/\\times/g, '×'], [/\\div/g, '÷'], [/\\pm/g, '±'], [/\\mp/g, '∓'],
  [/\\leq/g, '≤'], [/\\geq/g, '≥'], [/\\neq/g, '≠'], [/\\approx/g, '≈'],
  [/\\infty/g, '∞'], [/\\cdot/g, '·'], [/\\to/g, '→'], [/\\rightarrow/g, '→'],
  [/\\alpha/g, 'α'], [/\\beta/g, 'β'], [/\\gamma/g, 'γ'], [/\\delta/g, 'δ'],
  [/\\theta/g, 'θ'], [/\\lambda/g, 'λ'], [/\\mu/g, 'μ'], [/\\pi/g, 'π'],
  [/\\sigma/g, 'σ'], [/\\omega/g, 'ω'], [/\\Delta/g, 'Δ'], [/\\Sigma/g, 'Σ'],
  [/\\Omega/g, 'Ω'], [/\\sqrt\{([^}]*)\}/g, '√($1)'], [/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1/$2)'],
  [/\\int/g, '∫'], [/\\sum/g, '∑'], [/\\partial/g, '∂'],
];

/** Best-effort LaTeX → readable plain text: strips $...$ delimiters, maps
 * common commands to Unicode symbols, drops leftover braces/backslashes. Not
 * a LaTeX parser — a readability pass for the fundamentally-plain-text
 * constraint pptxgenjs imposes (see file header). */
export function latexToUnicode(s: string): string {
  let out = String(s ?? '')
    .replace(/\$\$([\s\S]*?)\$\$/g, '$1')
    .replace(/\$([^$]+?)\$/g, '$1')
    // \( \) / \[ \] delimiters (models emit these despite the $-only rule;
    // legacy stored slides may carry them too).
    .replace(/\\[()[\]]/g, '');
  for (const [pattern, replacement] of LATEX_SYMBOL_MAP) {
    out = out.replace(pattern, replacement);
  }
  // Superscript/subscript: drop the braces, keep the content inline —
  // plain text can't raise/lower a baseline.
  out = out.replace(/[\^_]\{([^}]*)\}/g, '$1').replace(/[\^_](\w)/g, '$1');
  // Any remaining unrecognized \command — drop the backslash, keep the word.
  out = out.replace(/\\([a-zA-Z]+)/g, '$1');
  return out.trim();
}

// ── Shared layout constants ─────────────────────────────────────────────────

const SLIDE_W = 13.33;
const CONTENT_X = 0.6;
const CONTENT_W = SLIDE_W - CONTENT_X * 2;
const HEADING_Y = 0.4;
const HEADING_H = 0.9;
const BODY_Y = 1.5;
const BODY_H = 5.5;

function addHeading(slide: any, text: string, theme: ThemeJSON, glyph?: string): void {
  const label = glyph ? `${glyph}  ${text}` : text;
  slide.addText(label, {
    x: CONTENT_X, y: HEADING_Y, w: CONTENT_W, h: HEADING_H,
    fontSize: theme.typography.headingSizePt, bold: true,
    color: theme.colors.accentPrimary, fontFace: theme.typography.headingFont,
    align: theme.align || 'left',
  });
}

function addBulletList(slide: any, items: string[], theme: ThemeJSON, y = BODY_Y, h = BODY_H): void {
  if (!items.length) return;
  const bullets = items.map((b) => ({
    text: latexToUnicode(b),
    options: {
      bullet: { code: '2022' },
      color: theme.colors.body,
      fontSize: theme.typography.bodySizePt,
      fontFace: theme.typography.bodyFont,
      breakLine: true,
      paraSpaceAfter: 8,
    },
  }));
  slide.addText(bullets, { x: CONTENT_X + 0.3, y, w: CONTENT_W - 0.3, h, valign: 'top' });
}

/** A single roundRect card with a title + body line(s) inside. Returns the
 * y-coordinate just below the card, for stacking multiple cards. */
function addCard(
  slide: any,
  y: number,
  height: number,
  theme: ThemeJSON,
  cardStyleKey: keyof ThemeJSON['cardStyles'],
  titleText: string | undefined,
  bodyText: string,
): number {
  const style = theme.cardStyles[cardStyleKey];
  slide.addShape('roundRect', {
    x: CONTENT_X, y, w: CONTENT_W, h: height,
    fill: { color: style.fill }, line: { color: style.border, width: 1.5 },
    rectRadius: 0.08,
  });
  const textRuns: any[] = [];
  if (titleText) {
    textRuns.push({ text: latexToUnicode(titleText), options: { bold: true, color: theme.colors.title, fontSize: theme.typography.bodySizePt + 2, breakLine: true, paraSpaceAfter: 4 } });
  }
  textRuns.push({ text: latexToUnicode(bodyText), options: { color: theme.colors.body, fontSize: theme.typography.bodySizePt } });
  slide.addText(textRuns, { x: CONTENT_X + 0.25, y: y + 0.15, w: CONTENT_W - 0.5, h: height - 0.3, valign: 'top' });
  return y + height + 0.2;
}

// ── Per-layout-type rendering ────────────────────────────────────────────────

function renderTitleSlide(slide: any, s: GeneratedSlide, theme: ThemeJSON): void {
  slide.addText(latexToUnicode(s.title), {
    x: 0.7, y: 2.4, w: SLIDE_W - 1.4, h: 1.6,
    fontSize: 40, bold: true, color: theme.colors.title, align: 'center',
    fontFace: theme.typography.headingFont,
  });
  if (s.subtitle) {
    slide.addText(latexToUnicode(s.subtitle), {
      x: 0.7, y: 4.1, w: SLIDE_W - 1.4, h: 0.9,
      fontSize: 20, color: theme.colors.body, align: 'center',
      fontFace: theme.typography.bodyFont,
    });
  }
  slide.addShape('rect', {
    x: SLIDE_W / 2 - 1.25, y: 4.0, w: 2.5, h: 0.06, fill: { color: theme.colors.accentPrimary },
  });
}

function renderBulletLayout(slide: any, s: GeneratedSlide, theme: ThemeJSON, contentType: ContentType): void {
  addHeading(slide, s.title, theme, iconFor(contentType));
  addBulletList(slide, s.bullets || [], theme);
}

function renderDefinitionCard(slide: any, s: GeneratedSlide, theme: ThemeJSON): void {
  addHeading(slide, s.title, theme, iconFor('definition'));
  const entries = s.definitionCard || [];
  const cardH = Math.min(1.6, (BODY_H - 0.2 * (entries.length - 1)) / Math.max(1, entries.length));
  let y = BODY_Y;
  for (const e of entries) {
    y = addCard(slide, y, cardH, theme, 'definition', e.term, e.definition);
  }
}

function renderFormulaHighlight(slide: any, s: GeneratedSlide, theme: ThemeJSON): void {
  addHeading(slide, s.title, theme, iconFor('formula'));
  const entries = s.formulaBox || [];
  const cardH = Math.min(1.6, (BODY_H - 0.2 * (entries.length - 1)) / Math.max(1, entries.length));
  let y = BODY_Y;
  for (const e of entries) {
    slide.addShape('roundRect', {
      x: CONTENT_X, y, w: CONTENT_W, h: cardH,
      fill: { color: theme.cardStyles.formula.fill }, line: { color: theme.cardStyles.formula.border, width: 2 },
      rectRadius: 0.08,
    });
    const runs: any[] = [
      { text: latexToUnicode(e.expression), options: { bold: true, color: theme.colors.accentSecondary, fontSize: 24, breakLine: !!e.description, paraSpaceAfter: 4, align: 'center' } },
    ];
    if (e.description) runs.push({ text: latexToUnicode(e.description), options: { color: theme.colors.body, fontSize: theme.typography.bodySizePt, align: 'center' } });
    slide.addText(runs, { x: CONTENT_X + 0.25, y: y + 0.15, w: CONTENT_W - 0.5, h: cardH - 0.3, valign: 'middle' });
    y += cardH + 0.2;
  }
}

function renderExampleBox(slide: any, s: GeneratedSlide, theme: ThemeJSON): void {
  addHeading(slide, s.title, theme, iconFor('example'));
  const entries = s.exampleBox || [];
  const cardH = Math.min(1.4, (BODY_H - 0.2 * (entries.length - 1)) / Math.max(1, entries.length));
  let y = BODY_Y;
  for (const e of entries) {
    y = addCard(slide, y, cardH, theme, 'example', undefined, e.text);
  }
}

function renderSolvedExample(slide: any, s: GeneratedSlide, theme: ThemeJSON): void {
  addHeading(slide, s.title, theme, iconFor('solved_example'));
  if (!s.solvedExample) return;
  addCard(slide, BODY_Y, 1.3, theme, 'example', 'Problem', s.solvedExample.problem);
  addCard(slide, BODY_Y + 1.5, 3.5, theme, 'example', 'Solution', s.solvedExample.solution);
}

function renderMcqCard(slide: any, s: GeneratedSlide, theme: ThemeJSON): void {
  addHeading(slide, s.title, theme, iconFor('mcq'));
  const questions = s.mcq || [];
  const qHeight = Math.min(2.6, (BODY_H - 0.15 * (questions.length - 1)) / Math.max(1, questions.length));
  let y = BODY_Y;
  const colW = (CONTENT_W - 0.6) / 2;
  for (const q of questions) {
    slide.addShape('roundRect', {
      x: CONTENT_X, y, w: CONTENT_W, h: qHeight,
      fill: { color: theme.cardStyles.mcq.fill }, line: { color: theme.cardStyles.mcq.border, width: 1.5 },
      rectRadius: 0.08,
    });
    slide.addText(latexToUnicode(q.question), {
      x: CONTENT_X + 0.25, y: y + 0.12, w: CONTENT_W - 0.5, h: 0.5,
      bold: true, color: theme.colors.title, fontSize: theme.typography.bodySizePt,
    });
    // Compact 2-column option grid.
    q.options.forEach((opt, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const isAnswer = i === q.answerIndex;
      slide.addText(`${String.fromCharCode(65 + i)}) ${latexToUnicode(opt)}`, {
        x: CONTENT_X + 0.3 + col * colW, y: y + 0.65 + row * 0.42, w: colW - 0.2, h: 0.4,
        color: isAnswer ? theme.colors.accentPrimary : theme.colors.body,
        bold: isAnswer,
        fontSize: theme.typography.bodySizePt - 2,
      });
    });
    y += qHeight + 0.15;
  }
}

function renderTable(slide: any, s: GeneratedSlide, theme: ThemeJSON): void {
  addHeading(slide, s.title, theme, iconFor('table'));
  if (!s.table || !s.table.headers.length) return;
  const rows = [
    s.table.headers.map((h) => ({ text: h, options: { bold: true, color: theme.colors.title, fill: { color: theme.colors.accentPrimary } } })),
    ...s.table.rows.map((r) => r.map((c) => ({ text: latexToUnicode(c), options: { color: theme.colors.body } }))),
  ];
  slide.addTable(rows, {
    x: CONTENT_X, y: BODY_Y, w: CONTENT_W,
    fontSize: theme.typography.bodySizePt - 2,
    border: { type: 'solid', color: theme.cardStyles.definition.border, pt: 1 },
    autoPage: false,
  });
}

function renderSlideByLayout(slide: any, s: GeneratedSlide, theme: ThemeJSON): void {
  switch (s.layoutType) {
    case 'title':
      renderTitleSlide(slide, s, theme);
      break;
    case 'objectives':
      renderBulletLayout(slide, s, theme, 'objectives');
      break;
    case 'definition_card':
      renderDefinitionCard(slide, s, theme);
      break;
    case 'formula_highlight':
      renderFormulaHighlight(slide, s, theme);
      break;
    case 'example_box':
      renderExampleBox(slide, s, theme);
      break;
    case 'solved_example':
      renderSolvedExample(slide, s, theme);
      break;
    case 'mcq_card':
      renderMcqCard(slide, s, theme);
      break;
    case 'table':
      renderTable(slide, s, theme);
      break;
    case 'summary_card':
      renderBulletLayout(slide, s, theme, 'summary');
      break;
    case 'homework':
      renderBulletLayout(slide, s, theme, 'homework');
      break;
    case 'content_bullets':
    default:
      renderBulletLayout(slide, s, theme, 'note');
      break;
  }
}

// ── PptRenderer interface implementation ────────────────────────────────────

export const pptxBuilder: PptRenderer = {
  async render(
    slides: GeneratedSlide[],
    theme: ThemeJSON,
    _ctx: PipelineContext,
  ): Promise<StageResult<RenderedArtifact & { previewHtml: string }>> {
    const PptxGenJS = (await import('pptxgenjs')).default as any;
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.defineSlideMaster({ title: 'MASTER', background: { color: theme.colors.bg } });

    const sorted = [...slides].sort((a, b) => a.slideIndex - b.slideIndex);
    for (const s of sorted) {
      const slide = pptx.addSlide({ masterName: 'MASTER' });
      slide.background = { color: theme.colors.bg };
      renderSlideByLayout(slide, s, theme);
      if (theme.watermarkText) {
        slide.addText(theme.watermarkText, {
          x: SLIDE_W - 3.4, y: 7.05, w: 3.2, h: 0.35,
          fontSize: 9, color: theme.colors.muted, align: 'right',
          fontFace: theme.typography.bodyFont, transparency: 40,
        });
      }
      if (s.speakerNotes) slide.addNotes(latexToUnicode(s.speakerNotes));
    }

    const out = await pptx.write({ outputType: 'nodebuffer' });
    const buffer: Buffer = Buffer.isBuffer(out) ? out : Buffer.from(out);
    const deckTitle = sorted[0]?.title || 'Presentation';
    const previewHtml = buildSlidesPreviewHtml(sorted, theme);

    return {
      output: {
        buffer,
        fileName: `${deckTitle.replace(/[^a-zA-Z0-9]+/g, '_')}.pptx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        ext: 'pptx',
        previewHtml,
      },
      metrics: emptyMetrics(),
      warnings: [],
    };
  },
};

// ── Preview HTML ─────────────────────────────────────────────────────────────

const escHtml = (x: unknown) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function slideInnerHtml(s: GeneratedSlide): string {
  switch (s.layoutType) {
    case 'title':
      return `<div class="title-slide"><h1>${escHtml(latexToUnicode(s.title))}</h1>${s.subtitle ? `<p class="subtitle">${escHtml(latexToUnicode(s.subtitle))}</p>` : ''}</div>`;
    case 'definition_card':
      return (s.definitionCard || []).map((d) => `<div class="card"><b>${escHtml(latexToUnicode(d.term))}</b><p>${escHtml(latexToUnicode(d.definition))}</p></div>`).join('');
    case 'formula_highlight':
      return (s.formulaBox || []).map((f) => `<div class="card formula"><div class="expr">${escHtml(latexToUnicode(f.expression))}</div>${f.description ? `<p>${escHtml(latexToUnicode(f.description))}</p>` : ''}</div>`).join('');
    case 'example_box':
      return (s.exampleBox || []).map((e) => `<div class="card"><p>${escHtml(latexToUnicode(e.text))}</p></div>`).join('');
    case 'solved_example':
      return s.solvedExample
        ? `<div class="card"><b>Problem</b><p>${escHtml(latexToUnicode(s.solvedExample.problem))}</p></div><div class="card"><b>Solution</b><p>${escHtml(latexToUnicode(s.solvedExample.solution))}</p></div>`
        : '';
    case 'mcq_card':
      return (s.mcq || [])
        .map(
          (q) => `<div class="card mcq"><p class="q">${escHtml(latexToUnicode(q.question))}</p><div class="options">${q.options
            .map((o, i) => `<span class="${i === q.answerIndex ? 'answer' : ''}">${String.fromCharCode(65 + i)}) ${escHtml(latexToUnicode(o))}</span>`)
            .join('')}</div></div>`,
        )
        .join('');
    case 'table':
      return s.table
        ? `<table><thead><tr>${s.table.headers.map((h) => `<th>${escHtml(h)}</th>`).join('')}</tr></thead><tbody>${s.table.rows
            .map((r) => `<tr>${r.map((c) => `<td>${escHtml(latexToUnicode(c))}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`
        : '';
    default:
      return `<ul>${(s.bullets || []).map((b) => `<li>${escHtml(latexToUnicode(b))}</li>`).join('')}</ul>`;
  }
}

export function buildSlidesPreviewHtml(slides: GeneratedSlide[], theme: ThemeJSON): string {
  const sorted = [...slides].sort((a, b) => a.slideIndex - b.slideIndex);
  const slidesHtml = sorted
    .map((s, idx) => {
      const heading = s.layoutType === 'title' ? '' : `<h2>${iconFor((s.layoutType === 'content_bullets' ? 'note' : s.layoutType.replace('_card', '').replace('_box', '').replace('_highlight', '')) as ContentType)} ${escHtml(latexToUnicode(s.title))}</h2>`;
      return `<div class="slide"><div class="slide-no">${idx + 1}</div>${heading}${slideInnerHtml(s)}</div>`;
    })
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:12px}
    .slide{position:relative;background:#${theme.colors.bg};aspect-ratio:16/9;border-radius:12px;
      box-shadow:0 4px 16px rgba(0,0,0,.08);padding:26px 30px;margin:0 0 16px 0;overflow:hidden}
    .slide-no{position:absolute;top:10px;right:14px;font-size:11px;color:#${theme.colors.muted};opacity:.7}
    h1{color:#${theme.colors.title};font-size:30px;margin:0}
    h2{color:#${theme.colors.accentPrimary};font-size:22px;margin:0 0 12px 0}
    .subtitle{color:#${theme.colors.body};font-size:16px;margin-top:10px}
    ul{margin:0;padding-left:22px}
    li{color:#${theme.colors.body};font-size:16px;margin:8px 0;line-height:1.4}
    .title-slide{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
    .card{background:#${theme.colors.surface};border:1.5px solid #${theme.colors.accentPrimary};border-radius:10px;padding:12px 14px;margin-bottom:10px;color:#${theme.colors.body}}
    .card b{color:#${theme.colors.title}}
    .card.formula .expr{font-size:22px;font-weight:700;color:#${theme.colors.accentSecondary};text-align:center}
    .card.mcq .q{font-weight:700;color:#${theme.colors.title};margin:0 0 8px}
    .card.mcq .options{display:grid;grid-template-columns:1fr 1fr;gap:4px 16px}
    .card.mcq .options .answer{color:#${theme.colors.accentPrimary};font-weight:700}
    table{width:100%;border-collapse:collapse;font-size:14px;color:#${theme.colors.body}}
    th,td{border:1px solid #${theme.colors.accentPrimary};padding:6px 8px;text-align:left}
    th{background:#${theme.colors.accentPrimary};color:#fff}
  </style></head><body>${slidesHtml}</body></html>`;
}
