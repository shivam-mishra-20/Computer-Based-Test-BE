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
  maxSections: 24,
  maxSlidesPerSection: 10,
  maxTotalSlides: 40, // incl. title slide
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
