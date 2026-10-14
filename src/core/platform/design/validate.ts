/**
 * MIRROR of platform-client-core/src/design/validate.ts — edit THAT file, then copy.
 *
 * The design-template rules are shared by the mobile app, the web Design
 * Studio and the platform console through @platform/client-core. This server
 * needs the same answers — which templates exist, what a valid selection is,
 * which lifecycle moves are allowed and by whom — but it cannot import a
 * sibling repository (see the header of ../mobileBuildRules.ts for why).
 *
 * So everything from the "Mirrored body" marker down is a byte-for-byte copy,
 * and `npm run safety:design-rules` fails on any difference.
 */

import { normalizeHex } from './hex';
import {
  APPEARANCE_PREFERENCES,
  APPEARANCE_STRATEGIES,
  AVATAR_STYLES,
  BADGE_STYLES,
  BUTTON_FILLS,
  BUTTON_SHAPES,
  CATEGORY_IDS,
  CHART_STYLES,
  DENSITIES,
  DESIGN_SCHEMA_VERSION,
  DIVIDER_STYLES,
  EMPTY_STYLES,
  FONT_KEYS,
  HEADER_STYLES,
  HOME_SECTIONS,
  ICON_CONTAINERS,
  ICON_SETS,
  ICON_TONES,
  LIST_STYLES,
  LOADING_STYLES,
  MOTIFS,
  NAV_STYLES,
  NOTICE_STYLES,
  PLAYER_OPTIONS,
  PLAYER_TIMERS,
  PRESS_STYLES,
  PROGRESS_STYLES,
  SCREEN_IDS,
  SCREEN_LAYOUTS,
  SECTION_TITLE_STYLES,
  STATUS_STYLES,
  SURFACE_STYLES,
  WEIGHTS,
  type DesignOverrides,
  type DesignTemplate,
  type SeedPalette,
} from './schema';

/* ══ Mirrored body ═══════════════════════════════════════════════════════════
 * Everything from this line down is copied byte for byte into central-be
 * (src/core/platform/design/). Edit it here, then copy it across;
 * `npm run safety:design-rules` in central-be fails on any difference.
 * ══════════════════════════════════════════════════════════════════════════ */

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

/* ══════════════════════════════════════════════════════════════════════════
   PLAIN DATA
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * True when a value is JSON all the way down: no function, no class instance,
 * no symbol, no non-finite number. A template is stored and transmitted, so
 * anything JSON cannot carry is either a bug or something smuggled in.
 */
export function isPlainData(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object': {
      if (Array.isArray(value)) return value.every((v) => isPlainData(v, depth + 1));
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return false;
      return Object.values(value as Record<string, unknown>).every((v) => isPlainData(v, depth + 1));
    }
    default:
      return false;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   TEMPLATES
   ══════════════════════════════════════════════════════════════════════════ */

function oneOf(list: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && list.includes(value);
}

function inRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function cornerOk(value: unknown): boolean {
  if (typeof value === 'number') return inRange(value, 0, 999);
  return Array.isArray(value) && value.length === 4 && value.every((v) => inRange(v, 0, 999));
}

const PALETTE_REQUIRED: (keyof SeedPalette)[] = [
  'canvas',
  'surface',
  'surfaceAlt',
  'text',
  'textSecondary',
  'border',
  'primary',
  'accent',
];

function paletteProblems(name: string, p: SeedPalette | undefined): string[] {
  if (!p) return [];
  const out: string[] = [];
  for (const key of PALETTE_REQUIRED) {
    if (!HEX6.test(String(p[key] ?? ''))) out.push(`${name}.${key} must be #rrggbb`);
  }
  for (const key of ['inverse', 'nav'] as const) {
    if (p[key] !== undefined && !HEX6.test(String(p[key]))) out.push(`${name}.${key} must be #rrggbb`);
  }
  if (p.gradient !== undefined && !(Array.isArray(p.gradient) && p.gradient.length === 2 && p.gradient.every((c) => HEX6.test(c)))) {
    out.push(`${name}.gradient must be two #rrggbb stops`);
  }
  for (const [key, max] of [['backdrop', 3], ['chart', 4]] as const) {
    const list = p[key];
    if (list !== undefined && !(Array.isArray(list) && list.length <= max && list.every((c) => HEX6.test(c)))) {
      out.push(`${name}.${key} must be at most ${max} #rrggbb colours`);
    }
  }
  if (p.status !== undefined && !oneOf(STATUS_STYLES, p.status)) out.push(`${name}.status is not a status style`);
  return out;
}

/**
 * Every problem with a template, as sentences. Empty means valid.
 *
 * Bounds are design bounds, not type bounds: a body size of 11 is a number,
 * and it is also a template that fails a student reading on a bus.
 */
export function validateTemplate(t: DesignTemplate): string[] {
  const out: string[] = [];
  const need = (ok: boolean, problem: string) => {
    if (!ok) out.push(problem);
  };

  need(isPlainData(t), 'template must be plain JSON data (no functions or instances)');
  need(t.schemaVersion === DESIGN_SCHEMA_VERSION, `schemaVersion must be ${DESIGN_SCHEMA_VERSION}`);

  // -- Identity ---------------------------------------------------------------
  const m = t.meta;
  need(SLUG.test(m.id) && m.id.length <= 40, 'meta.id must be a short kebab-case slug');
  need(typeof m.name === 'string' && m.name.length >= 3 && m.name.length <= 32, 'meta.name must be 3–32 characters');
  need(oneOf(CATEGORY_IDS, m.category), 'meta.category is not a category');
  need(typeof m.description === 'string' && m.description.length >= 20 && m.description.length <= 140, 'meta.description must be 20–140 characters');
  need(Array.isArray(m.keywords) && m.keywords.length >= 2 && m.keywords.length <= 6, 'meta.keywords must list 2–6 words');
  need(SEMVER.test(m.version), 'meta.version must be semver');
  need(m.compatibility?.schema === DESIGN_SCHEMA_VERSION, 'meta.compatibility.schema must match the schema');
  need(SEMVER.test(m.compatibility?.minAppVersion ?? ''), 'meta.compatibility.minAppVersion must be semver');

  // -- Appearance -------------------------------------------------------------
  const a = t.appearance;
  need(oneOf(APPEARANCE_STRATEGIES, a.strategy), 'appearance.strategy is not a strategy');
  need(a.default === 'light' || a.default === 'dark', 'appearance.default must be light or dark');
  need(typeof a.note === 'string' && a.note.length >= 10, 'appearance.note must explain the strategy');
  if (a.strategy === 'light-only') need(Boolean(t.colors.light) && a.default === 'light', 'a light-only template needs a light palette and a light default');
  if (a.strategy === 'dark-only') need(Boolean(t.colors.dark) && a.default === 'dark', 'a dark-only template needs a dark palette and a dark default');
  if (a.strategy === 'adaptive') need(Boolean(t.colors.light && t.colors.dark), 'an adaptive template needs both palettes');
  out.push(...paletteProblems('colors.light', t.colors.light), ...paletteProblems('colors.dark', t.colors.dark));

  // -- Type -------------------------------------------------------------------
  const ty = t.typography;
  for (const [role, face] of Object.entries(ty.faces)) need(oneOf(FONT_KEYS, face), `typography.faces.${role} is not a font key`);
  for (const [role, weight] of Object.entries(ty.weights)) need(oneOf(WEIGHTS, weight), `typography.weights.${role} is not a weight`);
  const sizeBounds: Record<keyof typeof ty.sizes, [number, number]> = {
    display: [22, 48],
    title: [20, 36],
    heading: [14, 24],
    subheading: [13, 19],
    body: [14, 18],
    small: [12, 15],
    caption: [11, 13],
    stat: [22, 56],
  };
  for (const [role, [min, max]] of Object.entries(sizeBounds) as [keyof typeof ty.sizes, [number, number]][]) {
    need(inRange(ty.sizes[role], min, max), `typography.sizes.${role} must be ${min}–${max}`);
  }
  need(ty.sizes.display >= ty.sizes.title && ty.sizes.title > ty.sizes.heading && ty.sizes.heading >= ty.sizes.body, 'type sizes must descend display ≥ title > heading ≥ body');
  need(inRange(ty.leading, 1.3, 1.7), 'typography.leading must be 1.3–1.7');
  need(inRange(ty.displayLeading, 1.0, 1.4), 'typography.displayLeading must be 1.0–1.4');
  need(inRange(ty.tracking.display, -1.5, 1), 'typography.tracking.display must be -1.5–1');
  need(inRange(ty.tracking.label, 0, 2), 'typography.tracking.label must be 0–2');
  need(ty.labelCase === 'upper' || ty.labelCase === 'none', 'typography.labelCase must be upper or none');
  need(typeof ty.displayItalic === 'boolean', 'typography.displayItalic must be a boolean');

  // -- Space, shape, surface --------------------------------------------------
  const s = t.spacing;
  need(oneOf(DENSITIES, s.density), 'spacing.density is not a density');
  need(inRange(s.gutter, 14, 28), 'spacing.gutter must be 14–28');
  need(inRange(s.gap, 6, 20), 'spacing.gap must be 6–20');
  need(inRange(s.cardPad, 10, 24), 'spacing.cardPad must be 10–24');
  need(inRange(s.section, 14, 40), 'spacing.section must be 14–40');
  for (const key of ['card', 'hero', 'icon'] as const) need(cornerOk(t.shape[key]), `shape.${key} must be a radius or four radii`);
  for (const key of ['control', 'chip', 'sheet'] as const) need(inRange(t.shape[key], 0, 999), `shape.${key} must be 0–999`);
  const su = t.surface;
  need(oneOf(SURFACE_STYLES, su.style), 'surface.style is not a surface style');
  need(inRange(su.borderWidth, 0, 3), 'surface.borderWidth must be 0–3');
  need(inRange(su.elevation, 0, 3), 'surface.elevation must be 0–3');
  if (su.style === 'glass') need(inRange(su.glassOpacity, 0.55, 0.92), 'a glass surface needs glassOpacity 0.55–0.92');
  if (su.style === 'offset') need(inRange(su.offset, 2, 8), 'an offset surface needs offset 2–8');

  // -- Components -------------------------------------------------------------
  const c = t.components;
  need(oneOf(BUTTON_SHAPES, c.button.shape), 'components.button.shape');
  need(oneOf(BUTTON_FILLS, c.button.fill), 'components.button.fill');
  need(c.button.case === 'upper' || c.button.case === 'none', 'components.button.case');
  need(oneOf(PRESS_STYLES, c.button.pressed), 'components.button.pressed');
  need(oneOf(BADGE_STYLES, c.badge), 'components.badge');
  need(oneOf(ICON_SETS, c.icon.set), 'components.icon.set');
  need(oneOf(ICON_CONTAINERS, c.icon.container), 'components.icon.container');
  need(oneOf(ICON_TONES, c.icon.tone), 'components.icon.tone');
  need(oneOf(PROGRESS_STYLES, c.progress), 'components.progress');
  need(oneOf(CHART_STYLES, c.chart), 'components.chart');
  need(oneOf(LIST_STYLES, c.list), 'components.list');
  need(oneOf(SECTION_TITLE_STYLES, c.sectionTitle), 'components.sectionTitle');
  need(oneOf(DIVIDER_STYLES, c.divider), 'components.divider');
  need(oneOf(AVATAR_STYLES, c.avatar), 'components.avatar');
  need(oneOf(EMPTY_STYLES, c.states.empty), 'components.states.empty');
  need(oneOf(LOADING_STYLES, c.states.loading), 'components.states.loading');
  need(oneOf(NOTICE_STYLES, c.states.notice), 'components.states.notice');
  if (c.button.fill === 'gradient') need(Boolean(t.colors.light?.gradient ?? t.colors.dark?.gradient), 'a gradient button needs a gradient in the palette');
  if (su.style === 'glass') need(Boolean((t.colors.light?.backdrop ?? t.colors.dark?.backdrop)?.length), 'a glass surface needs a backdrop to be glass over');

  // -- Chrome & screens -------------------------------------------------------
  need(oneOf(HEADER_STYLES, t.layout.header), 'layout.header');
  need(oneOf(NAV_STYLES, t.layout.nav), 'layout.nav');
  need(oneOf(MOTIFS, t.layout.motif), 'layout.motif');

  for (const id of SCREEN_IDS) {
    const screen = t.screens[id] as { layout?: unknown } | undefined;
    need(Boolean(screen), `screens.${id} is missing`);
    if (screen) need(oneOf(SCREEN_LAYOUTS[id], screen.layout), `screens.${id}.layout is not one of ${SCREEN_LAYOUTS[id].join(', ')}`);
  }
  const extraScreens = Object.keys(t.screens).filter((k) => !(SCREEN_IDS as readonly string[]).includes(k));
  need(extraScreens.length === 0, `screens has unknown keys: ${extraScreens.join(', ')}`);
  const sections = t.screens.home?.sections ?? [];
  need(sections.length >= 3 && sections.length <= 6, 'screens.home.sections must list 3–6 sections');
  need(sections.every((x) => oneOf(HOME_SECTIONS, x)), 'screens.home.sections has an unknown section');
  need(new Set(sections).size === sections.length, 'screens.home.sections repeats a section');
  need(oneOf(PLAYER_OPTIONS, t.screens.player?.option), 'screens.player.option');
  need(oneOf(PLAYER_TIMERS, t.screens.player?.timer), 'screens.player.timer');

  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   OVERRIDES
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * An administrator's overrides, reduced to the declared keys with valid
 * values. Anything else is dropped silently: an unknown key is not an error
 * the person can act on, and a malformed colour is simply not applied.
 */
export function normalizeOverrides(value: unknown): DesignOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const src = value as Record<string, unknown>;
  const out: DesignOverrides = {};
  const primary = typeof src.primaryColor === 'string' ? normalizeHex(src.primaryColor) : null;
  if (primary) out.primaryColor = primary;
  const accent = typeof src.accentColor === 'string' ? normalizeHex(src.accentColor) : null;
  if (accent) out.accentColor = accent;
  if (oneOf(APPEARANCE_PREFERENCES, src.appearance)) out.appearance = src.appearance as DesignOverrides['appearance'];
  if (oneOf(DENSITIES, src.density)) out.density = src.density as DesignOverrides['density'];
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   SELECTIONS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * What an organization's choice IS, as stored: a template reference, the
 * template version it was made against, and the overrides. Never the tokens —
 * a stored selection re-resolves against the template the device ships, so a
 * contrast fix in a template reaches every organization using it.
 */
export interface DesignSelection {
  kind: 'org-app-design';
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  templateId: string;
  templateVersion: string;
  overrides: DesignOverrides;
}

export type SelectionCompatibility =
  /** Same template, same major version: renders as chosen. */
  | 'exact'
  /** Same template, newer minor/patch: renders with the template's fixes. */
  | 'compatible'
  /** The template's major version changed: it may look different from what was approved. */
  | 'major-changed'
  /** The template is not in this build. */
  | 'unknown-template';

function major(version: string): number {
  return Number(version.split('.')[0]);
}

/**
 * A stored selection, reduced to exactly its declared keys — or null when it
 * is not a selection at all. `catalogue` supplies the templates this build
 * knows; compatibility says how the stored version relates to the shipped one.
 */
export function normalizeDesignSelection(
  value: unknown,
  catalogue: readonly DesignTemplate[],
): { selection: DesignSelection; compatibility: SelectionCompatibility } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const src = value as Record<string, unknown>;
  if (src.kind !== 'org-app-design') return null;
  if (src.schemaVersion !== DESIGN_SCHEMA_VERSION) return null;
  if (typeof src.templateId !== 'string' || !SLUG.test(src.templateId)) return null;
  if (typeof src.templateVersion !== 'string' || !SEMVER.test(src.templateVersion)) return null;

  const selection: DesignSelection = {
    kind: 'org-app-design',
    schemaVersion: DESIGN_SCHEMA_VERSION,
    templateId: src.templateId,
    templateVersion: src.templateVersion,
    overrides: normalizeOverrides(src.overrides),
  };

  const template = catalogue.find((t) => t.meta.id === selection.templateId);
  let compatibility: SelectionCompatibility;
  if (!template) compatibility = 'unknown-template';
  else if (major(template.meta.version) !== major(selection.templateVersion)) compatibility = 'major-changed';
  else compatibility = template.meta.version === selection.templateVersion ? 'exact' : 'compatible';

  return { selection, compatibility };
}

/** A fresh selection of a template, at the version this build ships. */
export function selectionFor(template: DesignTemplate, overrides: unknown = {}): DesignSelection {
  return {
    kind: 'org-app-design',
    schemaVersion: DESIGN_SCHEMA_VERSION,
    templateId: template.meta.id,
    templateVersion: template.meta.version,
    overrides: normalizeOverrides(overrides),
  };
}
