/**
 * Teacher activity — public surface.
 *
 * Import from here rather than reaching into the individual files, so the
 * internals can be reorganised without a repo-wide edit. Same convention as
 * `src/core/tenancy`.
 */

export {
  buildActivitySummary,
  buildActivityDetail,
  parseKinds,
  SECTION_ITEM_CAP,
  type ActivityDetailOptions,
  type ActivityDetailResult,
  type ActivitySummaryOptions,
  type ActivitySummaryResult,
} from './loaders';

export { ACTIVITY_KINDS, ACTIVITY_SOURCES, sourceFor } from './sources';

export { filterFor, groupKeys, bucketOwner } from './attribution';

export type {
  ActivityCounts,
  ActivityItem,
  ActivityKind,
  ActivitySection,
  ActivitySource,
  ActivitySummaryRow,
  Attribution,
  RangeMode,
} from './types';
