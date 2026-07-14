/**
 * Lecture Blueprint — the editable lecture plan that sits between the AI
 * Lecture Planner (phase 1) and PPT generation (phase 2). Teachers don't
 * think "generate 25 slides"; they think "teach this concept, then practice,
 * then the next topic, then a quiz, then homework" — the blueprint is that
 * plan, as JSON: sections with kinds, slide counts, per-section teaching
 * controls, and an estimated duration.
 *
 * Once approved, the blueprint is the SINGLE SOURCE OF TRUTH for generation:
 * the compiler (blueprintCompiler.ts) expands it 1:1 into slide briefs and
 * nothing downstream re-decides lecture flow.
 *
 * The shape is deliberately plain JSON so it can be edited in the app, saved,
 * reused as a template (BlueprintTemplate collection), and shared across
 * lectures. Everything arriving from the client goes through
 * coerceBlueprint() — the server never trusts a client-supplied plan blindly.
 */
import type { ContentType } from '../../aiOrchestrator/interfaces';

export type SectionKind =
  | 'objectives'
  | 'concept'
  | 'practice'
  | 'revision'
  | 'activity'
  | 'summary'
  | 'homework';

export const SECTION_KINDS: SectionKind[] = [
  'objectives', 'concept', 'practice', 'revision', 'activity', 'summary', 'homework',
];

export type ExplanationDepth = 'brief' | 'standard' | 'in_depth';
export type QuestionDifficulty = 'easy' | 'medium' | 'hard' | 'mixed';

export interface BlueprintSection {
  /** Stable id so client-side merge/split/reorder can track sections. */
  id: string;
  kind: SectionKind;
  /** Topic name / section label the teacher sees and edits. */
  title: string;
  /** How many slides this section gets. Ranges are DERIVED from order+count
   * (computeSlideRanges), never stored — no overlapping-range headaches. */
  slideCount: number;
  /** concept sections */
  explanationDepth?: ExplanationDepth;
  exampleCount?: number;
  /** practice sections */
  questionTypes?: string[];
  difficulty?: QuestionDifficulty;
  questionCount?: number;
  /** activity sections */
  activityDescription?: string;
  /** Grounding: knowledge-graph node ids backing this section (file modes).
   * Empty/absent = the section is generated from the topic itself. */
  knowledgeNodeIds?: string[];
  /** Teacher's free-form instruction for this section. */
  notes?: string;
  /** Derived (estimateSectionMins) but persisted for display. */
  estimatedMins?: number;
}

export interface LectureBlueprint {
  version: 1;
  title: string;
  subject?: string;
  className?: string;
  chapter?: string;
  language?: string;
  teachingStyle?: string;
  /** Derived: 1 (title slide) + sum of section slideCounts. */
  totalSlides: number;
  /** Derived: sum of section estimates. */
  estimatedDurationMins: number;
  sections: BlueprintSection[];
}

// ── Limits (enforced by coerceBlueprint) ────────────────────────────────────

export const BLUEPRINT_LIMITS = {
  // Redesign mode mirrors the uploaded deck 1:1 (a 92-slide PDF → 92 slides,
  // one 1-slide section per page), so BOTH caps must fit real-world decks —
  // maxSections must be ≥ maxTotalSlides or coercion trims mirrored pages.
  // The app form still limits generate-mode requests to 40; these are ceilings.
  maxSections: 160,
  maxSlidesPerSection: 10,
  maxTotalSlides: 160, // incl. title slide
  minTotalSlides: 3,
  maxQuestionCount: 20,
  maxExampleCount: 5,
  maxTitleLen: 120,
  maxNotesLen: 500,
  maxActivityLen: 500,
} as const;

// ── Duration heuristic (deterministic; mirrored client-side for live edits) ─

const DEPTH_MINS_PER_SLIDE: Record<ExplanationDepth, number> = {
  brief: 2,
  standard: 3,
  in_depth: 4,
};

export function estimateSectionMins(s: BlueprintSection): number {
  switch (s.kind) {
    case 'objectives':
      return 2;
    case 'concept': {
      const perSlide = DEPTH_MINS_PER_SLIDE[s.explanationDepth || 'standard'];
      return s.slideCount * perSlide + (s.exampleCount || 0);
    }
    case 'practice':
      return Math.max(s.slideCount * 2, Math.round((s.questionCount || 4) * 1.5));
    case 'revision':
      return s.slideCount * 2;
    case 'activity':
      return 5 + s.slideCount * 2;
    case 'summary':
      return s.slideCount * 2;
    case 'homework':
      return 1;
    default:
      return s.slideCount * 2;
  }
}

export function estimateBlueprintMins(sections: BlueprintSection[]): number {
  return sections.reduce((sum, s) => sum + estimateSectionMins(s), 1); // +1 for the title slide
}

/** Slide ranges derived from order + counts. Title slide is always slide 1;
 * sections start at slide 2. */
export function computeSlideRanges(
  sections: BlueprintSection[],
): { sectionId: string; start: number; end: number }[] {
  const ranges: { sectionId: string; start: number; end: number }[] = [];
  let next = 2;
  for (const s of sections) {
    ranges.push({ sectionId: s.id, start: next, end: next + s.slideCount - 1 });
    next += s.slideCount;
  }
  return ranges;
}

// ── Coercion / validation ────────────────────────────────────────────────────

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

function cleanStr(raw: unknown, maxLen: number): string {
  return String(raw ?? '').trim().slice(0, maxLen);
}

let sectionSeq = 0;
export function newSectionId(): string {
  return `sec-${Date.now().toString(36)}-${(sectionSeq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Sanitize one section from untrusted input. Returns null when there's
 * nothing usable in it. */
export function coerceSection(raw: any): BlueprintSection | null {
  if (!raw || typeof raw !== 'object') return null;
  const kind: SectionKind = SECTION_KINDS.includes(raw.kind) ? raw.kind : 'concept';
  const title = cleanStr(raw.title, BLUEPRINT_LIMITS.maxTitleLen);
  if (!title) return null;

  const section: BlueprintSection = {
    id: typeof raw.id === 'string' && raw.id.trim() ? cleanStr(raw.id, 64) : newSectionId(),
    kind,
    title,
    slideCount: clampInt(raw.slideCount, 1, BLUEPRINT_LIMITS.maxSlidesPerSection, 1),
  };

  if (kind === 'concept') {
    section.explanationDepth = (['brief', 'standard', 'in_depth'] as const).includes(raw.explanationDepth)
      ? raw.explanationDepth
      : 'standard';
    section.exampleCount = clampInt(raw.exampleCount, 0, BLUEPRINT_LIMITS.maxExampleCount, 1);
  }
  if (kind === 'practice' || kind === 'revision') {
    const types = Array.isArray(raw.questionTypes)
      ? raw.questionTypes.map((t: unknown) => cleanStr(t, 40)).filter(Boolean).slice(0, 6)
      : [];
    section.questionTypes = types.length ? types : ['MCQ'];
    section.difficulty = (['easy', 'medium', 'hard', 'mixed'] as const).includes(raw.difficulty)
      ? raw.difficulty
      : 'mixed';
    section.questionCount = clampInt(
      raw.questionCount,
      1,
      BLUEPRINT_LIMITS.maxQuestionCount,
      Math.min(section.slideCount * 3, 6),
    );
  }
  if (kind === 'activity') {
    section.activityDescription = cleanStr(raw.activityDescription, BLUEPRINT_LIMITS.maxActivityLen) || undefined;
  }
  if (Array.isArray(raw.knowledgeNodeIds)) {
    section.knowledgeNodeIds = raw.knowledgeNodeIds
      .map((id: unknown) => cleanStr(id, 128))
      .filter(Boolean)
      .slice(0, 64);
  }
  const notes = cleanStr(raw.notes, BLUEPRINT_LIMITS.maxNotesLen);
  if (notes) section.notes = notes;

  section.estimatedMins = estimateSectionMins(section);
  return section;
}

/**
 * Sanitize a whole blueprint from untrusted input (client approval payload,
 * AI planner output, stored template). Throws with a human-readable message
 * when the plan is fundamentally unusable; otherwise clamps everything into
 * valid ranges and recomputes all derived fields.
 */
export function coerceBlueprint(raw: any): LectureBlueprint {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Blueprint is missing or not an object.');
  }
  const sectionsRaw = Array.isArray(raw.sections) ? raw.sections : [];
  const sections = sectionsRaw
    .map(coerceSection)
    .filter((s: BlueprintSection | null): s is BlueprintSection => !!s)
    .slice(0, BLUEPRINT_LIMITS.maxSections);

  if (!sections.length) {
    throw new Error('Blueprint needs at least one section.');
  }

  // Enforce the total-slide ceiling by trimming the LAST sections' counts —
  // deterministic and predictable for the teacher.
  let total = 1 + sections.reduce((s, x) => s + x.slideCount, 0);
  for (let i = sections.length - 1; i >= 0 && total > BLUEPRINT_LIMITS.maxTotalSlides; i--) {
    const reducible = Math.min(sections[i].slideCount - 1, total - BLUEPRINT_LIMITS.maxTotalSlides);
    sections[i].slideCount -= reducible;
    total -= reducible;
  }
  while (total > BLUEPRINT_LIMITS.maxTotalSlides && sections.length > 1) {
    total -= sections[sections.length - 1].slideCount;
    sections.pop();
  }

  const bp: LectureBlueprint = {
    version: 1,
    title: cleanStr(raw.title, BLUEPRINT_LIMITS.maxTitleLen) || 'Lecture',
    subject: cleanStr(raw.subject, 80) || undefined,
    className: cleanStr(raw.className, 40) || undefined,
    chapter: cleanStr(raw.chapter, 120) || undefined,
    language: cleanStr(raw.language, 40) || undefined,
    teachingStyle: cleanStr(raw.teachingStyle, 60) || undefined,
    totalSlides: 1 + sections.reduce((s, x) => s + x.slideCount, 0),
    estimatedDurationMins: estimateBlueprintMins(sections),
    sections: sections.map((s) => ({ ...s, estimatedMins: estimateSectionMins(s) })),
  };
  return bp;
}

// ── Exact slide-count fitting ────────────────────────────────────────────────

/** Expansion sections appended (cycling) when a plan is short of the target —
 * the "expand like an experienced teacher" inventory: practice, activities,
 * real-life applications, revision, interesting facts & memory tips. */
const EXPANSION_SECTION_FACTORIES: (() => Omit<BlueprintSection, 'id'>)[] = [
  () => ({ kind: 'practice', title: 'Practice Questions', slideCount: 1, questionTypes: ['MCQ'], difficulty: 'mixed', questionCount: 4 }),
  () => ({ kind: 'concept', title: 'Real-Life Applications', slideCount: 1, explanationDepth: 'standard', exampleCount: 2 }),
  () => ({ kind: 'activity', title: 'Classroom Activity', slideCount: 1, activityDescription: 'A short hands-on activity to reinforce the concepts taught so far.' }),
  () => ({ kind: 'revision', title: 'Rapid Revision', slideCount: 1, questionTypes: ['MCQ', 'True/False'], difficulty: 'mixed', questionCount: 4 }),
  () => ({ kind: 'concept', title: 'Interesting Facts & Memory Tips', slideCount: 1, explanationDepth: 'brief', exampleCount: 1 }),
];

/**
 * Force a blueprint proposal to sum to EXACTLY `targetTotal` slides (incl.
 * the title slide). The requested slide count is mandatory — a teacher asking
 * for 25 slides gets a 25-slide plan to review, never 3.
 *
 *   Short → first widen concept sections (round-robin, +1 up to the per-
 *   section cap), then append expansion sections (practice / applications /
 *   activity / revision / facts, cycling) until the target is met.
 *   Long  → shrink the largest sections down (never below 1), then drop
 *   trailing expansion-style sections as a last resort.
 *
 * Runs on the PROPOSAL only — the teacher can still edit the plan to any
 * size before approving; approval takes their word as final.
 */
export function fitBlueprintToTarget(bp: LectureBlueprint, targetTotal: number): LectureBlueprint {
  const target = Math.min(
    Math.max(Math.round(targetTotal), BLUEPRINT_LIMITS.minTotalSlides),
    BLUEPRINT_LIMITS.maxTotalSlides,
  );
  const sections = bp.sections.map((s) => ({ ...s }));
  const total = () => 1 + sections.reduce((s, x) => s + x.slideCount, 0);

  // Grow: widen concept sections first (they carry the teaching load)…
  let guard = 0;
  while (total() < target && guard++ < 200) {
    const growable = sections.filter(
      (s) => s.kind === 'concept' && s.slideCount < BLUEPRINT_LIMITS.maxSlidesPerSection,
    );
    if (!growable.length) break;
    // Widen the currently-thinnest concept section for even coverage.
    growable.sort((a, b) => a.slideCount - b.slideCount)[0].slideCount += 1;
    // Concept sections shouldn't balloon past ~40% of the deck — leave room
    // for the expansion inventory below.
    const conceptShare = sections.filter((s) => s.kind === 'concept').reduce((s, x) => s + x.slideCount, 0);
    if (conceptShare > Math.ceil(target * 0.5)) break;
  }
  // …then append expansion sections, inserted BEFORE summary/homework so the
  // deck still ends the way a lecture ends. Stop at the section cap — anything
  // appended past it would just be trimmed away by coerceBlueprint below.
  let factoryIdx = 0;
  guard = 0;
  while (total() < target && sections.length < BLUEPRINT_LIMITS.maxSections && guard++ < 200) {
    const section = { id: newSectionId(), ...EXPANSION_SECTION_FACTORIES[factoryIdx % EXPANSION_SECTION_FACTORIES.length]() };
    factoryIdx++;
    const tailIdx = sections.findIndex((s) => s.kind === 'summary' || s.kind === 'homework');
    if (tailIdx >= 0) sections.splice(tailIdx, 0, section);
    else sections.push(section);
  }
  // …and if the section cap stopped expansion (large redesigns: a 92-page
  // deck condensed into ≤60 sections), widen ANY section thinnest-first —
  // capacity is maxSections × maxSlidesPerSection, far above maxTotalSlides.
  guard = 0;
  while (total() < target && guard++ < 800) {
    const widenable = sections.filter((s) => s.slideCount < BLUEPRINT_LIMITS.maxSlidesPerSection);
    if (!widenable.length) break;
    widenable.sort((a, b) => a.slideCount - b.slideCount)[0].slideCount += 1;
  }

  // Shrink: reduce the fattest sections one slide at a time…
  guard = 0;
  while (total() > target && guard++ < 400) {
    const shrinkable = sections.filter((s) => s.slideCount > 1);
    if (!shrinkable.length) break;
    shrinkable.sort((a, b) => b.slideCount - a.slideCount)[0].slideCount -= 1;
  }
  // …then drop whole sections from the tail (keeping at least one).
  while (total() > target && sections.length > 1) {
    sections.pop();
  }

  return coerceBlueprint({ ...bp, sections });
}

/** Which section kind a knowledge node's content type naturally belongs to —
 * used when deriving a blueprint proposal from extracted content. */
export function sectionKindOf(contentType: ContentType): SectionKind {
  switch (contentType) {
    case 'objectives':
      return 'objectives';
    case 'mcq':
      return 'practice';
    case 'summary':
      return 'summary';
    case 'homework':
      return 'homework';
    default:
      return 'concept'; // definition | explanation | formula | example | solved_example | table | note
  }
}
