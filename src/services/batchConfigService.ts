import Batch from '../models/Batch';
import User from '../models/User';
import Schedule from '../models/Schedule';
import { normalizeClassValue } from '../config/studentBatchConfig';

export interface StudentBatchClassRule {
  classValue: string;
  classLabel: string;
  batches: string[];
  requiresBatch: boolean;
}

export interface StudentBatchConfigResponse {
  classes: StudentBatchClassRule[];
  batchRules: Record<string, string[]>;
}

export const SUPPORTED_CLASS_VALUES = ['7', '8', '9', '10', '11', '12'];
const MERGED_BATCH_NAME = 'Advanced/Basic';

const normalizeBatchLabel = (input: string): string => input.trim().toLowerCase();

const isAdvancedLabel = (input: string): boolean => normalizeBatchLabel(input) === 'advanced';
const isBasicLabel = (input: string): boolean => normalizeBatchLabel(input) === 'basic';
const isAdvancedBasicLabel = (input: string): boolean => {
  const normalized = normalizeBatchLabel(input).replace(/\s+/g, '');
  return normalized === 'advanced/basic' || normalized === 'advanced\\/basic';
};

export async function mergeAdvancedBasicBatchValues(): Promise<void> {
  const relatedBatches = await Batch.find({
    name: { $regex: /^(advanced|basic|advanced\s*\/\s*basic)$/i },
  }).lean();

  if (!relatedBatches.length) {
    return;
  }

  const classLevels = Array.from(
    new Set(
      relatedBatches
        .flatMap((batch) => (Array.isArray(batch.classLevels) ? batch.classLevels : []))
        .map((level) => normalizeClassValue(String(level)))
        .filter((value): value is string => Boolean(value))
    )
  ).sort((a, b) => Number(a) - Number(b));

  if (!classLevels.length) {
    return;
  }

  const existingMerged = relatedBatches.find((batch) => isAdvancedBasicLabel(String(batch.name || '')));
  const shouldBeDefault = relatedBatches.some((batch) => Boolean((batch as any).isDefault));

  if (existingMerged) {
    await Batch.findByIdAndUpdate(existingMerged._id, {
      name: MERGED_BATCH_NAME,
      classLevels,
      isDefault: shouldBeDefault,
    });
  } else {
    await Batch.findOneAndUpdate(
      { name: MERGED_BATCH_NAME },
      {
        name: MERGED_BATCH_NAME,
        classLevels,
        isDefault: shouldBeDefault,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  const legacyIds = relatedBatches
    .filter((batch) => {
      const name = String(batch.name || '');
      return isAdvancedLabel(name) || isBasicLabel(name);
    })
    .map((batch) => batch._id);

  if (legacyIds.length) {
    await Batch.deleteMany({ _id: { $in: legacyIds } });
  }

  await Promise.all([
    User.updateMany(
      { batch: { $regex: /^(advanced|basic)$/i } },
      { $set: { batch: MERGED_BATCH_NAME } }
    ),
    Schedule.updateMany(
      { batch: { $regex: /^(advanced|basic)$/i } },
      { $set: { batch: MERGED_BATCH_NAME } }
    ),
  ]);
}

export function matchBatchName(batchInput: string | undefined, allowedBatches: string[]): string | null {
  if (!batchInput || typeof batchInput !== 'string') return null;

  const trimmed = batchInput.trim();
  if (!trimmed) return null;

  const exact = allowedBatches.find((item) => item === trimmed);
  if (exact) return exact;

  const byCaseInsensitive = allowedBatches.find(
    (item) => item.toLowerCase() === trimmed.toLowerCase()
  );

  return byCaseInsensitive || null;
}

export async function getStudentBatchConfigFromDatabase(): Promise<StudentBatchConfigResponse> {
  await mergeAdvancedBasicBatchValues();

  const batchRules: Record<string, string[]> = Object.fromEntries(
    SUPPORTED_CLASS_VALUES.map((classValue) => [classValue, []])
  );

  const batchNameSets: Record<string, Set<string>> = Object.fromEntries(
    SUPPORTED_CLASS_VALUES.map((classValue) => [classValue, new Set<string>()])
  ) as Record<string, Set<string>>;

  const batches = await Batch.find({}).select('name classLevels').lean();

  batches.forEach((batch) => {
    const batchName = String(batch.name || '').trim();
    if (!batchName) return;

    const classLevels = Array.isArray(batch.classLevels) ? batch.classLevels : [];
    classLevels.forEach((level) => {
      const normalized = normalizeClassValue(String(level));
      if (!normalized || !(normalized in batchNameSets)) return;
      batchNameSets[normalized].add(batchName);
    });
  });

  SUPPORTED_CLASS_VALUES.forEach((classValue) => {
    batchRules[classValue] = Array.from(batchNameSets[classValue]).sort((a, b) =>
      a.localeCompare(b)
    );
  });

  return {
    classes: SUPPORTED_CLASS_VALUES.map((classValue) => ({
      classValue,
      classLabel: `Class ${classValue}`,
      batches: batchRules[classValue],
      requiresBatch: batchRules[classValue].length > 0,
    })),
    batchRules,
  };
}
