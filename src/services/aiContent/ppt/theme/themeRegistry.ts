/**
 * Static JSON theme lookup — Stage 12 (Theme Engine), no LLM call. `professional`
 * is the new default (near-black, orange + blue accents, per the requested
 * visual identity). The 6 pre-existing pptxRenderer.ts themes are kept as
 * aliases with their EXACT original colors, so old AiGeneration.contentJSON
 * `theme` string values (from before this pipeline existed) keep resolving.
 */
import { ICON_MAP } from './icons';
import type { ThemeJSON } from '../../../aiOrchestrator/interfaces';

function cardStylesFrom(fill: string, border: string): ThemeJSON['cardStyles'] {
  return {
    definition: { fill, border },
    formula: { fill, border },
    example: { fill, border },
    mcq: { fill, border },
    summary: { fill, border },
    question: { fill, border },
  };
}

const PROFESSIONAL: ThemeJSON = {
  id: 'professional',
  name: 'Professional Black',
  colors: {
    bg: '0B0B0F',
    surface: '1A1A21',
    title: 'FFFFFF',
    body: 'D4D4D8',
    accentPrimary: 'F97316', // orange
    accentSecondary: '38BDF8', // blue
    muted: '71717A',
  },
  typography: { headingFont: 'Calibri', bodyFont: 'Calibri', headingSizePt: 30, bodySizePt: 18 },
  cardStyles: cardStylesFrom('1A1A21', 'F97316'),
  iconMap: ICON_MAP,
};

// Legacy pptxRenderer.ts THEMES map, exact hex values preserved, adapted into
// the richer ThemeJSON shape (accentSecondary/surface/muted are new fields
// with reasonable derived defaults — these themes were never card-based
// before, so there's no "original" value to preserve for them).
const LEGACY: Record<string, ThemeJSON> = {
  default: {
    id: 'default', name: 'Classic',
    colors: { bg: 'FFFFFF', surface: 'F8FAFC', title: '0F172A', body: '334155', accentPrimary: '0EA5E9', accentSecondary: '6366F1', muted: '94A3B8' },
    typography: { headingFont: 'Calibri', bodyFont: 'Calibri', headingSizePt: 30, bodySizePt: 18 },
    cardStyles: cardStylesFrom('F8FAFC', '0EA5E9'),
    iconMap: ICON_MAP,
  },
  ocean: {
    id: 'ocean', name: 'Ocean',
    colors: { bg: 'F0F9FF', surface: 'FFFFFF', title: '075985', body: '0C4A6E', accentPrimary: '0284C7', accentSecondary: '0EA5E9', muted: '7DD3FC' },
    typography: { headingFont: 'Calibri', bodyFont: 'Calibri', headingSizePt: 30, bodySizePt: 18 },
    cardStyles: cardStylesFrom('FFFFFF', '0284C7'),
    iconMap: ICON_MAP,
  },
  forest: {
    id: 'forest', name: 'Forest',
    colors: { bg: 'F0FDF4', surface: 'FFFFFF', title: '14532D', body: '166534', accentPrimary: '16A34A', accentSecondary: '65A30D', muted: '86EFAC' },
    typography: { headingFont: 'Calibri', bodyFont: 'Calibri', headingSizePt: 30, bodySizePt: 18 },
    cardStyles: cardStylesFrom('FFFFFF', '16A34A'),
    iconMap: ICON_MAP,
  },
  sunset: {
    id: 'sunset', name: 'Sunset',
    colors: { bg: 'FFF7ED', surface: 'FFFFFF', title: '7C2D12', body: '9A3412', accentPrimary: 'EA580C', accentSecondary: 'DC2626', muted: 'FDBA74' },
    typography: { headingFont: 'Calibri', bodyFont: 'Calibri', headingSizePt: 30, bodySizePt: 18 },
    cardStyles: cardStylesFrom('FFFFFF', 'EA580C'),
    iconMap: ICON_MAP,
  },
  violet: {
    id: 'violet', name: 'Violet',
    colors: { bg: 'FAF5FF', surface: 'FFFFFF', title: '581C87', body: '6B21A8', accentPrimary: '7C3AED', accentSecondary: 'C026D3', muted: 'D8B4FE' },
    typography: { headingFont: 'Calibri', bodyFont: 'Calibri', headingSizePt: 30, bodySizePt: 18 },
    cardStyles: cardStylesFrom('FFFFFF', '7C3AED'),
    iconMap: ICON_MAP,
  },
  dark: {
    id: 'dark', name: 'Dark',
    colors: { bg: '0F172A', surface: '1E293B', title: 'F8FAFC', body: 'CBD5E1', accentPrimary: '38BDF8', accentSecondary: 'A78BFA', muted: '64748B' },
    typography: { headingFont: 'Calibri', bodyFont: 'Calibri', headingSizePt: 30, bodySizePt: 18 },
    cardStyles: cardStylesFrom('1E293B', '38BDF8'),
    iconMap: ICON_MAP,
  },
};

export const THEMES: Record<string, ThemeJSON> = { professional: PROFESSIONAL, ...LEGACY };

export function resolveTheme(id?: string): ThemeJSON {
  const key = (id || 'professional').toLowerCase();
  return THEMES[key] || PROFESSIONAL;
}
