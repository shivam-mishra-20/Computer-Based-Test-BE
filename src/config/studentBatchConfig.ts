export const SUPPORTED_CLASS_VALUES = ['7', '8', '9', '10', '11', '12'] as const;

export function normalizeClassValue(input?: string): string | null {
  if (!input || typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/(\d{1,2})/);
  if (!match) return null;

  const numeric = String(Number(match[1]));
  if (!SUPPORTED_CLASS_VALUES.includes(numeric as (typeof SUPPORTED_CLASS_VALUES)[number])) {
    return null;
  }

  return numeric;
}

export function toClassLabel(classValue: string): string {
  return `Class ${classValue}`;
}
