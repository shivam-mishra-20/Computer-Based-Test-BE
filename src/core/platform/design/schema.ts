/**
 * MIRROR of platform-client-core/src/design/schema.ts — edit THAT file, then copy.
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

/* ══ Mirrored body ═══════════════════════════════════════════════════════════
 * Everything from this line down is copied byte for byte into central-be
 * (src/core/platform/design/). Edit it here, then copy it across;
 * `npm run safety:design-rules` in central-be fails on any difference.
 * ══════════════════════════════════════════════════════════════════════════ */

/** Bumped only when a stored selection would be read differently. */
export const DESIGN_SCHEMA_VERSION = 1 as const;

/* ══════════════════════════════════════════════════════════════════════════
   SCREENS
   ══════════════════════════════════════════════════════════════════════════ */

/** The screens every template must lay out. */
export const SCREEN_IDS = [
  'home',
  'exams',
  'waiting',
  'player',
  'results',
  'progress',
  'timetable',
  'attendance',
  'resources',
  'alerts',
  'profile',
  'parent',
] as const;
export type ScreenId = (typeof SCREEN_IDS)[number];

/** The composition each screen may take. Every template picks one per screen. */
export const SCREEN_LAYOUTS = {
  home: ['focus', 'hero', 'editorial', 'bento', 'dashboard', 'grid', 'flow', 'layers', 'progress', 'chapters', 'bulletin', 'tasks'],
  exams: ['cards', 'rows', 'tickets', 'timeline', 'grouped'],
  waiting: ['checklist', 'countdown', 'document'],
  player: ['standard'],
  results: ['score-hero', 'report-card', 'scoreboard', 'editorial'],
  progress: ['rings', 'bars', 'chart-first', 'heatmap'],
  timetable: ['agenda', 'timeline', 'blocks', 'table'],
  attendance: ['calendar', 'ring-summary', 'ledger', 'strip'],
  resources: ['shelf', 'list', 'grid', 'chapters'],
  alerts: ['feed', 'board', 'inbox', 'bulletin'],
  profile: ['centered', 'banner', 'id-card', 'list'],
  parent: ['summary', 'report', 'cards'],
} as const satisfies Record<ScreenId, readonly string[]>;

export type ScreenLayout<S extends ScreenId> = (typeof SCREEN_LAYOUTS)[S][number];

/** The blocks Home is assembled from; a template orders them. */
export const HOME_SECTIONS = ['hero', 'stats', 'subjects', 'upcoming', 'schedule', 'results', 'notices', 'tasks', 'resources'] as const;
export type HomeSection = (typeof HOME_SECTIONS)[number];

/**
 * The exam player is the one screen whose composition is NOT a template
 * choice: question, options and navigation stay where every student expects
 * them. A template may only restyle the option marker and the timer.
 */
export const PLAYER_OPTIONS = ['letter-circle', 'letter-square', 'radio', 'outline-row'] as const;
export const PLAYER_TIMERS = ['pill', 'text', 'bar'] as const;

export interface ScreenConfigs {
  home: { layout: ScreenLayout<'home'>; sections: HomeSection[] };
  exams: { layout: ScreenLayout<'exams'> };
  waiting: { layout: ScreenLayout<'waiting'> };
  player: {
    layout: ScreenLayout<'player'>;
    option: (typeof PLAYER_OPTIONS)[number];
    timer: (typeof PLAYER_TIMERS)[number];
  };
  results: { layout: ScreenLayout<'results'> };
  progress: { layout: ScreenLayout<'progress'> };
  timetable: { layout: ScreenLayout<'timetable'> };
  attendance: { layout: ScreenLayout<'attendance'> };
  resources: { layout: ScreenLayout<'resources'> };
  alerts: { layout: ScreenLayout<'alerts'> };
  profile: { layout: ScreenLayout<'profile'> };
  parent: { layout: ScreenLayout<'parent'> };
}

/* ══════════════════════════════════════════════════════════════════════════
   IDENTITY
   ══════════════════════════════════════════════════════════════════════════ */

export const CATEGORY_IDS = ['natural', 'premium', 'contemporary', 'digital', 'learning'] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export const CATEGORIES: readonly { id: CategoryId; label: string; description: string }[] = [
  { id: 'natural', label: 'Natural & Minimal', description: 'Calm surfaces, organic tones, generous space.' },
  { id: 'premium', label: 'Premium & Professional', description: 'Structured, typographic, institutional.' },
  { id: 'contemporary', label: 'Contemporary & Expressive', description: 'Colour-led, friendly, modern.' },
  { id: 'digital', label: 'Modern Digital', description: 'Depth, contrast and digital-native detail.' },
  { id: 'learning', label: 'Learning-Centred', description: 'Built around how students study and plan.' },
];

export interface TemplateMeta {
  /** Stable slug — what a stored selection refers to. Never renamed. */
  id: string;
  name: string;
  category: CategoryId;
  /** One sentence for the gallery card. */
  description: string;
  /** Three or four words describing the feel, for search. */
  keywords: string[];
  /** The template's own semver. Major = a stored selection may look different. */
  version: string;
  compatibility: {
    schema: typeof DESIGN_SCHEMA_VERSION;
    /** The oldest app build whose renderer knows every variant used here. */
    minAppVersion: string;
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   COLOUR
   ══════════════════════════════════════════════════════════════════════════ */

export const APPEARANCE_STRATEGIES = ['light-only', 'dark-only', 'adaptive'] as const;

export interface AppearanceStrategy {
  strategy: (typeof APPEARANCE_STRATEGIES)[number];
  /** The mode shown first, and used when the device expresses no preference. */
  default: 'light' | 'dark';
  /** Why this strategy — shown in the preview, so a light-only choice reads as intended. */
  note: string;
}

export const STATUS_STYLES = ['standard', 'earthy'] as const;

/**
 * The colours a template author writes. Everything else — text on the brand,
 * tints, strokes, navigation states, status inks — is DERIVED by the resolver
 * against the contrast each job needs, so an organization's own primary colour
 * can replace this one and still produce a legible app.
 */
export interface SeedPalette {
  canvas: string;
  surface: string;
  /** Quiet fills inside a surface: skeletons, inactive segments, wells. */
  surfaceAlt: string;
  text: string;
  textSecondary: string;
  /** Decorative dividers. Control boundaries are derived from it. */
  border: string;
  primary: string;
  accent: string;
  /** A deep band for headers and hero blocks. Defaults to a deepened primary. */
  inverse?: string;
  /** Two stops, used only where a template's components ask for a gradient. */
  gradient?: [string, string];
  /** Soft background shapes (glass, orbs). At most three. */
  backdrop?: string[];
  /** Chart series. At most four; derived from primary/accent when absent. */
  chart?: string[];
  /** The navigation surface. Defaults to `surface`. */
  nav?: string;
  status?: (typeof STATUS_STYLES)[number];
}

/* ══════════════════════════════════════════════════════════════════════════
   TYPE
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Typeface FAMILIES by character, not font files.
 *
 * `rounded` is Nunito, already bundled. Every other key maps to faces the
 * platform ships (Georgia / Palatino / Avenir Next / Helvetica Neue / Menlo on
 * iOS and the web, Noto Serif / Roboto / condensed / mono on Android), so a
 * template adds no font dependency and nothing to download. Android has fewer
 * faces, so two serif keys can look alike there — the scale, weight, case and
 * tracking still differ, which is most of what makes type read differently.
 */
export const FONT_KEYS = [
  'rounded',
  'humanist',
  'grotesk',
  'geometric',
  'condensed',
  'serif',
  'oldstyle',
  'transitional',
  'didone',
  'mono',
] as const;
export type FontKey = (typeof FONT_KEYS)[number];

export const WEIGHTS = ['400', '500', '600', '700', '800', '900'] as const;
export type Weight = (typeof WEIGHTS)[number];

export interface TypographyTokens {
  faces: {
    /** Greetings, scores, screen titles. */
    display: FontKey;
    /** Body copy, list items, questions. */
    text: FontKey;
    /** Overlines, chips, badges, navigation. */
    label: FontKey;
    /** Big figures and the timer. */
    numeric: FontKey;
  };
  weights: { display: Weight; heading: Weight; text: Weight; strong: Weight; label: Weight };
  /** Point sizes. Bounded by the validator; the player has its own floor. */
  sizes: {
    display: number;
    title: number;
    heading: number;
    subheading: number;
    body: number;
    small: number;
    caption: number;
    stat: number;
  };
  /** Body line height as a multiple of size. */
  leading: number;
  /** Display line height as a multiple of size. */
  displayLeading: number;
  tracking: { display: number; label: number };
  labelCase: 'upper' | 'none';
  /** Editorial templates set display type in italic. */
  displayItalic: boolean;
}

/* ══════════════════════════════════════════════════════════════════════════
   SPACE, SHAPE, SURFACE
   ══════════════════════════════════════════════════════════════════════════ */

export const DENSITIES = ['compact', 'regular', 'airy'] as const;
export type Density = (typeof DENSITIES)[number];

export interface SpacingTokens {
  /** The template's native rhythm — a label for the gallery, and the default. */
  density: Density;
  gutter: number;
  gap: number;
  cardPad: number;
  section: number;
}

/** A radius, or four (top-left, top-right, bottom-right, bottom-left) for organic shapes. */
export type Corner = number | [number, number, number, number];

export interface ShapeTokens {
  card: Corner;
  hero: Corner;
  /** Buttons and inputs. 999 is a pill. */
  control: number;
  chip: number;
  icon: Corner;
  sheet: number;
}

export const SURFACE_STYLES = [
  'flat', // no chrome beyond an optional hairline
  'outlined', // a border does the separating
  'raised', // soft shadow
  'glass', // translucent over a soft backdrop
  'offset', // hard offset shadow and a heavy border
  'paper', // a sheet on a sheet
  'framed', // double rule
  'tonal', // filled with a quiet tint, no border
  'bracket', // hairline with corner marks
  'bound', // a book cover: a darker spine down the leading edge
] as const;

export interface SurfaceTokens {
  style: (typeof SURFACE_STYLES)[number];
  borderWidth: number;
  /** 0–3. What `raised` and `glass` lift by. */
  elevation: number;
  /** `glass` only: how much of the surface colour shows (0.55–0.92). */
  glassOpacity?: number;
  /** `offset` only: the hard shadow's distance. */
  offset?: number;
}

/* ══════════════════════════════════════════════════════════════════════════
   COMPONENTS
   ══════════════════════════════════════════════════════════════════════════ */

export const BUTTON_SHAPES = ['pill', 'rounded', 'square'] as const;
export const BUTTON_FILLS = ['solid', 'gradient', 'offset'] as const;
export const PRESS_STYLES = ['scale', 'dim', 'sink'] as const;
export const BADGE_STYLES = ['soft-pill', 'solid-pill', 'outline', 'tag', 'dot', 'stamp', 'block', 'kicker'] as const;
export const ICON_SETS = ['outline', 'filled', 'sharp'] as const;
export const ICON_CONTAINERS = ['none', 'circle', 'squircle', 'square', 'leaf', 'arch', 'ring', 'frame'] as const;
export const ICON_TONES = ['soft', 'solid', 'plain'] as const;
export const PROGRESS_STYLES = ['ring', 'bar', 'segmented', 'steps', 'arc', 'numeric', 'dots', 'gradient-bar'] as const;
export const CHART_STYLES = ['bars', 'columns', 'line', 'dots', 'lollipop'] as const;
export const LIST_STYLES = ['cards', 'rows', 'timeline', 'ledger', 'articles', 'numbered', 'tasks'] as const;
export const SECTION_TITLE_STYLES = ['plain', 'overline', 'rule', 'numbered', 'ornament', 'centered', 'kicker', 'bar'] as const;
export const DIVIDER_STYLES = ['hairline', 'thick', 'double', 'dotted'] as const;
export const AVATAR_STYLES = ['circle', 'squircle', 'square', 'monogram'] as const;
export const EMPTY_STYLES = ['icon', 'typographic', 'framed', 'illustrated'] as const;
export const LOADING_STYLES = ['skeleton', 'bar', 'dots'] as const;
export const NOTICE_STYLES = ['banner', 'card', 'inline', 'stripe'] as const;

export interface ComponentVariants {
  button: {
    shape: (typeof BUTTON_SHAPES)[number];
    fill: (typeof BUTTON_FILLS)[number];
    case: 'upper' | 'none';
    pressed: (typeof PRESS_STYLES)[number];
  };
  badge: (typeof BADGE_STYLES)[number];
  icon: {
    set: (typeof ICON_SETS)[number];
    container: (typeof ICON_CONTAINERS)[number];
    tone: (typeof ICON_TONES)[number];
  };
  progress: (typeof PROGRESS_STYLES)[number];
  chart: (typeof CHART_STYLES)[number];
  list: (typeof LIST_STYLES)[number];
  sectionTitle: (typeof SECTION_TITLE_STYLES)[number];
  divider: (typeof DIVIDER_STYLES)[number];
  avatar: (typeof AVATAR_STYLES)[number];
  states: {
    empty: (typeof EMPTY_STYLES)[number];
    loading: (typeof LOADING_STYLES)[number];
    notice: (typeof NOTICE_STYLES)[number];
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   CHROME
   ══════════════════════════════════════════════════════════════════════════ */

export const HEADER_STYLES = [
  'minimal',
  'greeting',
  'banner',
  'wave',
  'masthead',
  'letterhead',
  'band',
  'crest',
  'index',
  'centered',
  'compact',
  'block',
  'gradient',
  'announcement',
  'hud',
  'split',
  'bookshelf',
  'burst',
  'glass',
] as const;

export const NAV_STYLES = [
  'floating-pill',
  'floating-icons',
  'docked',
  'docked-pill',
  'bordered',
  'boxed',
  'underline',
  'glass-dock',
  'notched',
  'segmented',
  'minimal-dots',
  'bookmark',
] as const;

export const MOTIFS = ['none', 'leaf', 'paper', 'waves', 'grid', 'orbs', 'rules', 'arches', 'blobs', 'confetti', 'circuit', 'spines'] as const;

export interface LayoutVariants {
  /** Home's header. Other screens use a plainer header in the same voice. */
  header: (typeof HEADER_STYLES)[number];
  nav: (typeof NAV_STYLES)[number];
  /** Decoration behind headers and heroes. Never behind body text, never in the player. */
  motif: (typeof MOTIFS)[number];
}

/* ══════════════════════════════════════════════════════════════════════════
   THE TEMPLATE
   ══════════════════════════════════════════════════════════════════════════ */

export interface DesignTemplate {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  meta: TemplateMeta;
  appearance: AppearanceStrategy;
  colors: { light?: SeedPalette; dark?: SeedPalette };
  typography: TypographyTokens;
  spacing: SpacingTokens;
  shape: ShapeTokens;
  surface: SurfaceTokens;
  components: ComponentVariants;
  layout: LayoutVariants;
  screens: ScreenConfigs;
}

/* ══════════════════════════════════════════════════════════════════════════
   WHAT AN ORGANIZATION MAY CHANGE
   ══════════════════════════════════════════════════════════════════════════ */

export const APPEARANCE_PREFERENCES = ['light', 'dark', 'system'] as const;
export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];

/**
 * The whole list. Each is validated and each passes through the same contrast
 * derivation as the template's own colours, so no override can make text
 * unreadable — a pale brand is deepened for text exactly as `skin.ts` does.
 */
export interface DesignOverrides {
  primaryColor?: string;
  accentColor?: string;
  appearance?: AppearancePreference;
  density?: Density;
}
