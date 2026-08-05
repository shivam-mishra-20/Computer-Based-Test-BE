import type { ResourceContentCategory } from '../models/StudyResource';

// ── Public section derivation ───────────────────────────────────────────────
// `StudyResource.contentCategory` is a newer, optional field. Every resource
// created before it existed has none, and a guest section that filtered on the
// stored value alone would render empty until someone re-tagged the whole
// library by hand.
//
// So the stored value ALWAYS wins, and this only fills the gap for untagged
// content by reading the signals that already exist (type + free-text category
// + tags + title). Tagging a resource explicitly overrides whatever this
// guesses, which keeps the enum authoritative without a data migration.

interface DerivableResource {
  type?: string;
  contentCategory?: ResourceContentCategory | null;
  category?: string;
  title?: string;
  tags?: string[];
}

const PLAYLIST_HINTS = /playlist|series|course|chapter\s*wise|full\s*syllabus/i;
const SAMPLE_PAPER_HINTS =
  /sample\s*paper|previous\s*year|pyq|question\s*paper|model\s*paper|mock|test\s*paper|practice\s*paper/i;
const TECHNIQUE_HINTS = /technique|trick|shortcut|concept|method|approach|tip/i;

/** All the free text that can hint at a resource's section, lowercased once. */
const haystack = (resource: DerivableResource): string =>
  [resource.title, resource.category, ...(resource.tags || [])]
    .filter(Boolean)
    .join(' ');

/**
 * Best-effort section for a resource.
 *
 * Videos default to TECHNIQUE and PDFs to LECTURE_NOTE — the most common case
 * for each type — with keyword hints promoting them to PLAYLIST / SAMPLE_PAPER.
 * Returns undefined only when the type is unknown.
 */
export const deriveContentCategory = (
  resource: DerivableResource,
): ResourceContentCategory | undefined => {
  // An explicitly tagged resource is never second-guessed.
  if (resource.contentCategory) return resource.contentCategory;

  const text = haystack(resource);

  if (resource.type === 'video') {
    if (PLAYLIST_HINTS.test(text)) return 'PLAYLIST';
    return 'TECHNIQUE';
  }

  if (resource.type === 'pdf') {
    if (SAMPLE_PAPER_HINTS.test(text)) return 'SAMPLE_PAPER';
    // A PDF that reads like a methods explainer is closer to a technique
    // lesson than to lecture notes.
    if (TECHNIQUE_HINTS.test(text)) return 'TECHNIQUE';
    return 'LECTURE_NOTE';
  }

  return undefined;
};

/**
 * Attach the derived section to a resource for API responses, so both clients
 * can group by `contentCategory` without duplicating this logic.
 */
export const withContentCategory = <T extends DerivableResource>(
  resource: T,
): T & { contentCategory?: ResourceContentCategory } => ({
  ...resource,
  contentCategory: deriveContentCategory(resource),
});
