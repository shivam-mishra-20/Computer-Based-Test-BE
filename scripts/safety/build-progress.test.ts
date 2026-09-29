/**
 * The build progress bar tells the truth, asserted.
 *
 * ── What this protects ──────────────────────────────────────────────────────
 * A progress bar is a promise made continuously. The failures that matter are
 * the ones nobody sees in a screenshot: a bar that reaches 100% with nothing
 * to download, one that goes backwards, one that sits still for twelve minutes
 * and reads as hung, a failed build painted as a full green bar. None of them
 * can be caught by looking at the console for a moment, so every one is
 * checked here against a fixed clock.
 *
 *   npm run safety:build-progress
 */

import {
  BUILD_STEPS,
  STEP_SPAN,
  buildingFraction,
  describeBuildProgress,
  etaLabel,
  expectedDurationFrom,
  median,
  normaliseEasDuration,
  ordinal,
  type BuildProgressInput,
} from '../../src/core/platform/buildProgress';

let checks = 0;
let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  checks++;
  if (!ok) failures++;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label);
  if (!ok && detail) console.log('      ' + detail);
}

const MIN = 60_000;
const T0 = Date.parse('2026-09-23T10:00:00.000Z');
const at = (offsetMs: number) => new Date(T0 + offsetMs);
const EXPECTED = 12 * MIN;

/** A build that has been handed to EAS and is compiling. */
function compiling(
  elapsedMs: number,
  extra: Partial<BuildProgressInput> = {},
): BuildProgressInput {
  return {
    status: 'building',
    storedProgress: 75,
    easStatus: 'IN_PROGRESS',
    queuedAt: at(-3 * MIN),
    startedAt: at(-3 * MIN),
    easSubmittedAt: at(-2 * MIN),
    buildingStartedAt: at(0),
    expectedBuildMs: EXPECTED,
    now: T0 + elapsedMs,
    ...extra,
  };
}

console.log('\nBUILD PROGRESS\n');

/* ── 1. It moves while EAS is compiling ──────────────────────────────────── */

console.log('the long phase');

const samples = [0, 1, 3, 6, 9, 12, 15, 20, 30].map(
  (m) => describeBuildProgress(compiling(m * MIN)).percent,
);

check(
  'the bar advances through the compile instead of parking',
  new Set(samples).size >= 7,
  'samples: ' +
    samples.join(', ') +
    ' — a bar stuck at one value for ten minutes reads as a hung build',
);
check(
  'it never goes backwards as time passes',
  samples.every((v, i) => i === 0 || v >= samples[i - 1]),
  samples.join(', '),
);
check(
  'it never reaches 100 while compiling, however long it runs',
  describeBuildProgress(compiling(6 * 60 * MIN)).percent < 100,
  String(describeBuildProgress(compiling(6 * 60 * MIN)).percent),
);
check(
  'at the expected duration it is most of the way, not all of it',
  (() => {
    const p = describeBuildProgress(compiling(EXPECTED)).percent;
    return p >= 85 && p <= 94;
  })(),
  String(describeBuildProgress(compiling(EXPECTED)).percent),
);
check(
  'a slow build slows the bar rather than stopping it',
  describeBuildProgress(compiling(EXPECTED + 10 * MIN)).percent >
    describeBuildProgress(compiling(EXPECTED + 2 * MIN)).percent,
);
check(
  'the fraction is bounded below the ceiling',
  buildingFraction(1e12, EXPECTED) < 1,
  String(buildingFraction(1e12, EXPECTED)),
);

check(
  'while compiling it says how long is left',
  /^About \d+ min left$/.test(
    String(describeBuildProgress(compiling(3 * MIN)).detail),
  ),
  String(describeBuildProgress(compiling(3 * MIN)).detail),
);
check(
  '...and past the expected time it stops counting down',
  describeBuildProgress(compiling(EXPECTED + 3 * MIN)).detail ===
    'Taking a little longer than usual' &&
    describeBuildProgress(compiling(EXPECTED + 3 * MIN)).etaSeconds === null,
  'counting into negative minutes is worse than admitting the estimate ran out',
);
check(
  'a compiling percent is flagged as an estimate',
  describeBuildProgress(compiling(5 * MIN)).estimated === true,
);

/* ── 2. The whole journey is monotonic ───────────────────────────────────── */

console.log('\nfrom click to download');

const journey: [string, BuildProgressInput][] = [
  [
    'queued',
    {
      status: 'queued',
      storedProgress: 5,
      queuedAt: at(0),
      expectedBuildMs: EXPECTED,
      now: T0 + 2000,
    },
  ],
  [
    'preparing',
    {
      status: 'preparing',
      storedProgress: 10,
      startedAt: at(0),
      stepStartedAt: at(0),
      expectedBuildMs: EXPECTED,
      now: T0 + 5000,
    },
  ],
  [
    'uploading',
    {
      status: 'preparing',
      storedProgress: 45,
      startedAt: at(0),
      stepStartedAt: at(60_000),
      expectedBuildMs: EXPECTED,
      now: T0 + 90_000,
    },
  ],
  [
    'in the EAS queue',
    {
      status: 'building',
      storedProgress: 60,
      easStatus: 'IN_QUEUE',
      startedAt: at(0),
      easSubmittedAt: at(2 * MIN),
      queuePosition: 3,
      initialQueuePosition: 6,
      expectedBuildMs: EXPECTED,
      now: T0 + 3 * MIN,
    },
  ],
  ['compiling, early', compiling(2 * MIN)],
  ['compiling, late', compiling(11 * MIN)],
  ['finishing', { ...compiling(13 * MIN), easStatus: 'FINISHED' }],
  [
    'completed',
    {
      ...compiling(13 * MIN),
      status: 'completed',
      storedProgress: 100,
      completedAt: at(13 * MIN),
    },
  ],
];

const percents = journey.map(
  ([, input]) => describeBuildProgress(input).percent,
);
check(
  'every step of the journey is at or beyond the one before',
  percents.every((v, i) => i === 0 || v >= percents[i - 1]),
  journey.map(([name], i) => `${name}=${percents[i]}`).join('  '),
);
check(
  'it starts near zero',
  percents[0] <= STEP_SPAN.queued[1],
  String(percents[0]),
);
check('it ends at exactly 100', percents[percents.length - 1] === 100);
check(
  'only the completed build is at 100',
  percents.slice(0, -1).every((p) => p < 100),
  percents.join(', '),
);

const steps = journey.map(([, input]) => describeBuildProgress(input).step);
check(
  'the step never goes backwards either',
  steps.every((v, i) => i === 0 || v >= steps[i - 1]),
  steps.join(', '),
);
check(
  'the last step is Ready',
  steps[steps.length - 1] === BUILD_STEPS.indexOf('ready'),
);

check(
  'the phases the time actually goes to get most of the bar',
  STEP_SPAN.building[1] - STEP_SPAN.building[0] > 50,
  'a two-minute preparation and a twelve-minute compile on equal widths is a bar that lies about pace',
);

/* ── 3. The queue uses EAS's own numbers ─────────────────────────────────── */

console.log('\nwaiting for a build machine');

const queued = (position: number, initial = 6) =>
  describeBuildProgress({
    status: 'building',
    storedProgress: 60,
    easStatus: 'IN_QUEUE',
    startedAt: at(0),
    easSubmittedAt: at(0),
    queuePosition: position,
    initialQueuePosition: initial,
    estimatedWaitSeconds: 240,
    expectedBuildMs: EXPECTED,
    now: T0 + MIN,
  });

check(
  'moving up the queue moves the bar',
  queued(2).percent > queued(5).percent,
);
check(
  'the position is said in words',
  queued(2).detail === '2nd in line',
  String(queued(2).detail),
);
check('EAS’s own wait estimate is the ETA', queued(2).etaSeconds === 240);
check(
  'queue progress is not flagged as a guess',
  queued(2).estimated === false,
  'it comes from EAS’s queue position, not from a clock',
);
check(
  'the waiting phase never spills into the building phase',
  queued(0).percent <= STEP_SPAN.waiting[1],
  String(queued(0).percent),
);

/* ── 4. A build that ended badly does not look like success ─────────────── */

console.log('\nfailure and cancellation');

const failedWhileCompiling = describeBuildProgress({
  ...compiling(5 * MIN),
  status: 'failed',
  storedProgress: 100,
  failedAt: at(5 * MIN),
});
check(
  'a failed build is NOT shown at 100%',
  failedWhileCompiling.percent < 100,
  'the stored progress is 100 on failure, and a full bar reads as success',
);
check(
  '...it says where it stopped',
  failedWhileCompiling.detail === 'Stopped while building',
);
check('...and it is marked failed', failedWhileCompiling.phase === 'failed');

const failedEarly = describeBuildProgress({
  status: 'failed',
  storedProgress: 100,
  startedAt: at(0),
  failedAt: at(30_000),
  expectedBuildMs: EXPECTED,
  now: T0 + MIN,
});
check(
  'a failure during preparation stops the bar in preparation',
  failedEarly.step === BUILD_STEPS.indexOf('preparing') &&
    failedEarly.percent <= STEP_SPAN.preparing[1],
  JSON.stringify(failedEarly),
);

const cancelled = describeBuildProgress({
  ...compiling(4 * MIN),
  status: 'cancelled',
  storedProgress: 100,
});
check(
  'a cancelled build is not 100% either',
  cancelled.percent < 100 && cancelled.phase === 'cancelled',
);

/* ── 5. A completed build reports how long it took ───────────────────────── */

const done = describeBuildProgress({
  ...compiling(12 * MIN),
  status: 'completed',
  storedProgress: 100,
  startedAt: at(-3 * MIN),
  completedAt: at(12 * MIN),
});
check(
  'a completed build knows its total time',
  done.totalSeconds === 15 * 60,
  String(done.totalSeconds),
);

/* ── 6. A record written by a worker that died mid-way still describes ───── */

console.log('\nincomplete records');

const bare = describeBuildProgress({
  status: 'building',
  storedProgress: 55,
  expectedBuildMs: EXPECTED,
  now: T0,
});
check(
  'a building job with no timestamps still produces a sensible view',
  Number.isFinite(bare.percent) && bare.percent >= 0 && bare.percent < 100,
  JSON.stringify(bare),
);
const legacy = describeBuildProgress({
  status: 'building',
  storedProgress: 75,
  startedAt: at(-10 * MIN),
  expectedBuildMs: EXPECTED,
  now: T0,
});
check(
  'a build already on EAS before these fields existed is still shown building',
  legacy.phase === 'building' && legacy.percent > STEP_SPAN.waiting[1],
  JSON.stringify(legacy) +
    ' — dropping a running build back to "Preparing" would look like a restart',
);
check(
  '...and its estimate does not restart from zero',
  legacy.percent > STEP_SPAN.building[0] + 10,
  String(legacy.percent),
);

const unknown = describeBuildProgress({
  status: 'something-new',
  storedProgress: 40,
  expectedBuildMs: EXPECTED,
  now: T0,
});
check('an unknown status never claims completion', unknown.percent < 100);

/* ── 7. Measuring how long builds take ───────────────────────────────────── */

console.log('\nexpected duration');

check(
  'seconds are recognised as seconds',
  normaliseEasDuration(720) === 720_000,
);
check(
  'milliseconds are recognised as milliseconds',
  normaliseEasDuration(720_000) === 720_000,
);
check(
  'an implausibly short value is discarded',
  normaliseEasDuration(30) === null,
);
check(
  'an implausibly long value is discarded',
  normaliseEasDuration(10 * 60 * 60 * 1000) === null,
);
check(
  'garbage is discarded',
  normaliseEasDuration('soon') === null && normaliseEasDuration(null) === null,
);

check('median of an odd list', median([5, 1, 9]) === 5);
check('median of an even list', median([4, 8, 1, 9]) === 6);
check('median of nothing', median([]) === null);

check(
  'an organization’s own history wins when it has enough',
  expectedDurationFrom(
    [10 * MIN, 11 * MIN, 12 * MIN],
    [20 * MIN, 20 * MIN, 20 * MIN],
    'apk',
  ) ===
    11 * MIN,
);
check(
  'one build is an anecdote, so the platform decides',
  expectedDurationFrom([30 * MIN], [9 * MIN, 10 * MIN, 11 * MIN], 'apk') ===
    10 * MIN,
  'the first build of a project is the slowest it will ever be — EAS has no cache for it yet',
);
check(
  'with no history at all there is a documented default',
  expectedDurationFrom([], [], 'aab') === 14 * MIN &&
    expectedDurationFrom([], [], 'apk') === 12 * MIN,
);

/* ── 8. The words ────────────────────────────────────────────────────────── */

check(
  'ordinals read correctly',
  [1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal).join(' ') ===
    '1st 2nd 3rd 4th 11th 12th 13th 21st 22nd 101st',
);
check(
  'under a minute is said as such',
  etaLabel(30) === 'Less than a minute left',
);
check('minutes are rounded', etaLabel(6 * 60 + 20) === 'About 6 min left');

console.log('\n  ' + (checks - failures) + '/' + checks + ' checks passed.\n');
process.exit(failures ? 1 : 0);
