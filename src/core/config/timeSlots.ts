/**
 * Time slots, per organization.
 *
 * ── What this replaced, and why it could not stay ───────────────────────────
 * Three module-level `let` arrays inside `routes/api/scheduleRoutes.ts`, loaded
 * once at process start and mutated in place whenever an admin saved. In a
 * single-institute deployment that is a reasonable cache. In a claim-mode
 * process serving several institutes it is a cross-tenant bug that no amount of
 * query scoping fixes: whichever organization last pressed Save owned the
 * timetable for EVERY organization until the process restarted, because the
 * value lived in a module variable rather than in the request.
 *
 * The startup `loadTimeSlots()` was the other half of it — an unscoped read,
 * and an unscoped WRITE since it created the rows it did not find, executed
 * before any request exists and therefore in no organization's context. That is
 * what `legacy-regression` has been reporting as `AppSetting.findOne ×3` since
 * the tenancy layer shipped.
 *
 * ── The shape now ───────────────────────────────────────────────────────────
 * Resolved per organization, cached briefly per organization, and never written
 * as a side effect of being read. Rows are created only when an administrator
 * actually saves.
 *
 * An organization that has saved nothing resolves to the constants below —
 * Abhigyan's current slots, unchanged — so its responses are byte-identical to
 * what it gets today. That is the same per-section fallback `orgConfig.ts` and
 * `policy.ts` use, for the same reason:
 *
 *     Absent configuration must mean "as before", never "nothing".
 *
 * It lives here rather than in the route file because it is configuration, it
 * has the same shape as its neighbours, and a route file is not somewhere a
 * test can reach into.
 */

import { currentOrgId, tenantScope } from '../tenancy';

export interface TimeSlot {
  start: string;
  end: string;
  label: string;
}

export const DEFAULT_MORNING_TIME_SLOTS: TimeSlot[] = [
  { start: '10:30', end: '11:30', label: '10:30 AM - 11:30 AM' },
  { start: '11:30', end: '12:30', label: '11:30 AM - 12:30 PM' },
  { start: '12:30', end: '13:30', label: '12:30 PM - 1:30 PM' },
  { start: '13:30', end: '14:30', label: '1:30 PM - 2:30 PM' },
  { start: '14:30', end: '15:30', label: '2:30 PM - 3:30 PM' },
];

export const DEFAULT_MORNING2_TIME_SLOTS: TimeSlot[] = [
  { start: '09:00', end: '10:00', label: '9:00 AM - 10:00 AM' },
  { start: '10:00', end: '11:00', label: '10:00 AM - 11:00 AM' },
  { start: '11:00', end: '12:00', label: '11:00 AM - 12:00 PM' },
  { start: '12:00', end: '13:00', label: '12:00 PM - 1:00 PM' },
];

export const DEFAULT_EVENING_TIME_SLOTS: TimeSlot[] = [
  { start: '15:30', end: '16:30', label: '3:30 PM - 4:30 PM' },
  { start: '16:30', end: '17:30', label: '4:30 PM - 5:30 PM' },
  { start: '17:30', end: '18:30', label: '5:30 PM - 6:30 PM' },
  { start: '18:30', end: '19:30', label: '6:30 PM - 7:30 PM' },
  { start: '19:30', end: '20:30', label: '7:30 PM - 8:30 PM' },
  { start: '20:30', end: '21:30', label: '8:30 PM - 9:30 PM' },
  { start: '21:30', end: '22:30', label: '9:30 PM - 10:30 PM' },
];

export interface TimeSlotSet {
  morning: TimeSlot[];
  morning2: TimeSlot[];
  evening: TimeSlot[];
  /** All regular slots, ordered — live schedule, grid defaults and labels. */
  combined: TimeSlot[];
}

/** `14:30` -> 870. Local to this module so it does not depend on a route file. */
export function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function combine(morning2: TimeSlot[], morning: TimeSlot[], evening: TimeSlot[]): TimeSlot[] {
  return [...morning2, ...morning, ...evening]
    .filter((slot) => slot?.start && slot?.end)
    .sort((a, b) => parseTimeToMinutes(a.start) - parseTimeToMinutes(b.start));
}

export const SLOT_KEYS = {
  morning: 'MORNING_TIME_SLOTS',
  morning2: 'MORNING2_TIME_SLOTS',
  evening: 'EVENING_TIME_SLOTS',
} as const;

const SLOT_CACHE_TTL_MS = 30_000;
const slotCache = new Map<string, { set: TimeSlotSet; at: number }>();

/** Called after a save, so the next read does not serve the previous value. */
export function invalidateSlotCache(): void {
  const orgId = currentOrgId();
  slotCache.delete(orgId ?? '__no_org__');
}

function usableSlots(value: unknown): TimeSlot[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rows = value.filter(
    (slot): slot is TimeSlot =>
      Boolean(slot) && typeof slot.start === 'string' && typeof slot.end === 'string',
  );
  return rows.length ? rows : null;
}

/** The slot table for the organization this request belongs to. */
export async function timeSlotsForOrg(): Promise<TimeSlotSet> {
  const cacheKey = currentOrgId() ?? '__no_org__';
  const hit = slotCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SLOT_CACHE_TTL_MS) return hit.set;

  let morning = DEFAULT_MORNING_TIME_SLOTS;
  let morning2 = DEFAULT_MORNING2_TIME_SLOTS;
  let evening = DEFAULT_EVENING_TIME_SLOTS;

  try {
    // Required lazily, like the other resolvers here, so this module is
    // importable before the models compile.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AppSetting = require('../../models/AppSetting').default;
    const scope = tenantScope();
    const rows = (await AppSetting.find({
      ...scope,
      key: { $in: Object.values(SLOT_KEYS) },
    }).lean()) as { key: string; value: unknown; orgId?: string | null }[];

    // ── When the query could not be scoped ────────────────────────────────
    // `tenantScope()` is a no-op wherever `orgId` may not be backfilled, which
    // is correct: on a single-institute database an unscoped read returns that
    // institute's rows and nothing else.
    //
    // On a database that holds SEVERAL organizations, the same unscoped read
    // returns several rows for one key and `new Map()` would keep whichever
    // arrived last — an arbitrary institute's timetable, served silently. So an
    // ambiguous key falls back to the platform default instead. Serving the
    // standard slots is a visible, explainable outcome; serving a competitor's
    // is not.
    const byKey = new Map<string, unknown>();
    const ambiguous = new Set<string>();
    const seenOrgs = new Map<string, string>();
    for (const row of rows) {
      const org = row.orgId ? String(row.orgId) : '';
      if (byKey.has(row.key) && seenOrgs.get(row.key) !== org) {
        ambiguous.add(row.key);
        continue;
      }
      byKey.set(row.key, row.value);
      seenOrgs.set(row.key, org);
    }
    const resolve = (key: string) => (ambiguous.has(key) ? null : usableSlots(byKey.get(key)));

    morning = resolve(SLOT_KEYS.morning) ?? morning;
    morning2 = resolve(SLOT_KEYS.morning2) ?? morning2;
    evening = resolve(SLOT_KEYS.evening) ?? evening;
  } catch (error) {
    // A failed lookup falls back to the defaults rather than failing the
    // request — a timetable that renders the standard slots beats one that
    // does not render.
    console.error('Failed to load time slots:', error);
  }

  const set: TimeSlotSet = {
    morning,
    morning2,
    evening,
    combined: combine(morning2, morning, evening),
  };
  slotCache.set(cacheKey, { set, at: Date.now() });
  return set;
}
