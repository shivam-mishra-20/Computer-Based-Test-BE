export interface StudentBatchRule {
  classValue: string;
  classLabel: string;
  batches: string[];
  requiresBatch: boolean;
}

const STUDENT_BATCH_RULE_MAP: Record<string, string[]> = {
  '7': [],
  '8': ['Advanced', 'Basic', 'JEE'],
  '9': ['Advanced', 'Basic', 'JEE'],
  '10': ['Advanced', 'Basic', 'JEE'],
  '11': ['JEE', 'JEE/NEET', 'Advanced'],
  '12': ['JEE']
};

export const STUDENT_BATCH_RULES: StudentBatchRule[] = Object.keys(STUDENT_BATCH_RULE_MAP)
  .sort((a, b) => Number(a) - Number(b))
  .map((classValue) => {
    const batches = STUDENT_BATCH_RULE_MAP[classValue] || [];
    return {
      classValue,
      classLabel: `Class ${classValue}`,
      batches,
      requiresBatch: batches.length > 0
    };
  });

export function normalizeClassValue(input?: string): string | null {
  if (!input || typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/(\d{1,2})/);
  if (!match) return null;

  const numeric = String(Number(match[1]));
  if (!Object.prototype.hasOwnProperty.call(STUDENT_BATCH_RULE_MAP, numeric)) {
    return null;
  }

  return numeric;
}

export function toClassLabel(classValue: string): string {
  return `Class ${classValue}`;
}

export function getAllowedBatchesForClass(classValue: string): string[] {
  return STUDENT_BATCH_RULE_MAP[classValue] || [];
}

export function isBatchRequiredForClass(classValue: string): boolean {
  return getAllowedBatchesForClass(classValue).length > 0;
}

export function matchAllowedBatch(batch: string | undefined, allowedBatches: string[]): string | null {
  if (!batch || typeof batch !== 'string') return null;

  const trimmed = batch.trim();
  if (!trimmed) return null;

  const exact = allowedBatches.find((item) => item === trimmed);
  if (exact) return exact;

  const byCaseInsensitive = allowedBatches.find(
    (item) => item.toLowerCase() === trimmed.toLowerCase()
  );

  return byCaseInsensitive || null;
}

export function getStudentBatchConfigResponse() {
  return {
    classes: STUDENT_BATCH_RULES,
    batchRules: STUDENT_BATCH_RULE_MAP
  };
}
