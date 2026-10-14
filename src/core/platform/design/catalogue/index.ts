/**
 * MIRROR of platform-client-core/src/design/catalogue/index.ts — edit THAT file, then copy.
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

import type { CategoryId, DesignTemplate } from '../schema';
import { NATURAL_TEMPLATES } from './natural';
import { PREMIUM_TEMPLATES } from './premium';
import { CONTEMPORARY_TEMPLATES } from './contemporary';
import { DIGITAL_TEMPLATES } from './digital';
import { LEARNING_TEMPLATES } from './learning';

/* ══ Mirrored body ═══════════════════════════════════════════════════════════
 * Everything from this line down is copied byte for byte into central-be
 * (src/core/platform/design/). Edit it here, then copy it across;
 * `npm run safety:design-rules` in central-be fails on any difference.
 * ══════════════════════════════════════════════════════════════════════════ */

export const TEMPLATES: readonly DesignTemplate[] = [
  ...NATURAL_TEMPLATES,
  ...PREMIUM_TEMPLATES,
  ...CONTEMPORARY_TEMPLATES,
  ...DIGITAL_TEMPLATES,
  ...LEARNING_TEMPLATES,
];

const BY_ID = new Map(TEMPLATES.map((t) => [t.meta.id, t]));

export function templateById(id: string | null | undefined): DesignTemplate | null {
  return (id && BY_ID.get(id)) || null;
}

export function templatesIn(category: CategoryId | 'all'): DesignTemplate[] {
  return category === 'all' ? [...TEMPLATES] : TEMPLATES.filter((t) => t.meta.category === category);
}

/**
 * Search by name, description, keywords and category label. Every word in the
 * query must match somewhere, so "dark navy" narrows rather than widens.
 */
export function searchTemplates(
  query: string,
  pool: readonly DesignTemplate[] = TEMPLATES,
  categoryLabel: (id: CategoryId) => string = (id) => id,
): DesignTemplate[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...pool];
  // A face key is jargon ("transitional"); search by what a person would type.
  const faceWords = (face: string) =>
    ['serif', 'oldstyle', 'transitional', 'didone'].includes(face) ? `serif ${face}` : face === 'mono' ? 'mono monospace' : `sans ${face}`;
  return pool.filter((t) => {
    const haystack = [
      t.meta.name,
      t.meta.description,
      t.meta.keywords.join(' '),
      categoryLabel(t.meta.category),
      t.appearance.strategy === 'dark-only' ? 'dark' : t.appearance.strategy === 'adaptive' ? 'dark light' : 'light',
      faceWords(t.typography.faces.display),
      faceWords(t.typography.faces.text),
      t.surface.style,
      t.spacing.density,
    ]
      .join(' ')
      .toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

export { NATURAL_TEMPLATES, PREMIUM_TEMPLATES, CONTEMPORARY_TEMPLATES, DIGITAL_TEMPLATES, LEARNING_TEMPLATES };
