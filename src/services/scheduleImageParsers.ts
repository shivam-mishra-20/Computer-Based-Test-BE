/**
 * Deterministic parsers for the schedule-image import.
 *
 * These were module-local functions inside `routes/api/scheduleRoutes.ts`. They
 * are the half of the extraction pipeline that is NOT the model: the vision
 * model only transcribes printed text verbatim, and everything here turns that
 * text into schedule fields. That split is deliberate and load-bearing — see
 * the prompt comment in scheduleRoutes.ts for the measured reason the model is
 * never asked to normalize anything itself.
 *
 * They live here so they can be exercised directly by
 * `src/scripts/verify_schedule_parsers.ts` without booting Express, Mongo,
 * Firebase and the AI stack. Every rule below silently decides whether a real
 * class survives into the admin's review screen, so they need to be testable.
 */

const CELL_NOTE_KEYWORDS: RegExp[] = [
  /extra\s*-?\s*class/i,
  /make\s*-?\s*up/i,
  /doubt\s*-?\s*class/i,
  /revision\s*-?\s*class/i,
  /special\s*-?\s*class/i,
  /demo\s*-?\s*class/i,
];

const HONORIFIC_RE = /\b(sir|ma'?am|madam|miss|mr|mrs|ms)\b/i;

export function normalizeForMatch(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/** Exact → prefix → token-overlap match against a small candidate list (tens of items). */
export function matchBatchLabel(raw: string | undefined, candidates: string[]): { matched: string | null } {
  const needle = normalizeForMatch(raw || '');
  if (!needle) return { matched: null };

  for (const c of candidates) {
    if (normalizeForMatch(c) === needle) return { matched: c };
  }
  for (const c of candidates) {
    const cn = normalizeForMatch(c);
    if (cn.startsWith(needle) || needle.startsWith(cn)) return { matched: c };
  }
  const needleTokens = new Set(needle.split(' ').filter(Boolean));
  let best: { name: string; score: number } | null = null;
  for (const c of candidates) {
    const overlap = normalizeForMatch(c).split(' ').filter((t) => needleTokens.has(t)).length;
    if (overlap > 0 && (!best || overlap > best.score)) best = { name: c, score: overlap };
  }
  return { matched: best ? best.name : null };
}

/** Never silently pick between two equally-good matches (e.g. two "Thakur"s). */
export function matchTeacherName(
  raw: string | undefined,
  teachers: { id: string; name: string }[]
): { id: string | null; name: string; ambiguous: boolean } {
  const rawTrimmed = String(raw || '').trim();
  const needle = normalizeForMatch(rawTrimmed);
  if (!needle) return { id: null, name: rawTrimmed, ambiguous: false };

  const exact = teachers.filter((t) => normalizeForMatch(t.name) === needle);
  if (exact.length === 1) return { id: exact[0].id, name: exact[0].name, ambiguous: false };
  if (exact.length > 1) return { id: null, name: rawTrimmed, ambiguous: true };

  const needleTokens = needle.split(' ').filter(Boolean);
  const partial = teachers.filter((t) => {
    const tTokens = normalizeForMatch(t.name).split(' ').filter(Boolean);
    return needleTokens.some((nt) => tTokens.includes(nt));
  });
  if (partial.length === 1) return { id: partial[0].id, name: partial[0].name, ambiguous: false };
  if (partial.length > 1) return { id: null, name: rawTrimmed, ambiguous: true };

  return { id: null, name: rawTrimmed, ambiguous: false };
}

// Cell text follows "Teacher Name [note] Room-Number", e.g. "Harsh sir 3" or
// "Archit sir extra class 6". A trailing 1-2 digit number (1-11) is the room —
// never part of the teacher's name — and a small set of recognizable note
// keywords (extra class, makeup, etc.) get pulled out separately. This is a
// deterministic safety net: it runs regardless of whether the model itself
// split the cell cleanly, so a model that dumps the whole cell into
// "teacherName" still resolves correctly.
export function splitCellText(rawCellText: string): { teacherName: string; roomNumber: number | null; note: string } {
  let text = String(rawCellText || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let note = '';
  for (const kw of CELL_NOTE_KEYWORDS) {
    const m = text.match(kw);
    if (m) {
      note = titleCase(m[0].replace(/\s*-\s*/g, ' ').replace(/\s+/g, ' ').trim());
      text = text.replace(kw, ' ').replace(/\s+/g, ' ').trim();
      break;
    }
  }

  let roomNumber: number | null = null;
  let teacherName = text;

  // "Room 3", "R-3", "(3)" written BEFORE or inside the name — a common layout
  // that the trailing-number rule below cannot see, which used to leave the
  // literal word "Room" inside the teacher name and break the match.
  const labelled = text.match(/\b(?:room|rm|r)\s*[-.:#]?\s*(\d{1,2})\b/i);
  if (labelled) {
    const n = Number(labelled[1]);
    if (n >= 1 && n <= 11) {
      roomNumber = n;
      teacherName = text.replace(labelled[0], ' ').replace(/\s+/g, ' ').trim();
    }
  }

  if (roomNumber === null) {
    const roomMatch = teacherName.match(/^(.*?)[\s,\-–—]*?(\d{1,2})$/);
    if (roomMatch) {
      const n = Number(roomMatch[2]);
      if (n >= 1 && n <= 11) {
        roomNumber = n;
        teacherName = roomMatch[1].trim();
      }
    }
  }

  teacherName = teacherName.replace(/[\s,\-–—]+$/, '').trim();
  return { teacherName, roomNumber, note };
}

export interface ParsedTimeRange {
  startTimeSlot: string;
  endTimeSlot: string;
  /**
   * True when the printed header carried no AM/PM and the 12-hour reading had
   * to be inferred. The caller flags the entry for review rather than
   * presenting an inferred time as if it were transcribed.
   */
  assumedMeridiem: boolean;
}

const MERIDIEM_RE = /^([ap])\.?\s*m\.?$/i;

function readMeridiem(token: string | undefined): 'AM' | 'PM' | null {
  if (!token) return null;
  const m = MERIDIEM_RE.exec(token.trim());
  if (!m) return null;
  return m[1].toLowerCase() === 'a' ? 'AM' : 'PM';
}

const to24 = (h: number, isPM: boolean) => (h === 12 ? (isPM ? 12 : 0) : isPM ? h + 12 : h);
const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Parse a verbatim column header like "4:30-5:30PM" into 24h start/end.
 *
 * The model is NEVER trusted to compute or normalize this itself (per the
 * anti-hallucination split) — it only transcribes the printed text, and this is
 * the one place that turns it into a time.
 *
 * ── Why this accepts more than it used to ───────────────────────────────────
 * The original required a colon in BOTH times AND a trailing AM/PM, which
 * rejected six of fourteen header formats that appear on real timetables:
 * "3:30-4:30", "15:30-16:30", "3:30PM-4:30PM", "3:30 to 4:30 PM", "3-4 PM",
 * "03:30-04:30 P.M.". A rejected header does not drop the class — it produces
 * an entry with EMPTY start/end, which then collides with every other
 * time-less entry in the same row under the caller's duplicate guard and
 * silently loses all but one of them. Widening the parser removes the cause
 * rather than the symptom.
 *
 * Returns null only when the label genuinely is not a time range.
 */
export function parseTimeRangeLabel(label: string): ParsedTimeRange | null {
  const m = String(label || '').match(
    /(\d{1,2})(?:[:.](\d{2}))?\s*([ap]\.?\s*m\.?)?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?:[:.](\d{2}))?\s*([ap]\.?\s*m\.?)?/i,
  );
  if (!m) return null;

  const startHour = Number(m[1]);
  const startMin = m[2] === undefined ? 0 : Number(m[2]);
  const endHour = Number(m[4]);
  const endMin = m[5] === undefined ? 0 : Number(m[5]);
  if (startMin > 59 || endMin > 59) return null;

  const startMer = readMeridiem(m[3]);
  // "3:30 PM - 4:30" reads as PM on both ends; a lone trailing meridiem
  // ("3:30-4:30 PM") applies to the end and the start is inferred below.
  const endMer = readMeridiem(m[6]) || (readMeridiem(m[3]) && m[6] === undefined ? startMer : null);

  // ── 24-hour clock ────────────────────────────────────────────────────────
  // No meridiem anywhere and an hour above 12 can only be a 24h label.
  if (!startMer && !endMer && (startHour > 12 || endHour > 12)) {
    if (startHour > 23 || endHour > 23) return null;
    const startTotal = startHour * 60 + startMin;
    const endTotal = endHour * 60 + endMin;
    if (endTotal <= startTotal || endTotal - startTotal > 180) return null;
    return {
      startTimeSlot: `${pad2(startHour)}:${pad2(startMin)}`,
      endTimeSlot: `${pad2(endHour)}:${pad2(endMin)}`,
      assumedMeridiem: false,
    };
  }

  if (startHour < 1 || startHour > 12 || endHour < 1 || endHour > 12) return null;

  // ── Both ends carry a meridiem ───────────────────────────────────────────
  if (startMer && endMer) {
    const s = to24(startHour, startMer === 'PM') * 60 + startMin;
    const e = to24(endHour, endMer === 'PM') * 60 + endMin;
    if (e <= s || e - s > 180) return null;
    return {
      startTimeSlot: `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`,
      endTimeSlot: `${pad2(Math.floor(e / 60))}:${pad2(e % 60)}`,
      assumedMeridiem: false,
    };
  }

  // ── One meridiem: infer the other by picking the shortest positive span ──
  // Handles ranges that cross noon, e.g. "11:30-12:30PM" = 11:30 AM to 12:30 PM.
  const known = endMer || startMer;
  if (known) {
    const anchorIsEnd = Boolean(endMer);
    const anchorTotal = anchorIsEnd
      ? to24(endHour, known === 'PM') * 60 + endMin
      : to24(startHour, known === 'PM') * 60 + startMin;

    const otherHour = anchorIsEnd ? startHour : endHour;
    const otherMin = anchorIsEnd ? startMin : endMin;
    const options = [false, true]
      .map((isPM) => {
        const total = to24(otherHour, isPM) * 60 + otherMin;
        return { total, duration: anchorIsEnd ? anchorTotal - total : total - anchorTotal };
      })
      .filter((c) => c.duration > 0 && c.duration <= 180)
      .sort((a, b) => a.duration - b.duration);
    if (!options.length) return null;

    const s = anchorIsEnd ? options[0].total : anchorTotal;
    const e = anchorIsEnd ? anchorTotal : options[0].total;
    return {
      startTimeSlot: `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`,
      endTimeSlot: `${pad2(Math.floor(e / 60))}:${pad2(e % 60)}`,
      assumedMeridiem: false,
    };
  }

  // ── No meridiem at all, both hours 1-12 ──────────────────────────────────
  // Genuinely ambiguous ("3:30-4:30" is 03:30 or 15:30). Rather than dropping
  // the header — which is what produced the empty-time collisions — read it on
  // the institute's own clock and mark it ASSUMED so the admin reviews it:
  // 1-7 o'clock is afternoon/evening coaching, 8-12 is morning.
  const startIsPM = startHour >= 1 && startHour <= 7;
  const s24 = to24(startHour, startIsPM);
  let e24 = to24(endHour, endHour >= 1 && endHour <= 7);
  // Keep the range moving forwards across the noon boundary (11:30-12:30).
  if (e24 * 60 + endMin <= s24 * 60 + startMin) e24 = to24(endHour, !(endHour >= 1 && endHour <= 7));

  const s = s24 * 60 + startMin;
  const e = e24 * 60 + endMin;
  if (e <= s || e - s > 180) return null;
  return {
    startTimeSlot: `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`,
    endTimeSlot: `${pad2(Math.floor(e / 60))}:${pad2(e % 60)}`,
    assumedMeridiem: true,
  };
}

export interface ParsedRowLabel {
  classLevel: string;
  batch: string;
  /** True when no class number could be read and the whole label became the batch. */
  needsReview: boolean;
}

/**
 * Split a verbatim row label ("8th adv", "11th JEE B1", "7th") into
 * classLevel + batch. The model only transcribes the label; it never decides
 * this split itself, removing a class of drift where the same row could be
 * split differently across cells.
 *
 * ── Why this no longer returns null ─────────────────────────────────────────
 * It used to require the label to START with digits, so "Class 10",
 * "Foundation", "NEET Dropper", "Batch A" and "JEE 11th" returned null — and
 * the caller dropped EVERY CELL IN THAT ROW without telling anyone. Losing a
 * whole row of real classes because its heading is worded differently is the
 * worst failure this pipeline has. A leading number is now preferred, an
 * embedded number is accepted, and a label with no number at all still yields
 * a row, flagged for the admin to complete.
 */
export function parseRowLabel(label: string): ParsedRowLabel {
  const text = String(label || '').trim();

  // Preferred: the label opens with the class number — "8th adv", "11 JEE B1".
  const leading = text.match(/^(\d{1,2})\s*(?:st|nd|rd|th)?\.?\s*(.*)$/i);
  if (leading) {
    return { classLevel: leading[1], batch: leading[2].trim(), needsReview: false };
  }

  // Accepted: the number appears after a word — "Class 10", "JEE 11th",
  // "Std. 9 B1". Take the first 1-2 digit run as the class and keep the rest,
  // minus a leading "class"/"std"/"standard" noise word, as the batch.
  const embedded = text.match(/^(.*?)\b(\d{1,2})\s*(?:st|nd|rd|th)?\.?\b(.*)$/i);
  if (embedded) {
    // Strip the noise word AND the punctuation it leaves behind ("Std." -> "").
    const before = embedded[1]
      .replace(/\b(class|std|standard|grade)\b/gi, ' ')
      .replace(/[.,:;\-–—]/g, ' ')
      .trim();
    const after = embedded[3].replace(/^[.,:;\-–—\s]+/, '').trim();
    const batch = [before, after].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return { classLevel: embedded[2], batch, needsReview: false };
  }

  // No number anywhere — "Foundation", "NEET Dropper", "Batch A". Keep the row.
  return { classLevel: '', batch: text, needsReview: true };
}

// A populated timetable cell is a teacher allocation (+ optional room/note),
// NOT a general announcement or reminder — those must never become schedule
// entries.
//
// ── Why this is no longer a word count ──────────────────────────────────────
// The rule used to be "keep if it has an honorific, OR ends in a number, OR is
// at most THREE words". That cliff silently deleted ordinary allocations the
// moment a full name met a two-word subject: "Nitesh Thakur Organic Chemistry",
// "Soniya Arora Physical Chemistry" and "Abir Chatterjee Maths Adv" were all
// dropped as "announcements". The test is now inverted — keep the cell unless
// it actually reads like prose — because the cost of the two errors is not
// symmetric: a wrongly-kept announcement is one row the admin deletes on the
// review screen, while a wrongly-dropped class is a class that silently never
// existed.
const ANNOUNCEMENT_RE =
  /\b(?:please|kindly|note|notice|reminder|inform|informed|all\s+students|holiday|no\s+class(?:es)?|cancell?ed|postponed|will\s+be|has\s+been|should|must|bring|submit|exam\s+on|test\s+on)\b/i;

export function looksLikeScheduleCell(rawText: string): boolean {
  const text = String(rawText || '').trim();
  if (!text) return false;

  // Prose markers win outright — an announcement can still be short.
  if (ANNOUNCEMENT_RE.test(text)) return false;
  // A sentence break followed by more words is prose, not an allocation.
  if (/[.!?]\s+\w/.test(text)) return false;

  // Strong positive signals, unchanged.
  if (HONORIFIC_RE.test(text)) return true;
  if (/\d{1,2}\s*$/.test(text)) return true;

  // Anything else short enough to be a name (+ subject/batch) is an allocation.
  // Eight words is comfortably above "Firstname Lastname Organic Chemistry
  // Batch B1" and still well below anything that reads as a notice.
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return wordCount <= 8;
}
