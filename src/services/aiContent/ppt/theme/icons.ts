/**
 * Icon system — deliberately NOT base64 PNG image assets (a deviation from
 * the architecture doc's literal wording, made during implementation): a
 * small colored roundRect/ellipse shape + a centered Unicode glyph, composed
 * natively at render time in pptxBuilder.ts via addShape+addText, is simpler,
 * has zero asset-generation risk (no SVG rasterization, no hand-authored
 * image bytes to get subtly wrong), and is MORE in the spirit of "everything
 * must be editable" than an embedded image would be. `iconMap` here is just
 * the ContentType -> glyph lookup; positioning/coloring lives in pptxBuilder.
 */
import type { ContentType } from '../../../aiOrchestrator/interfaces';

export const ICON_MAP: Record<ContentType, string> = {
  objectives: '\u{1F3AF}', // 🎯
  definition: '\u{1F4D6}', // 📖
  explanation: '\u{1F4AC}', // 💬
  formula: '∑', // ∑
  example: '\u{1F4A1}', // 💡
  solved_example: '✅', // ✅
  mcq: '☑', // ☑
  homework: '✏', // ✏
  summary: '\u{1F6A9}', // 🚩
  table: '\u{1F4CA}', // 📊
  note: '\u{1F4DD}', // 📝
};

export function iconFor(contentType: ContentType): string {
  return ICON_MAP[contentType] || '•';
}
