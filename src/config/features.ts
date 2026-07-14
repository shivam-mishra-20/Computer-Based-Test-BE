/**
 * Runtime feature toggles. Single source of truth so a feature can be turned
 * off across the API AND the queue worker by flipping ONE env var — no code
 * deletion, no schema changes, nothing lost.
 */

/**
 * AI PPT generation + regeneration (the two-phase blueprint pipeline).
 * TEMPORARILY DISABLED by default (2026-07): postponed until the core platform
 * is stable. Re-enable by setting `ENABLE_PPT_FEATURES=true` — everything else
 * (routes, services, prompts, models, queue) is intact and comes straight back.
 *
 * NOTE: this gates ONLY feature:'ppt'. Question-paper generation shares the
 * same controller and BullMQ queue and stays fully enabled.
 */
export function pptFeaturesEnabled(): boolean {
  return String(process.env.ENABLE_PPT_FEATURES ?? 'false').toLowerCase() === 'true';
}

/** Friendly message shown when a disabled PPT endpoint is hit. */
export const PPT_DISABLED_MESSAGE =
  'AI presentation generation is temporarily unavailable. It will be back soon.';
