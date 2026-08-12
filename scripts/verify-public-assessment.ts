/**
 * Public assessment safety verification (pure logic — no DB required).
 *
 * Phase A locked in the safety properties:
 *   1. A question served during an attempt carries NO answer key.
 *   2. Public assessments live in their own collections, and the published
 *      floor cannot be widened by a client.
 *
 * Phase B adds the behaviour those endpoints depend on:
 *   3. Grading is server-authoritative and iterates the frozen snapshot, so a
 *      tampered request cannot change a score and a skipped question still
 *      counts against the maximum.
 *   4. Guests browse and learners attempt — enforced by the router shape itself,
 *      not by remembering to check inside each handler.
 *
 * Run:  npm run verify:assessment
 */

import type { Request } from 'express';
import PublicAttempt from '../src/models/PublicAttempt';
import PublicTest from '../src/models/PublicTest';
import PublicTestSeries from '../src/models/PublicTestSeries';
import Attempt from '../src/models/Attempt';
import Exam from '../src/models/Exam';
import learnerRouter from '../src/routes/api/learnerRoutes';
import publicTestRoutes from '../src/routes/api/publicTestRoutes';
import adminRouter from '../src/routes/api/publicTestAdminRoutes';
import { formatClassCollection } from '../src/models/ClassQuestion';
import { resolveQuestionModel } from '../src/utils/questionSource';
import {
  applyOptionOrder,
  buildSnapshot,
  gradeAttempt,
  normalizePublicClass,
} from '../src/services/publicAssessmentService';
import {
  ANSWER_KEY_FIELDS,
  ATTEMPT_QUESTION_PROJECTION,
  MIN_QUESTIONS_FOR_SUBJECT_VERDICT,
  applyPublishedFloor,
  GRADABILITY_FIELDS,
  cloneSections,
  isAutoGradable,
  foldBreakdowns,
  isAssessmentStaff,
  isTestStartable,
  leaksAnswerKey,
  rankSubjectPerformance,
  revealQuestionForReview,
  sanitizeQuestionForAttempt,
} from '../src/utils/publicAssessment';

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean) {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL  ${label}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

const req = (role?: string) => ({ user: role ? { role } : undefined }) as unknown as Request;

/** A question with every answer-bearing field populated. */
const loadedQuestion: any = {
  _id: 'q1',
  text: 'What is the SI unit of force?',
  type: 'mcq',
  options: [
    { _id: 'o1', text: 'Newton', isCorrect: true },
    { _id: 'o2', text: 'Joule', isCorrect: false },
    { _id: 'o3', text: 'Watt', isCorrect: false },
  ],
  correctAnswerText: 'Newton',
  integerAnswer: 42,
  assertionIsTrue: true,
  reasonIsTrue: true,
  reasonExplainsAssertion: false,
  explanation: 'Force = mass x acceleration, measured in newtons.',
  tags: { subject: 'Physics', topic: 'Units', difficulty: 'easy' },
  metadata: { marks: 4 },
};

console.log('Answer key never reaches a live attempt:');
const safe = sanitizeQuestionForAttempt(loadedQuestion);

ANSWER_KEY_FIELDS.forEach((f) => {
  ok(`${f} is stripped`, (safe as any)[f] === undefined);
});
ok(
  'no option carries isCorrect',
  (safe.options ?? []).every((o) => (o as any).isCorrect === undefined),
);
ok('leaksAnswerKey() agrees the sanitised question is clean', !leaksAnswerKey(safe));
ok('leaksAnswerKey() catches the raw question', leaksAnswerKey(loadedQuestion));

console.log('\nWhat a learner still needs IS present:');
ok('question text kept', safe.text === loadedQuestion.text);
ok('all options kept', (safe.options ?? []).length === 3);
ok('option text kept', safe.options?.[0].text === 'Newton');
ok('subject kept for the analysis breakdown', safe.subject === 'Physics');
ok('difficulty kept for the analysis breakdown', safe.difficulty === 'easy');
ok('marks kept', safe.marks === 4);

console.log('\nProjection covers every top-level key field:');
ANSWER_KEY_FIELDS.forEach((f) => {
  ok(`projection excludes ${f}`, ATTEMPT_QUESTION_PROJECTION.includes(`-${f}`));
});

console.log('\nReview reveals the key ONLY through the explicit function:');
const reviewed = revealQuestionForReview(loadedQuestion);
ok('review exposes correct option', reviewed.options?.[0].isCorrect === true);
ok('review exposes explanation', !!reviewed.explanation);
ok('review is a different function from the attempt one', leaksAnswerKey(reviewed));

console.log('\nCollections are separate from the institute stack:');
ok('PublicTest is its own collection', PublicTest.collection.name !== Exam.collection.name);
ok(
  'PublicAttempt is its own collection',
  PublicAttempt.collection.name !== Attempt.collection.name,
);
ok(
  'PublicTestSeries is its own collection',
  PublicTestSeries.collection.name !== Exam.collection.name,
);
ok('PublicAttempt keys on learnerId, not userId', !!PublicAttempt.schema.path('learnerId'));
ok('PublicAttempt has no institute examId field', !PublicAttempt.schema.path('examId'));
ok('PublicTest has no institute batch field', !PublicTest.schema.path('batch'));
ok('PublicTest has no institute assignedTo field', !PublicTest.schema.path('assignedTo'));

console.log('\nPublished floor:');
const learnerQuery = applyPublishedFloor({} as any, req('student'));
ok('learner sees published only', learnerQuery.status === 'published');
const guestQuery = applyPublishedFloor({} as any, req());
ok('guest sees published only', guestQuery.status === 'published');
const staffQuery = applyPublishedFloor({} as any, req('teacher'));
ok('staff is not floored', staffQuery.status === undefined);
const attacked = applyPublishedFloor({ status: 'draft' } as any, req());
ok('client-supplied status=draft is overridden', attacked.status === 'published');

ok('student is not assessment staff', !isAssessmentStaff(req('student')));
ok('teacher is assessment staff', isAssessmentStaff(req('teacher')));
ok('admin is assessment staff', isAssessmentStaff(req('admin')));

console.log('\nStartability is separate from discoverability:');
const now = new Date('2026-06-15T12:00:00Z');
ok('draft is never startable', !isTestStartable({ status: 'draft' }, now).startable);
ok(
  'published with no window is startable',
  isTestStartable({ status: 'published' }, now).startable,
);
ok(
  'before the window opens is not startable',
  isTestStartable(
    {
      status: 'published',
      schedule: { startAt: new Date('2026-06-16T00:00:00Z') },
    },
    now,
  ).reason === 'not-open-yet',
);
ok(
  'after the window closes is not startable',
  isTestStartable(
    {
      status: 'published',
      schedule: { endAt: new Date('2026-06-14T00:00:00Z') },
    },
    now,
  ).reason === 'closed',
);
ok(
  'inside the window is startable',
  isTestStartable(
    {
      status: 'published',
      schedule: {
        startAt: new Date('2026-06-14T00:00:00Z'),
        endAt: new Date('2026-06-16T00:00:00Z'),
      },
    },
    now,
  ).startable,
);

console.log('\nDuplication produces an independent copy:');
const original = [
  {
    _id: 'sec1',
    title: 'Section A',
    questionIds: ['q1', 'q2'],
    shuffleQuestions: true,
  },
];
const copy = cloneSections(original);
ok('section _id is dropped so Mongo mints a new one', (copy[0] as any)._id === undefined);
ok('title copied', copy[0].title === 'Section A');
ok('settings copied', copy[0].shuffleQuestions === true);
ok('question ids copied', copy[0].questionIds.length === 2);
ok('question id array is a NEW array', copy[0].questionIds !== original[0].questionIds);

copy[0].questionIds.push('q3');
copy[0].title = 'Renamed';
ok('editing the copy does not change the original ids', original[0].questionIds.length === 2);
ok('editing the copy does not change the original title', original[0].title === 'Section A');

// ─────────────────────────────────────────────────────────────────────────────
// PHASE B — grading, snapshots and endpoint shape.
//
// Everything below is still pure logic. The grader is the piece that turns a
// learner's work into a number they will believe, so its edge cases are pinned
// here rather than discovered in production.
// ─────────────────────────────────────────────────────────────────────────────

const q = (id: string, subject: string, difficulty: string, correctOptId: string) => ({
  _id: id,
  type: 'mcq',
  text: `Question ${id}`,
  options: [
    { _id: `${id}-a`, text: 'A', isCorrect: correctOptId === `${id}-a` },
    { _id: `${id}-b`, text: 'B', isCorrect: correctOptId === `${id}-b` },
  ],
  tags: { subject, difficulty },
});

const bank: any[] = [
  q('q1', 'Physics', 'easy', 'q1-a'),
  q('q2', 'Physics', 'hard', 'q2-a'),
  q('q3', 'Chemistry', 'medium', 'q3-a'),
  q('q4', 'Chemistry', 'easy', 'q4-a'),
];

const attemptOf = (order: string[], answers: any[]) =>
  ({
    snapshot: { questionOrder: order, optionOrderByQuestion: {} },
    answers,
  }) as any;

const JEE = { correct: 4, incorrect: -1, unattempted: 0 };

console.log('\nGrading iterates the SNAPSHOT, not the answer list:');
{
  // 4 questions on the paper; the learner answered only 2 (one right, one wrong).
  const graded = gradeAttempt(
    attemptOf(
      ['q1', 'q2', 'q3', 'q4'],
      [
        { questionId: 'q1', chosenOptionId: 'q1-a' }, // correct
        { questionId: 'q2', chosenOptionId: 'q2-b' }, // wrong
      ],
    ),
    bank as any,
    JEE,
  );

  ok('max counts every question on the paper, not just answered ones', graded.maxScore === 16);
  ok('score applies the marking scheme (+4 −1)', graded.totalScore === 3);
  ok('correct counted', graded.correctCount === 1);
  ok('incorrect counted', graded.incorrectCount === 1);
  ok('skipped questions counted as unattempted', graded.unattemptedCount === 2);
  ok('percentage is score over the FULL max', graded.percentage === 18.75);
  ok('only responded questions produce answer rows', graded.answers.length === 2);
  ok('grader stamps isCorrect', graded.answers[0].isCorrect === true);
  ok('grader stamps scoreAwarded', graded.answers[0].scoreAwarded === 4);
  ok('wrong answer gets the negative mark', graded.answers[1].scoreAwarded === -1);
}

console.log('\nA client cannot inflate its own score:');
{
  // A tampered request claiming a wrong answer is correct and worth 100.
  const graded = gradeAttempt(
    attemptOf(
      ['q1'],
      [
        {
          questionId: 'q1',
          chosenOptionId: 'q1-b',
          isCorrect: true,
          scoreAwarded: 100,
        },
      ],
    ),
    bank as any,
    JEE,
  );
  ok('client isCorrect=true is overwritten by the key', graded.answers[0].isCorrect === false);
  ok('client scoreAwarded=100 is overwritten', graded.answers[0].scoreAwarded === -1);
  ok('total reflects the real grade', graded.totalScore === -1);
}

console.log('\nAnswers outside the snapshot are ignored:');
{
  const graded = gradeAttempt(
    attemptOf(
      ['q1'],
      [
        { questionId: 'q1', chosenOptionId: 'q1-a' },
        { questionId: 'q3', chosenOptionId: 'q3-a' }, // never on this paper
      ],
    ),
    bank as any,
    JEE,
  );
  ok('max covers only the snapshot', graded.maxScore === 4);
  ok('an off-paper answer earns nothing', graded.totalScore === 4);
  ok('an off-paper answer is not graded', graded.answers.length === 1);
}

console.log('\nSubjective questions are excluded from score AND max:');
{
  const withEssay = [...bank, { _id: 'q5', type: 'subjective', text: 'Explain', tags: {} }];
  const graded = gradeAttempt(
    attemptOf(['q1', 'q5'], [{ questionId: 'q1', chosenOptionId: 'q1-a' }]),
    withEssay as any,
    JEE,
  );
  ok('essay does not inflate the maximum', graded.maxScore === 4);
  ok('essay is not silently marked wrong', graded.incorrectCount === 0);
  ok('essay is not counted as unattempted either', graded.unattemptedCount === 0);
  ok('a full marks result is still 100%', graded.percentage === 100);
}

console.log('\nA question deleted from the bank mid-attempt is skipped:');
{
  const graded = gradeAttempt(
    attemptOf(['q1', 'deleted-id'], [{ questionId: 'q1', chosenOptionId: 'q1-a' }]),
    bank as any,
    JEE,
  );
  ok('missing question does not count toward max', graded.maxScore === 4);
  ok('missing question does not crash grading', graded.totalScore === 4);
}

console.log('\nNegative marking cannot produce a negative percentage:');
{
  const graded = gradeAttempt(
    attemptOf(
      ['q1', 'q2'],
      [
        { questionId: 'q1', chosenOptionId: 'q1-b' },
        { questionId: 'q2', chosenOptionId: 'q2-b' },
      ],
    ),
    bank as any,
    JEE,
  );
  ok('raw total stays honest and negative', graded.totalScore === -2);
  ok('percentage is clamped at 0', graded.percentage === 0);
}

console.log('\nAn empty response is unattempted, not wrong:');
{
  const graded = gradeAttempt(
    attemptOf(
      ['q1', 'q2'],
      [
        { questionId: 'q1', textAnswer: '   ' },
        { questionId: 'q2', markedForReview: true },
      ],
    ),
    bank as any,
    JEE,
  );
  ok('whitespace-only text is not a response', graded.unattemptedCount === 2);
  ok('no negative mark for a blank', graded.totalScore === 0);
  ok('marking for review alone is not an answer', graded.incorrectCount === 0);
}

console.log('\nBreakdowns are computed from the question bank:');
{
  const graded = gradeAttempt(
    attemptOf(
      ['q1', 'q2', 'q3', 'q4'],
      [
        { questionId: 'q1', chosenOptionId: 'q1-a' }, // Physics easy   correct
        { questionId: 'q2', chosenOptionId: 'q2-b' }, // Physics hard    wrong
        { questionId: 'q3', chosenOptionId: 'q3-a' }, // Chemistry med   correct
      ],
    ),
    bank as any,
    JEE,
  );
  const physics = graded.bySubject.find((s) => s.subject === 'Physics');
  const chemistry = graded.bySubject.find((s) => s.subject === 'Chemistry');
  ok('both subjects present', !!physics && !!chemistry);
  ok('physics totals every physics question', physics?.total === 2);
  ok('physics correct counted', physics?.correct === 1);
  ok('physics score nets the negative mark', physics?.score === 3);
  ok('chemistry counts the unanswered question in its total', chemistry?.total === 2);
  ok('chemistry correct counted', chemistry?.correct === 1);
  ok(
    'difficulty buckets are ordered easy → medium → hard',
    graded.byDifficulty.map((d) => d.difficulty).join(',') === 'easy,medium,hard',
  );
  ok(
    'difficulty totals cover every graded question',
    graded.byDifficulty.reduce((n, d) => n + d.total, 0) === 4,
  );
}

console.log('\nSnapshot freezes the paper:');
{
  const test: any = {
    sections: [
      {
        title: 'A',
        questionIds: ['q1', 'q2'],
        shuffleQuestions: false,
        shuffleOptions: false,
      },
      {
        title: 'B',
        questionIds: ['q3', 'q4'],
        shuffleQuestions: false,
        shuffleOptions: false,
      },
    ],
  };
  const snap = buildSnapshot(test, bank as any);
  ok('authored order preserved', snap.questionOrder.join(',') === 'q1,q2,q3,q4');
  ok(
    'no option order stored when not shuffling',
    Object.keys(snap.optionOrderByQuestion).length === 0,
  );

  const missing = buildSnapshot(
    { sections: [{ title: 'A', questionIds: ['q1', 'ghost', 'q2'] }] } as any,
    bank as any,
  );
  ok('ids with no question are dropped', missing.questionOrder.join(',') === 'q1,q2');

  const shuffled = buildSnapshot(
    {
      sections: [
        { title: 'A', questionIds: ['q1', 'q2'], shuffleQuestions: true },
        { title: 'B', questionIds: ['q3', 'q4'], shuffleQuestions: true },
      ],
    } as any,
    bank as any,
  );
  ok(
    'shuffling keeps the same question set',
    [...shuffled.questionOrder].sort().join(',') === 'q1,q2,q3,q4',
  );
  ok(
    'sections keep their authored order even when questions shuffle',
    ['q1', 'q2'].includes(String(shuffled.questionOrder[0])) &&
      ['q3', 'q4'].includes(String(shuffled.questionOrder[2])),
  );

  const opts = buildSnapshot(
    {
      sections: [{ title: 'A', questionIds: ['q1'], shuffleOptions: true }],
    } as any,
    bank as any,
  );
  ok('option order stored when shuffling options', opts.optionOrderByQuestion['q1']?.length === 2);
}

console.log('\nOption reordering never loses an option:');
{
  const question = { _id: 'q1', options: [{ _id: 'q1-a' }, { _id: 'q1-b' }] };
  const reordered = applyOptionOrder(question, { q1: ['q1-b', 'q1-a'] });
  ok('order applied', reordered.options?.map((o) => o._id).join(',') === 'q1-b,q1-a');
  ok('input not mutated', question.options[0]._id === 'q1-a');

  const partial = applyOptionOrder(
    { _id: 'q1', options: [{ _id: 'q1-a' }, { _id: 'q1-b' }, { _id: 'q1-c' }] },
    {
      q1: ['q1-b', 'q1-a'],
    },
  );
  ok(
    'an option added after the snapshot is appended, not dropped',
    partial.options?.map((o) => o._id).join(',') === 'q1-b,q1-a,q1-c',
  );

  const none = applyOptionOrder(question, {});
  ok('no stored order leaves the question untouched', none.options?.[0]._id === 'q1-a');
}

console.log('\nPublic class is normalised to digits, never an institute label:');
{
  ok('"Class 10" → "10"', normalizePublicClass('Class 10') === '10');
  ok('"10th" → "10"', normalizePublicClass('10th') === '10');
  ok('number 9 → "9"', normalizePublicClass(9) === '9');
  ok('unknown class rejected', normalizePublicClass('Class 3') === undefined);
  ok('undefined stays undefined', normalizePublicClass(undefined) === undefined);
  ok('non-numeric rejected', normalizePublicClass('Foundation') === undefined);
}

console.log('\nGuests browse; only learners attempt:');
{
  const routesOf = (router: any) =>
    router.stack
      .filter((l: any) => l.route)
      .map((l: any) => ({
        path: l.route.path,
        methods: Object.keys(l.route.methods),
        handlers: l.route.stack.map((s: any) => s.name),
      }));

  const publicRoutes = routesOf(publicTestRoutes);
  ok('public discovery exposes routes', publicRoutes.length >= 5);
  ok(
    'every public assessment route is read-only',
    publicRoutes.every((r: any) => r.methods.length === 1 && r.methods[0] === 'get'),
  );
  ok(
    'every public assessment route is guest-readable (optionalAuth, never authMiddleware)',
    publicRoutes.every(
      (r: any) =>
        r.handlers.includes('optionalAuthMiddleware') && !r.handlers.includes('authMiddleware'),
    ),
  );
  ok(
    '/tests/filters is declared before /tests/:id so it is not read as an id',
    publicRoutes.findIndex((r: any) => r.path === '/tests/filters') <
      publicRoutes.findIndex((r: any) => r.path === '/tests/:id'),
  );

  const learnerRoutes = routesOf(learnerRouter);
  const attemptRoutes = learnerRoutes.filter((r: any) => r.path.startsWith('/attempts'));
  ok('attempt lifecycle is mounted', attemptRoutes.length === 6);
  ok(
    'every attempt route requires a session',
    attemptRoutes.every((r: any) => r.handlers.includes('authMiddleware')),
  );
  ok(
    'no attempt route is guest-readable',
    attemptRoutes.every((r: any) => !r.handlers.includes('optionalAuthMiddleware')),
  );
  ok(
    'the whole learner router requires a session',
    learnerRoutes.every((r: any) => r.handlers.includes('authMiddleware')),
  );

  // Authoring is role-guarded at the ROUTER level, so a handler added later
  // inherits the guard instead of relying on someone remembering it.
  const adminGuards = (adminRouter as any).stack.filter((l: any) => !l.route);
  ok('authoring router guards every handler up front', adminGuards.length >= 2);
  ok('authoring router runs authMiddleware first', adminGuards[0]?.name === 'authMiddleware');
  const adminRoutes = routesOf(adminRouter);
  ok('authoring routes exist', adminRoutes.length >= 12);
  ok(
    'no authoring route is individually guest-readable',
    adminRoutes.every((r: any) => !r.handlers.includes('optionalAuthMiddleware')),
  );
  ok(
    '/public-tests/promote is declared before /public-tests/:id',
    adminRoutes.findIndex((r: any) => r.path === '/public-tests/promote') <
      adminRoutes.findIndex((r: any) => r.path === '/public-tests/:id'),
  );
  ok(
    'publishing is a dedicated action, not a field on the generic update',
    adminRoutes.some((r: any) => r.path === '/public-tests/:id/status' && r.methods[0] === 'post'),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE D — performance folding.
//
// These decide what a learner is TOLD about their own strengths. Every failure
// mode here is a confident lie rather than a crash: naming a "weakest subject"
// from two questions, or reporting NaN% on a scorecard.
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nBreakdowns merge across attempts:');
{
  const merged = foldBreakdowns([
    // Paper 1
    { key: 'Physics', correct: 3, total: 5 },
    { key: 'Chemistry', correct: 1, total: 5 },
    // Paper 2
    { key: 'Physics', correct: 4, total: 5 },
    { key: 'Chemistry', correct: 2, total: 5 },
    // Paper 3 — Physics only
    { key: 'Physics', correct: 5, total: 5 },
  ]);

  const physics = merged.find((r) => r.key === 'Physics');
  const chemistry = merged.find((r) => r.key === 'Chemistry');

  ok('subjects are merged, not repeated', merged.length === 2);
  ok('correct counts sum across attempts', physics?.correct === 12);
  ok('totals sum across attempts', physics?.total === 15);
  ok('accuracy is over the MERGED total, not averaged per paper', physics?.accuracy === 80);
  ok('a second subject folds independently', chemistry?.correct === 3 && chemistry?.total === 10);
  ok('ordered by volume, most-answered first', merged[0].key === 'Physics');
}

console.log('\nFolding is safe on degenerate input:');
{
  ok('no rows produces no output', foldBreakdowns([]).length === 0);
  ok(
    'a zero-total row is 0%, never NaN',
    foldBreakdowns([{ key: 'Physics', correct: 0, total: 0 }])[0].accuracy === 0,
  );
  ok('missing counts are treated as zero', foldBreakdowns([{ key: 'Physics' }])[0].total === 0);
  ok(
    'a row with no key is dropped rather than bucketed under undefined',
    foldBreakdowns([{ key: '', correct: 1, total: 1 }]).length === 0,
  );
}

console.log('\nStrongest/weakest refuses conclusions the data cannot support:');
{
  const rank = (rows: { key: string; correct: number; total: number }[]) =>
    rankSubjectPerformance(foldBreakdowns(rows));

  const one = rank([{ key: 'Physics', correct: 2, total: 10 }]);
  ok('a single subject has no strongest', one.strongest === null);
  ok('a single subject has no weakest', one.weakest === null);

  const tooFew = rank([
    { key: 'Physics', correct: 8, total: 10 },
    { key: 'Chemistry', correct: 0, total: 3 }, // below the threshold
  ]);
  ok(
    `a subject under ${MIN_QUESTIONS_FOR_SUBJECT_VERDICT} questions is not eligible`,
    tooFew.strongest === null && tooFew.weakest === null,
  );

  const real = rank([
    { key: 'Physics', correct: 9, total: 10 },
    { key: 'Chemistry', correct: 3, total: 10 },
  ]);
  ok('with enough data it names the strongest', real.strongest === 'Physics');
  ok('and the weakest', real.weakest === 'Chemistry');

  // Someone strong everywhere has no weakness worth naming.
  const allStrong = rank([
    { key: 'Physics', correct: 10, total: 10 },
    { key: 'Chemistry', correct: 9, total: 10 },
  ]);
  ok('a strong learner still has a strongest', allStrong.strongest === 'Physics');
  ok('but 90% is not called a weakness', allStrong.weakest === null);

  // The boundary: exactly at the threshold IS eligible.
  const boundary = rank([
    { key: 'Physics', correct: 5, total: MIN_QUESTIONS_FOR_SUBJECT_VERDICT },
    { key: 'Chemistry', correct: 1, total: MIN_QUESTIONS_FOR_SUBJECT_VERDICT },
  ]);
  ok('exactly at the threshold counts', boundary.strongest === 'Physics');

  // Ranking is by ACCURACY, not raw correct count — a subject with more
  // questions answered would otherwise always look strongest.
  const byRate = rank([
    { key: 'Physics', correct: 12, total: 40 }, // 30%, most answered
    { key: 'Chemistry', correct: 9, total: 10 }, // 90%
  ]);
  ok('strongest is by accuracy, not volume', byRate.strongest === 'Chemistry');
  ok('weakest is by accuracy, not volume', byRate.weakest === 'Physics');
}


// ─────────────────────────────────────────────────────────────────────────────
// Auto-gradability.
//
// This decides whether an exam can be promoted, whether a test can be
// published, and which questions the grader scores. All three used to test the
// TYPE LABEL, so a real exam with marked answers was rejected as having "no
// auto-gradable questions" because its questions happened to be typed 'short'.
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nGradability follows the ANSWER KEY, not the type label:');
{
  // The reported bug: loose type, perfectly good key.
  ok(
    "a 'short' question with a marked option IS gradable",
    isAutoGradable({ type: 'short', options: [{ text: 'A', isCorrect: true }, { text: 'B' }] }),
  );
  ok(
    "a 'long' question with a written answer IS gradable",
    isAutoGradable({ type: 'long', correctAnswerText: 'Newton' }),
  );

  // The reverse: a confident label with nothing behind it.
  ok(
    "an 'mcq' with no option marked correct is NOT gradable",
    !isAutoGradable({ type: 'mcq', options: [{ text: 'A' }, { text: 'B' }] }),
  );
  ok("an 'mcq' with no options at all is NOT gradable", !isAutoGradable({ type: 'mcq' }));
}

console.log('\nEvery real key shape is recognised:');
{
  ok('marked option', isAutoGradable({ type: 'mcq', options: [{ isCorrect: true }] }));
  ok('correctAnswerText', isAutoGradable({ type: 'fill', correctAnswerText: 'delhi' }));
  ok('integerAnswer', isAutoGradable({ type: 'integer', integerAnswer: 42 }));
  // Zero is a legitimate answer — a truthiness check would reject it.
  ok('integerAnswer of 0', isAutoGradable({ type: 'integer', integerAnswer: 0 }));
  ok(
    'assertion-reason truth flags alone',
    isAutoGradable({ type: 'assertionreason', assertionIsTrue: true, reasonIsTrue: false }),
  );
  ok(
    'assertion-reason with all flags false',
    isAutoGradable({
      type: 'assertionreason',
      assertionIsTrue: false,
      reasonIsTrue: false,
      reasonExplainsAssertion: false,
    }),
  );
}

console.log('\nAnd a genuinely keyless question is refused:');
{
  ok('no key of any kind', !isAutoGradable({ type: 'long', text: 'Discuss.' }));
  ok('whitespace-only answer text', !isAutoGradable({ type: 'fill', correctAnswerText: '   ' }));
  ok('empty answer text', !isAutoGradable({ type: 'fill', correctAnswerText: '' }));
  ok('null is handled', !isAutoGradable(null));
  ok('undefined is handled', !isAutoGradable(undefined));
}

console.log('\nThe projection must carry what the predicate reads:');
{
  // The second half of the original bug: the promotion query selected only
  // `type`, so even a well-keyed question arrived with nothing to check.
  [
    'options',
    'correctAnswerText',
    'integerAnswer',
    'assertionIsTrue',
    'reasonIsTrue',
    'reasonExplainsAssertion',
  ].forEach((field) => {
    ok(`GRADABILITY_FIELDS includes ${field}`, GRADABILITY_FIELDS.includes(field));
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// Question source resolution.
//
// Questions are NOT in one global bank — they live in per-class collections
// (`class_11`, …). The public flow assumed a single `Question` collection, so a
// valid 75-question exam reported all 75 as missing. These pin the rule to the
// one the institute exam flow already uses.
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nQuestions resolve to the per-class collection:');
{
  const nameFor = (c?: string | null) => resolveQuestionModel(c).collection.name;

  ok('a bare class number picks class_11', nameFor('11') === 'class_11');
  ok('"Class 11" normalises the same way', nameFor('Class 11') === 'class_11');
  ok('"class_11" is idempotent', nameFor('class_11') === 'class_11');
  ok('a different class is a different collection', nameFor('12') === 'class_12');
  ok(
    'class 11 and class 12 never share a collection',
    nameFor('11') !== nameFor('12'),
  );

  // The fallback, and ONLY the fallback, is the shared bank.
  ok('no class falls back to the shared collection', nameFor(undefined) !== 'class_11');
  ok('empty string falls back too', nameFor('') === nameFor(undefined));
  ok('whitespace falls back too', nameFor('   ') === nameFor(undefined));

  // The bug this exists to prevent: reading the shared bank for a class paper.
  ok(
    'a class paper does NOT resolve to the shared bank',
    nameFor('11') !== nameFor(undefined),
  );
}

console.log('\nformatClassCollection is the shared normaliser:');
{
  ok('digits are extracted', formatClassCollection('Class 11') === 'class_11');
  ok('case is ignored', formatClassCollection('CLASS 11') === 'class_11');
  ok('single digit works', formatClassCollection('7') === 'class_7');
}

console.log('\nA test records which bank its ids came from:');
{
  // Deriving the bank from `classLevel` would be wrong: that field is a
  // discovery tag an author can edit or clear, and changing it would repoint a
  // paper at a collection its ids do not exist in.
  ok('PublicTest has a questionBank field', !!PublicTest.schema.path('questionBank'));
  ok(
    'questionBank is separate from classLevel',
    !!PublicTest.schema.path('classLevel') && !!PublicTest.schema.path('questionBank'),
  );
}


console.log('\nA paper runs one subject at a time:');
{
  // A promoted paper mixes subjects in one section. Interleaving them put
  // Physics at positions 3, 4, 6, 7… — the true order, but a paper nobody
  // would set and a palette nobody can navigate.
  const mixed: any[] = [
    { _id: 'p1', tags: { subject: 'Physics' } },
    { _id: 'c1', tags: { subject: 'Chemistry' } },
    { _id: 'p2', tags: { subject: 'Physics' } },
    { _id: 'm1', tags: { subject: 'Maths' } },
    { _id: 'c2', tags: { subject: 'Chemistry' } },
    { _id: 'p3', tags: { subject: 'Physics' } },
  ];
  const test: any = {
    sections: [{ title: 'A', questionIds: ['p1', 'c1', 'p2', 'm1', 'c2', 'p3'] }],
  };

  const order = buildSnapshot(test, mixed).questionOrder.map(String);
  ok('every question is kept', order.length === 6);
  ok('Physics runs first and contiguously', order.slice(0, 3).join(',') === 'p1,p2,p3');
  ok('then Chemistry, contiguously', order.slice(3, 5).join(',') === 'c1,c2');
  ok('then Maths', order[5] === 'm1');

  // Subjects appear in the order they first occur, so a deliberate authored
  // order survives.
  const reordered: any = {
    sections: [{ title: 'A', questionIds: ['m1', 'p1', 'c1'] }],
  };
  const order2 = buildSnapshot(reordered, mixed).questionOrder.map(String);
  ok('first-appearance decides subject order', order2.join(',') === 'm1,p1,c1');
}

console.log('\nShuffling stays INSIDE a subject:');
{
  const qs: any[] = Array.from({ length: 6 }, (_, i) => ({
    _id: `q${i}`,
    tags: { subject: i < 3 ? 'Physics' : 'Chemistry' },
  }));
  const test: any = {
    sections: [
      { title: 'A', questionIds: qs.map((q) => q._id), shuffleQuestions: true },
    ],
  };

  // Run it several times: the BLOCKS must never interleave, however the
  // questions inside them land.
  let blocksIntact = true;
  for (let run = 0; run < 25; run++) {
    const order = buildSnapshot(test, qs).questionOrder.map(String);
    const firstHalf = order.slice(0, 3);
    const secondHalf = order.slice(3);
    if (!firstHalf.every((id) => ['q0', 'q1', 'q2'].includes(id))) blocksIntact = false;
    if (!secondHalf.every((id) => ['q3', 'q4', 'q5'].includes(id))) blocksIntact = false;
  }
  ok('a shuffled paper never interleaves subjects', blocksIntact);
}

console.log('\nQuestions with no subject still work:');
{
  const qs: any[] = [{ _id: 'a' }, { _id: 'b', tags: { subject: 'Physics' } }, { _id: 'c' }];
  const test: any = { sections: [{ title: 'A', questionIds: ['a', 'b', 'c'] }] };
  const order = buildSnapshot(test, qs).questionOrder.map(String);
  ok('none are dropped', order.length === 3);
  ok('untagged ones group together as General', order.join(',') === 'a,c,b');
}

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S) — public assessment safety is NOT established.`);
  process.exit(1);
}
console.log('Public assessment safety verified.');
