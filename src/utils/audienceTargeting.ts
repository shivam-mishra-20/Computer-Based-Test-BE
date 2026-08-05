// ── Class / batch audience matching ─────────────────────────────────────────
// One home for the class-value normalization used when resolving "who is this
// content for" across modules.
//
// Why this exists: class values are stored in two forms in live data — users
// carry the label form ("Class 11", written by `resolveStudentClassAndBatch`
// via `toClassLabel`) while exams/schedules/homework carry the bare digit form
// ("11"). Any query that compares the two directly silently matches nothing.
//
// This deliberately does NOT reuse `config/studentBatchConfig.normalizeClassValue`:
// that one validates against SUPPORTED_CLASS_VALUES (7-12, the registration
// batch registry) and returns null for Class 6, which IS a valid exam audience
// (Class 6 has no batch split and is offered by the Schedule & Publish UI).
// Using it here would drop every Class 6 student from the recipient set.
//
// The homework / offline-test / room-allocation modules each carry a private
// copy of the two functions below with identical behaviour; they can migrate to
// this module when they are next touched (not refactored here to avoid churn in
// unrelated notification systems).

/** Batch values that mean "no batch restriction" rather than a real batch name. */
const BATCH_WILDCARDS = new Set(['all', 'all batches', 'allbatches']);

/**
 * Strip a leading "Class " prefix, yielding the bare form ("Class 11" -> "11").
 * Returns '' for anything non-string or empty.
 */
export const normalizeClassValue = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/Class\s*/i, '').trim() : '';

/**
 * Expand class values into every stored representation so a query matches
 * legacy and normalized data alike: "11" -> ["11", "Class 11"].
 *
 * The raw input is always kept as well, so an unrecognised custom value still
 * matches itself exactly and existing data keeps working.
 */
export const buildClassVariants = (values: unknown): string[] => {
  const list = Array.isArray(values) ? values : [values];
  const variants = new Set<string>();
  list.forEach((value) => {
    if (value === null || value === undefined) return;
    const raw = String(value).trim();
    if (!raw) return;
    const normalized = normalizeClassValue(raw);
    if (normalized) {
      variants.add(normalized);
      variants.add(`Class ${normalized}`);
    }
    variants.add(raw);
  });
  return Array.from(variants);
};

/** Trim + drop empties from a batch list (accepts an array or a CSV string). */
export const normalizeBatchList = (values: unknown): string[] => {
  const list = Array.isArray(values)
    ? values
    : typeof values === 'string'
      ? values.split(',')
      : [];
  return list.map((v) => String(v || '').trim()).filter(Boolean);
};

/** Drop "All Batches"-style wildcards, which mean "no batch restriction". */
export const stripBatchWildcards = (batches: string[]): string[] =>
  batches.filter((b) => !BATCH_WILDCARDS.has(b.trim().toLowerCase()));

/**
 * True when a group token names a class rather than a batch.
 *
 * Deliberately strict — anchored on a bare 1-12 number with an optional "Class "
 * prefix — so real batch names ("Lakshya", "Advanced/Basic", "Commerce") are
 * never mistaken for a class and turned into a class-wide audience.
 */
export const isClassToken = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  const match = value.trim().match(/^(?:class\s*)?(\d{1,2})$/i);
  if (!match) return false;
  const n = Number(match[1]);
  return n >= 1 && n <= 12;
};
