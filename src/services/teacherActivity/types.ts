/**
 * Teacher activity — the shapes.
 *
 * "Activity" here means everything a teacher creates or maintains *for
 * students*: homework, study material, syllabus progress, tests, exams, doubt
 * threads and announcements. It is the other half of the Teacher Report, which
 * until now could only say how long someone was present, not what they
 * produced while they were.
 *
 * Every kind is described by an `ActivitySource` rather than hand-written into
 * the loader. Adding a ninth kind is then one entry in `sources.ts` — no new
 * query, no new branch in the controller, no new field in the response.
 */

/** The content kinds this report knows about. */
export type ActivityKind =
  | 'homework'
  | 'material'
  | 'syllabus'
  | 'offlineTest'
  | 'onlineExam'
  | 'doubt'
  | 'announcement';

/**
 * How a collection records which teacher a row belongs to.
 *
 * Three styles exist in this database because the collections were written at
 * different times, and a report that assumes one of them silently drops the
 * others. They are named rather than guessed at the call site.
 */
export type Attribution =
  /** The field holds `User._id` as an ObjectId. Homework, Material, Exam… */
  | { style: 'objectId'; field: string }
  /** The field holds `User._id`, but stored as a plain string. TestResult. */
  | { style: 'idString'; field: string }
  /**
   * The field holds whichever identifier existed when the row was written: an
   * `_id`, a Firebase uid, or — for the oldest rows — the teacher's name.
   * Resolved through `TeacherIdentityIndex`, which refuses to guess when two
   * teachers share a name.
   */
  | { style: 'alias'; field: string; nameField?: string };

/**
 * Whether a section answers "what did they do in this period" or "where do
 * they stand right now".
 *
 * Syllabus is the reason this exists. A syllabus is a living record, not an
 * event: filtering it to the selected month would hide the progress of a
 * subject the teacher simply did not touch in those weeks, which is the
 * opposite of what the reader wants to know.
 */
export type RangeMode = 'window' | 'always';

/** One thing a teacher made, normalised so the client renders it uniformly. */
export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  title: string;
  /** Subject, class and batch, already joined for display. */
  subtitle: string;
  /** Local YYYY-MM-DD the item is filed under. Null when the row has no date. */
  date: string | null;
  /** Display-ready status word, or null when the kind has no status. */
  status: string | null;
  /**
   * Kind-specific extras, already formatted for display. Deliberately a flat
   * bag of primitives: the client renders it generically, so a new field here
   * needs no client change.
   */
  meta: Record<string, string | number | boolean | null>;
}

/** Per-teacher counts, one number per kind. */
export type ActivityCounts = Record<ActivityKind, number>;

export interface ActivitySummaryRow {
  userId: string;
  name: string;
  counts: ActivityCounts;
  /** Everything added up, so the client does not have to. */
  total: number;
}

export interface ActivitySection {
  kind: ActivityKind;
  label: string;
  /** Plain-English noun, for "3 homework tasks" / "1 homework task". */
  noun: { one: string; many: string };
  rangeMode: RangeMode;
  count: number;
  items: ActivityItem[];
  /**
   * True when `count` is larger than `items.length` because the per-section cap
   * was hit. The client says so rather than quietly showing a partial list.
   */
  truncated: boolean;
  /**
   * Set when this one section failed to load. The rest of the report is still
   * returned: one broken collection must not blank a page that is mostly fine.
   */
  error: string | null;
}

/** Everything the loader needs to know about one content kind. */
export interface ActivitySource {
  kind: ActivityKind;
  /** Heading shown above the section. */
  label: string;
  noun: { one: string; many: string };
  /** Model name as registered with Mongoose. */
  model: string;
  attribution: Attribution;
  /** The field a date range filters on. */
  dateField: string;
  /**
   * Whether `dateField` stores a real Date or a "YYYY-MM-DD" string.
   * TestResult.testDate is the string case, and comparing it against a Date
   * silently matches nothing.
   */
  dateKind: 'date' | 'ymd';
  rangeMode: RangeMode;
  /** Projection. Keeps a month of a busy teacher's output small. */
  select: string;
  sort: Record<string, 1 | -1>;
  /**
   * Extra conditions that are part of what the kind *means* — for example,
   * only counting syllabi that are still active. Not a user filter.
   */
  baseFilter?: Record<string, unknown>;
  toItem(doc: any): ActivityItem;
}
