/**
 * AGTS pure-logic checks — scoring, analytics and input validation.
 * No database, no network: `npm run safety:agts-logic`.
 */

import { scorePaper, gradeResponse, normalizeTextAnswer, type QuestionKey } from '../../src/services/assessment/assessmentScoring';
import { analyzeAttempt, bandFor } from '../../src/services/assessment/assessmentAnalytics';
import {
  AgtsValidationError,
  cleanLandingPage,
  cleanReferrer,
  normalizeIndianMobile,
  parseAnswer,
  parseAnswerBatch,
  parseFollowUp,
  parseLeadListQuery,
  parseLeadStatus,
  validateGuidance,
  validateRegistration,
} from '../../src/services/agts/agtsValidation';
import { Checks } from './e2eHarness';

const t = new Checks();

const oid = (n: number) => n.toString(16).padStart(24, '0');
const mcq = (n: number, subject: string, topic = '', difficulty = 'medium'): QuestionKey => ({
  id: oid(n),
  type: 'mcq',
  marks: 1,
  subject,
  topic,
  difficulty,
  options: [
    { id: oid(1000 + n * 4), isCorrect: true },
    { id: oid(1001 + n * 4), isCorrect: false },
    { id: oid(1002 + n * 4), isCorrect: false },
    { id: oid(1003 + n * 4), isCorrect: false },
  ],
});
const right = (q: QuestionKey) => ({ questionId: q.id, chosenOptionId: q.options![0].id });
const wrong = (q: QuestionKey) => ({ questionId: q.id, chosenOptionId: q.options![1].id });

// ── Scoring ─────────────────────────────────────────────────────────────────
t.section('scoring: the paper, not the answers, sets the maximum');
{
  const paper = Array.from({ length: 30 }, (_, i) => mcq(i + 1, i < 15 ? 'Mathematics' : 'Science'));
  const oneRight = scorePaper(paper, [right(paper[0])]);
  t.check('1 correct + 29 skipped is 1/30, not 100% (old grader bug)', oneRight.score === 1 && oneRight.maxScore === 30);
  t.check('percentage is 3.33', oneRight.percentage === 3.33, String(oneRight.percentage));
  t.check('accuracy is 100 over attempted questions', oneRight.accuracy === 100);
  t.check('skipped counted', oneRight.skipped === 29 && oneRight.attempted === 1);

  const mixed = scorePaper(paper, [...paper.slice(0, 20).map(right), ...paper.slice(20, 25).map(wrong)]);
  t.check('20 right, 5 wrong, 5 skipped', mixed.correct === 20 && mixed.incorrect === 5 && mixed.skipped === 5);
  t.check('percentage 66.67', mixed.percentage === 66.67, String(mixed.percentage));
  t.check('accuracy 80', mixed.accuracy === 80, String(mixed.accuracy));
}

t.section('scoring: tampering and junk input');
{
  const paper = [mcq(1, 'Mathematics'), mcq(2, 'Mathematics')];
  const forged = scorePaper(paper, [
    { questionId: paper[0].id, chosenOptionId: paper[0].options![1].id, ...( { isCorrect: true, marks: 99, score: 100 } as any) },
    { questionId: oid(999), chosenOptionId: oid(1), ...( { marks: 50 } as any) },
  ]);
  t.check('client isCorrect/marks on a wrong answer are ignored', forged.score === 0 && forged.incorrect === 1);
  t.check('answers to questions not on the paper are ignored', forged.totalQuestions === 2 && forged.maxScore === 2);
  const unknownOption = gradeResponse(paper[0], { questionId: paper[0].id, chosenOptionId: oid(424242) });
  t.check('an option that is not on the question is simply wrong', unknownOption.outcome === 'incorrect' && unknownOption.awarded === 0);
  const dup = scorePaper(paper, [wrong(paper[0]), right(paper[0])]);
  t.check('duplicate entries: the last one for a question wins, counted once', dup.correct === 1 && dup.totalQuestions === 2);
  const empty = scorePaper(paper, [{ questionId: paper[0].id, chosenOptionId: '   ' }]);
  t.check('a blank answer is skipped, not wrong', empty.skipped === 2 && empty.incorrect === 0);
  t.check('empty paper scores 0% without dividing by zero', scorePaper([], []).percentage === 0);
}

t.section('scoring: other question kinds');
{
  const integer: QuestionKey = { id: oid(50), type: 'integer', integerAnswer: 12, marks: 2, subject: 'Mathematics' };
  t.check('integer exact match', gradeResponse(integer, { questionId: integer.id, textAnswer: '12' }).awarded === 2);
  t.check('integer mismatch', gradeResponse(integer, { questionId: integer.id, textAnswer: '12.5' }).outcome === 'incorrect');
  const fill: QuestionKey = { id: oid(51), type: 'fill', correctAnswerText: 'Photosynthesis.', subject: 'Science' };
  t.check('fill-in: case, space and trailing full stop insensitive', gradeResponse(fill, { questionId: fill.id, textAnswer: '  photosynthesis ' }).outcome === 'correct');
  t.check('normalizeTextAnswer', normalizeTextAnswer(' A  B. ') === 'a b');
  const essay: QuestionKey = { id: oid(52), type: 'long', subject: 'English' };
  const unreviewed = scorePaper([essay, mcq(53, 'English')], [{ questionId: essay.id, textAnswer: 'An answer' }, right(mcq(53, 'English'))]);
  t.check('an unreviewed essay is ungraded and outside the maximum', unreviewed.ungraded === 1 && unreviewed.maxScore === 1 && unreviewed.percentage === 100);
  const reviewed = scorePaper([essay], [{ questionId: essay.id, textAnswer: 'x', manualMarks: 5 }]);
  t.check('reviewer marks are clamped to the question maximum', reviewed.score === 1 && reviewed.maxScore === 1);
  const tf: QuestionKey = { id: oid(54), type: 'truefalse', subject: 'Science', options: [{ id: oid(60), isCorrect: false }, { id: oid(61), isCorrect: true }] };
  t.check('true/false stored as options is option-graded', gradeResponse(tf, { questionId: tf.id, chosenOptionId: oid(61) }).outcome === 'correct');
}

// ── Analytics ───────────────────────────────────────────────────────────────
t.section('analytics: breakdowns, strengths, weak areas, recommendations');
{
  const paper = [
    ...Array.from({ length: 6 }, (_, i) => mcq(100 + i, 'Mathematics', i < 3 ? 'Algebra' : 'Geometry', i % 2 ? 'hard' : 'easy')),
    ...Array.from({ length: 6 }, (_, i) => mcq(200 + i, 'Science', i < 3 ? 'Light' : 'Electricity', 'medium')),
  ];
  // Algebra 3/3, Geometry 0/3 (2 wrong 1 skipped), Light 3/3, Electricity 1/3.
  const responses = [
    ...paper.slice(0, 3).map(right),
    wrong(paper[3]), wrong(paper[4]),
    ...paper.slice(6, 9).map(right),
    right(paper[9]), wrong(paper[10]), wrong(paper[11]),
  ];
  const summary = scorePaper(paper, responses);
  const started = new Date('2026-09-28T10:00:00Z');
  const report = analyzeAttempt(summary, { startedAt: started, submittedAt: new Date(started.getTime() + 20 * 60000), durationMins: 60 });

  t.check('two subjects', report.subjects.length === 2 && report.subjects.map((s) => s.label).join() === 'Mathematics,Science');
  const maths = report.subjects.find((s) => s.label === 'Mathematics')!;
  t.check('Mathematics 3/6 = 50%', maths.correct === 3 && maths.percentage === 50, JSON.stringify(maths));
  t.check('topics available and four of them', report.topicsAvailable && report.topics.length === 4);
  t.check('weakest topic first (Geometry 0%)', report.topics[0].label === 'Geometry' && report.topics[0].percentage === 0);
  t.check('Algebra and Light are strengths', ['Algebra', 'Light'].every((a) => report.strengths.some((s) => s.area === a)));
  t.check('Geometry and Electricity are weak areas', ['Geometry', 'Electricity'].every((a) => report.weakAreas.some((w) => w.area === a)));
  t.check('the first recommendation targets the weakest topic', /Geometry/.test(report.recommendations[0]?.title || ''), report.recommendations[0]?.title);
  t.check('at most five recommendations', report.recommendations.length > 0 && report.recommendations.length <= 5);
  t.check('time taken 1200s, utilisation 33.33%', report.time.timeTakenSec === 1200 && report.time.utilisation === 33.33);
  t.check('difficulty ordered easy → medium → hard', report.difficulty.map((d) => d.key).join() === 'easy,medium,hard');
  t.check('question map mirrors the paper order', report.questionMap.length === 12 && report.questionMap[5].outcome === 'skipped');

  const late = analyzeAttempt(summary, { startedAt: started, submittedAt: new Date(started.getTime() + 5 * 3600000), durationMins: 60 });
  t.check('time taken is capped at the allotted time', late.time.timeTakenSec === 3600);
  t.check('bands', bandFor(85).key === 'excellent' && bandFor(65).key === 'strong' && bandFor(45).key === 'developing' && bandFor(10).key === 'foundation');

  const tiny = analyzeAttempt(scorePaper([mcq(300, 'English', 'Grammar')], [wrong(mcq(300, 'English', 'Grammar'))]));
  t.check('a single question is never labelled a weak area (minimum sample)', tiny.weakAreas.length === 0);
  const perfect = analyzeAttempt(scorePaper(paper, paper.map(right)));
  t.check('a perfect paper gets a stretch recommendation, no weak areas', perfect.weakAreas.length === 0 && /stretch/i.test(perfect.recommendations[0].title));
}

// ── Validation ──────────────────────────────────────────────────────────────
t.section('validation: registration');
const good = {
  studentName: 'Aarav Shah',
  classLevel: 9,
  guardianName: "Priya D'Souza",
  phone: '+91 98765-43210',
  consent: true,
};
{
  const v = validateRegistration({ ...good, email: 'Parent@Example.com', school: 'DPS', board: 'cbse' });
  t.check('valid registration normalizes phone to 10 digits', v.phoneNormalized === '9876543210');
  t.check('email lower-cased, board canonicalised', v.email === 'parent@example.com' && v.board === 'CBSE');

  const injected = validateRegistration({
    ...good,
    status: 'enrolled',
    score: 100,
    percentage: 100,
    orgId: 'evil-org',
    leadOwner: 'attacker',
    __proto__: { polluted: true },
    constructor: 'x',
  } as any);
  const keys = Object.keys(injected).sort().join(',');
  t.check('unknown fields never survive validation', !/status|score|percentage|orgId|leadOwner|polluted|constructor/.test(keys), keys);

  const errorsOf = (body: unknown) => {
    try {
      validateRegistration(body);
      return {};
    } catch (e) {
      return e instanceof AgtsValidationError ? e.errors : { thrown: String(e) };
    }
  };
  t.check('missing required fields are all reported', ['studentName', 'classLevel', 'guardianName', 'phone', 'consent'].every((f) => f in errorsOf({})));
  t.check('consent must be the boolean true', 'consent' in errorsOf({ ...good, consent: 'true' }));
  t.check('class outside 7–12 refused', 'classLevel' in errorsOf({ ...good, classLevel: 13 }));
  t.check('name with markup refused', 'studentName' in errorsOf({ ...good, studentName: '<script>alert(1)</script>' }));
  t.check('bad email refused', 'email' in errorsOf({ ...good, email: 'not-an-email' }));
  t.check('unknown board refused', 'board' in errorsOf({ ...good, board: 'Hogwarts' }));
  t.check('malformed test link refused', 'testRef' in errorsOf({ ...good, testRef: '../../etc' }));
  t.check('overlong school name is capped', validateRegistration({ ...good, school: 'x'.repeat(500) }).school.length === 120);
}

t.section('validation: phone numbers');
t.check('10 digits', normalizeIndianMobile('9876543210') === '9876543210');
t.check('+91 prefix', normalizeIndianMobile('+919876543210') === '9876543210');
t.check('leading 0', normalizeIndianMobile('09876543210') === '9876543210');
t.check('spaces, dashes, brackets', normalizeIndianMobile('(98765) 432-10') === '9876543210');
t.check('landline-style 5… refused', normalizeIndianMobile('5876543210') === '');
t.check('too short refused', normalizeIndianMobile('98765') === '');
t.check('letters refused', normalizeIndianMobile('98765abc10') === '');

t.section('validation: attribution keeps no personal data');
{
  const v = validateRegistration({
    ...good,
    attribution: {
      utm_source: 'instagram',
      utm_medium: 'social',
      utm_campaign: 'agts_oct',
      utm_content: 'reel<script>',
      landingPage: 'https://abhigyangurukul.com/agts?phone=9876543210&utm_source=instagram#x',
      referrer: 'https://www.google.com/search?q=my+name+and+phone',
    },
  });
  t.check('utm fields kept', v.attribution?.source === 'instagram' && v.attribution?.campaign === 'agts_oct');
  t.check('a utm value with markup is dropped', v.attribution?.content === '');
  t.check('landing page keeps the path only (no query)', v.attribution?.landingPage === '/agts', v.attribution?.landingPage);
  t.check('referrer keeps the host only', v.attribution?.referrer === 'www.google.com', v.attribution?.referrer);
  t.check('cleanLandingPage on junk', cleanLandingPage('javascript:alert(1)') === '/alert1' || cleanLandingPage('javascript:alert(1)').startsWith('/'));
  t.check('cleanReferrer on non-URL', cleanReferrer('not a url') === '');
}

t.section('validation: answers');
{
  const q = oid(7);
  t.check('option id string becomes chosenOptionId', parseAnswer(q, oid(8)).chosenOptionId === oid(8));
  t.check('text answer', parseAnswer(q, '42').textAnswer === '42');
  t.check('null clears the response', parseAnswer(q, null).chosenOptionId === '' && parseAnswer(q, null).textAnswer === '');
  const forged = parseAnswer(q, { chosenOptionId: oid(8), isCorrect: true, marks: 10 } as any) as any;
  t.check('isCorrect/marks in an answer object are dropped', !('isCorrect' in forged) && !('marks' in forged));
  let threw = false;
  try {
    parseAnswer('not-an-id', oid(8));
  } catch {
    threw = true;
  }
  t.check('question id must be an ObjectId', threw);
  t.check('batch caps at 200 entries', parseAnswerBatch(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [oid(i + 1), oid(9)]))).length === 200);
  t.check('batch drops malformed entries', parseAnswerBatch([{ questionId: 'x' }, { questionId: oid(3), chosenOptionId: oid(4) }]).length === 1);
}

t.section('validation: admin inputs');
{
  t.check('status allow-list', parseLeadStatus('Counselling') === 'counselling');
  let bad = false;
  try {
    parseLeadStatus('admitted-by-bot');
  } catch {
    bad = true;
  }
  t.check('unknown status refused', bad);
  t.check('follow-up null clears', parseFollowUp(null) === null);
  let far = false;
  try {
    parseFollowUp('2099-01-01');
  } catch {
    far = true;
  }
  t.check('follow-up decades away refused', far);
  const q = parseLeadListQuery({ limit: '5000', page: '-3', status: 'nope', search: 'a'.repeat(300), sort: 'score' });
  t.check('list query clamps limit/page, drops bad status, caps search', q.limit === 100 && q.page === 1 && !q.status && (q.search || '').length === 60 && q.sort === 'score');
  t.check('guidance time allow-list', validateGuidance({ preferredTime: 'Any time' }).preferredTime === 'Any time');
  let gbad = false;
  try {
    validateGuidance({ preferredTime: 'midnight' });
  } catch {
    gbad = true;
  }
  t.check('guidance time outside the list refused', gbad);
}

t.report();
