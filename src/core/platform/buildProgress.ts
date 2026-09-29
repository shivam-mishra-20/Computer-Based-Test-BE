/**
 * How far along a build is, in a form a person can read.
 *
 * ── Why the stored `progress` was not enough ────────────────────────────────
 * The worker writes a number at each milestone — 10 when it starts, 45 when it
 * uploads, 75 when EAS reports IN_PROGRESS — and nothing in between. The
 * milestones are honest, but they are not spread the way TIME is: everything
 * before EAS takes a minute or two, and then a single phase, the compile, takes
 * ten or fifteen minutes while the number sits at 75. An administrator watching
 * the console saw a bar that jumped three-quarters of the way in the first
 * minute and then did not move again, which reads as a build that has hung.
 *
 * ── What this does instead ──────────────────────────────────────────────────
 * The bar is divided by how long each phase actually takes, and the long
 * phases advance on real signals:
 *
 *   · WAITING for an EAS machine uses EAS's own queue position when it gives
 *     one (`queuePosition` of `initialQueuePosition`), and its own
 *     `estimatedWaitTimeLeftSeconds` for the ETA.
 *   · BUILDING uses time elapsed against how long THIS organization's recent
 *     builds actually took (median, from the job history), falling back to a
 *     platform-wide median and then to a documented default.
 *
 * ── The rules that keep an estimate honest ──────────────────────────────────
 *   1. It never reaches 100 until the build is actually complete. The building
 *      phase approaches its ceiling asymptotically, so a slow build slows the
 *      bar down rather than parking it at 100% with nothing to download.
 *   2. It never goes backwards within a phase for the same inputs — time only
 *      adds. (EAS can move a build back in its queue; the console keeps the
 *      highest value it has shown, which is the one place that can know.)
 *   3. It says when it is guessing. `estimated` is true whenever the percent
 *      includes a time-based estimate, and the ETA is phrased "about".
 *   4. A failed build does not show 100%. The stored progress IS 100 on a
 *      failure — "the job is over" — but a full bar reads as success, so the
 *      view freezes at the phase where it stopped.
 *
 * Pure: no database, no clock of its own. `now` and the expected duration are
 * passed in, so every rule above can be asserted without waiting ten minutes.
 */

/** The steps an administrator sees, in order. */
export const BUILD_STEPS = [
  'queued',
  'preparing',
  'waiting',
  'building',
  'ready',
] as const;
export type BuildStep = (typeof BUILD_STEPS)[number];

export const BUILD_STEP_LABELS: Record<BuildStep, string> = {
  queued: 'Queued',
  preparing: 'Preparing',
  waiting: 'Waiting for a builder',
  building: 'Building',
  ready: 'Ready',
};

/**
 * Where each step starts and stops on the bar.
 *
 * Proportional to how long the steps usually take, not to how many there are.
 * Five equal fifths would put a two-minute preparation and a twelve-minute
 * compile on the same width, and the bar would crawl through the part that
 * matters and sprint through the part that does not.
 */
export const STEP_SPAN: Record<BuildStep, readonly [number, number]> = {
  queued: [0, 3],
  preparing: [3, 20],
  waiting: [20, 30],
  building: [30, 97],
  ready: [100, 100],
};

/** When nothing better is known. An Android release build on EAS's free tier. */
export const DEFAULT_BUILD_MS: Record<'apk' | 'aab', number> = {
  apk: 12 * 60_000,
  aab: 14 * 60_000,
};

/** A measured duration outside this range is a measurement error, not a build. */
const PLAUSIBLE_BUILD_MS: readonly [number, number] = [2 * 60_000, 90 * 60_000];

export type BuildPhase = BuildStep | 'finishing' | 'failed' | 'cancelled';

export interface BuildProgressInput {
  status: string;
  /** What the worker last wrote, 0–100. */
  storedProgress: number;
  /** EAS's own status once submitted: NEW, IN_QUEUE, IN_PROGRESS, FINISHED. */
  easStatus?: string | null;
  queuedAt?: Date | string | null;
  startedAt?: Date | string | null;
  /** When the current preparation sub-step began — the job's `updatedAt`. */
  stepStartedAt?: Date | string | null;
  easSubmittedAt?: Date | string | null;
  buildingStartedAt?: Date | string | null;
  completedAt?: Date | string | null;
  failedAt?: Date | string | null;
  cancelledAt?: Date | string | null;
  queuePosition?: number | null;
  initialQueuePosition?: number | null;
  estimatedWaitSeconds?: number | null;
  /** How long a build like this one usually takes on EAS. */
  expectedBuildMs: number;
  now: number;
}

export interface BuildProgressView {
  /** 0–100, whole numbers. 100 only when there is a file to download. */
  percent: number;
  phase: BuildPhase;
  /** Index into BUILD_STEPS of the step this build is on, or stopped at. */
  step: number;
  /** "Building", "Waiting for a builder" — a phase, in words. */
  label: string;
  /** "2nd in line", "About 6 min left" — or null when there is nothing to add. */
  detail: string | null;
  /** Seconds until done, when it can be estimated. */
  etaSeconds: number | null;
  /** Seconds since the worker began — what "Running 6m" counts. */
  elapsedSeconds: number;
  /** True when the percent includes a time-based estimate. */
  estimated: boolean;
  /** Whole seconds the finished build took, from start to file. */
  totalSeconds: number | null;
}

function ms(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

/** Where a fraction of the way through a step lands on the bar. */
function within(step: BuildStep, fraction: number): number {
  const [lo, hi] = STEP_SPAN[step];
  return lo + (hi - lo) * clamp(fraction, 0, 1);
}

/** 1st, 2nd, 3rd, 11th, 22nd. For "2nd in line". */
export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** "About 6 min left", in the words a person would use. */
export function etaLabel(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  if (seconds <= 45) return 'Less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes <= 1) return 'About a minute left';
  return `About ${minutes} min left`;
}

/**
 * Progress through the compile, from time alone.
 *
 * Linear until the expected duration, reaching 92% of the phase there; then an
 * exponential approach to the ceiling that it never quite meets. So a build
 * running long visibly slows down near the end — which is true — instead of
 * sitting at a full bar, which would be a lie with a download button missing.
 */
export function buildingFraction(
  elapsedMs: number,
  expectedMs: number,
): number {
  const expected = Math.max(expectedMs, 60_000);
  const t = Math.max(0, elapsedMs);
  const knee = 0.92;
  if (t <= expected) return knee * (t / expected);
  const over = (t - expected) / (0.35 * expected);
  return knee + (1 - knee) * (1 - Math.exp(-over)) * 0.98;
}

/**
 * The view of one build at one instant.
 *
 * Total: any combination of fields produces a sensible answer, because the
 * record it reads was written by a worker that can die between any two lines.
 */
export function describeBuildProgress(
  input: BuildProgressInput,
): BuildProgressView {
  const now = input.now;
  const began = ms(input.startedAt) ?? ms(input.queuedAt) ?? now;
  const elapsedSeconds = Math.max(0, Math.round((now - began) / 1000));
  const easStatus = String(input.easStatus ?? '').toUpperCase();
  const submitted = ms(input.easSubmittedAt);
  const compiling = ms(input.buildingStartedAt);

  /* ── Finished, one way or another ──────────────────────────────────── */

  if (input.status === 'completed') {
    const done = ms(input.completedAt) ?? now;
    return {
      percent: 100,
      phase: 'ready',
      step: BUILD_STEPS.indexOf('ready'),
      label: BUILD_STEP_LABELS.ready,
      detail: null,
      etaSeconds: 0,
      elapsedSeconds,
      estimated: false,
      totalSeconds: Math.max(0, Math.round((done - began) / 1000)),
    };
  }

  if (input.status === 'failed' || input.status === 'cancelled') {
    // Where it got to, from what was recorded along the way. The stored
    // progress is 100 here and cannot be used: see rule 4 above.
    const reached: BuildStep = compiling
      ? 'building'
      : submitted || easStatus
        ? 'waiting'
        : input.startedAt
          ? 'preparing'
          : 'queued';
    const [lo, hi] = STEP_SPAN[reached];
    return {
      percent: Math.round(lo + (hi - lo) * 0.5),
      phase: input.status,
      step: BUILD_STEPS.indexOf(reached),
      label: input.status === 'failed' ? 'Build failed' : 'Build cancelled',
      detail: `Stopped while ${BUILD_STEP_LABELS[reached].toLowerCase()}`,
      etaSeconds: null,
      elapsedSeconds,
      estimated: false,
      totalSeconds: null,
    };
  }

  /* ── Queued: waiting for our own worker ─────────────────────────────── */

  if (input.status === 'queued') {
    return {
      percent: Math.round(within('queued', 0.6)),
      phase: 'queued',
      step: 0,
      label: 'Waiting to start',
      detail: null,
      etaSeconds: null,
      elapsedSeconds,
      estimated: false,
      totalSeconds: null,
    };
  }

  /* ── Preparing: configuration, Expo project, upload ─────────────────── */

  if (input.status !== 'building') {
    // The worker's own milestones (10 → 25 → 30 → 45) mapped onto the
    // preparing span, plus a gentle creep toward the next milestone while a
    // sub-step runs, so an upload that takes a minute is seen to be moving.
    const stored = clamp(input.storedProgress, 5, 55);
    const base = (stored - 5) / 50;
    const next = Math.min(1, base + 0.3);
    const since = ms(input.stepStartedAt);
    const creep = since ? (1 - Math.exp(-(now - since) / 45_000)) * 0.8 : 0;
    const fraction = base + (next - base) * creep;
    return {
      percent: Math.round(within('preparing', fraction)),
      phase: 'preparing',
      step: 1,
      label:
        input.status === 'provisioning_project'
          ? 'Setting up the Expo project'
          : 'Preparing your app',
      detail: null,
      etaSeconds: null,
      elapsedSeconds,
      estimated: creep > 0,
      totalSeconds: null,
    };
  }

  /* ── EAS has it, and has not finished ───────────────────────────────── */

  // A job that was already on EAS when these fields were introduced has no
  // `easStatus` yet — only the milestone the worker wrote. Read it from that
  // (75 meant IN_PROGRESS, 55–60 meant waiting) until the next poll records
  // the real one, rather than dropping a running build back to "Preparing".
  const eas =
    easStatus || (input.storedProgress >= 70 ? 'IN_PROGRESS' : 'IN_QUEUE');

  if (eas === 'FINISHED') {
    // Seen as finished, not yet recorded as complete: the artifact is being
    // written down. Seconds, and never 100 until it is.
    return {
      percent: 98,
      phase: 'finishing',
      step: BUILD_STEPS.indexOf('building'),
      label: 'Finishing up',
      detail: null,
      etaSeconds: 5,
      elapsedSeconds,
      estimated: false,
      totalSeconds: null,
    };
  }

  if (compiling || eas === 'IN_PROGRESS') {
    // When the compile start was never observed, the hand-off to EAS is the
    // latest moment it can have begun after — so the estimate runs slightly
    // ahead rather than restarting from zero, and the asymptote still keeps
    // it short of the end.
    const startedCompiling = compiling ?? submitted ?? began;
    const elapsed = now - startedCompiling;
    const fraction = buildingFraction(elapsed, input.expectedBuildMs);
    const remaining = Math.round((input.expectedBuildMs - elapsed) / 1000);
    const eta = remaining > 0 ? remaining : null;
    return {
      percent: Math.min(97, Math.round(within('building', fraction))),
      phase: 'building',
      step: BUILD_STEPS.indexOf('building'),
      label: 'Building your app',
      // Past the expected time there is no honest number to give, so it says
      // what is true instead of counting down into negative minutes.
      detail:
        eta !== null ? etaLabel(eta) : 'Taking a little longer than usual',
      etaSeconds: eta,
      elapsedSeconds,
      estimated: true,
      totalSeconds: null,
    };
  }

  // NEW or IN_QUEUE: waiting for a machine on EAS.
  const position = input.queuePosition ?? null;
  const initial = input.initialQueuePosition ?? null;
  let fraction: number;
  let estimated = false;
  if (position !== null && initial !== null && initial > 0) {
    // EAS's own measure of how far through the queue this build is.
    fraction = clamp(1 - position / initial, 0, 0.95);
  } else {
    const since = submitted ?? now;
    fraction = (1 - Math.exp(-(now - since) / 120_000)) * 0.9;
    estimated = true;
  }
  const waitEta =
    typeof input.estimatedWaitSeconds === 'number' &&
    input.estimatedWaitSeconds >= 0
      ? input.estimatedWaitSeconds
      : null;
  return {
    percent: Math.round(within('waiting', fraction)),
    phase: 'waiting',
    step: BUILD_STEPS.indexOf('waiting'),
    label: 'Waiting for a build machine',
    detail:
      position !== null && position > 0
        ? `${ordinal(position)} in line`
        : waitEta !== null
          ? etaLabel(waitEta)
          : null,
    etaSeconds: waitEta,
    elapsedSeconds,
    estimated,
    totalSeconds: null,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   Measuring how long builds take
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * EAS's `metrics.buildDuration`, as milliseconds, or null.
 *
 * The CLI does not document the unit, and guessing wrong by a factor of a
 * thousand would turn every ETA into nonsense. The ranges do not overlap for
 * a real Android build, though: one takes minutes, which is somewhere between
 * 60 and 5,400 in seconds and between 60,000 and 5,400,000 in milliseconds.
 * Anything outside both is discarded rather than interpreted.
 */
export function normaliseEasDuration(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const asMs = n >= 60_000 ? n : n * 1000;
  return asMs >= PLAUSIBLE_BUILD_MS[0] && asMs <= PLAUSIBLE_BUILD_MS[1]
    ? Math.round(asMs)
    : null;
}

/** The middle value, which one pathological build cannot drag around. */
export function median(values: number[]): number | null {
  const sorted = values
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * The expected compile time, from the most specific history available.
 *
 * This organization's own recent builds first — its app, its dependencies,
 * its asset sizes — then the platform's, then the default. Two samples is the
 * minimum for "this organization's": one build is an anecdote, and the first
 * build of any project is the slowest it will ever be, because EAS has no
 * cache for it yet.
 */
export function expectedDurationFrom(
  own: number[],
  platform: number[],
  artifactType: 'apk' | 'aab',
): number {
  const usable = (list: number[]) =>
    list.filter(
      (v) => v >= PLAUSIBLE_BUILD_MS[0] && v <= PLAUSIBLE_BUILD_MS[1],
    );
  const mine = usable(own);
  if (mine.length >= 2) return median(mine) as number;
  const everyone = usable(platform);
  if (everyone.length >= 3) return median(everyone) as number;
  return DEFAULT_BUILD_MS[artifactType];
}
