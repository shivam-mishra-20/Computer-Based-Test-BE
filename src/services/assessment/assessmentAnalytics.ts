/**
 * Assessment analytics — pure, deterministic, no database.
 *
 * Turns a scored paper (assessmentScoring.scorePaper) into the academic report
 * a family reads: where the marks came from, where they were lost, and what to
 * do next. Every statement it makes is derived from the candidate's own
 * outcomes; nothing is templated independently of the numbers.
 *
 * ── Why minimum sample sizes ────────────────────────────────────────────────
 * One wrong answer in a topic that appeared once is noise, not a weak area.
 * A subject needs MIN_SUBJECT_SAMPLE gradable questions and a topic
 * MIN_TOPIC_SAMPLE before it may be called a strength or a weakness.
 */

import { round2, type QuestionResult, type ScoreSummary } from './assessmentScoring';

export const ANALYTICS_VERSION = 1;
export const MIN_SUBJECT_SAMPLE = 3;
export const MIN_TOPIC_SAMPLE = 2;
export const STRENGTH_THRESHOLD = 75;
export const WEAKNESS_THRESHOLD = 50;

export interface Breakdown {
  key: string;
  label: string;
  subject?: string;
  total: number;
  attempted: number;
  correct: number;
  incorrect: number;
  skipped: number;
  score: number;
  maxScore: number;
  percentage: number;
  accuracy: number;
}

export interface Band {
  key: 'excellent' | 'strong' | 'developing' | 'foundation';
  label: string;
  description: string;
}

export interface Insight {
  kind: 'subject' | 'topic';
  area: string;
  subject?: string;
  percentage: number;
  detail: string;
}

export interface Recommendation {
  title: string;
  detail: string;
  area?: string;
}

export interface TimingInput {
  startedAt?: Date | string | null;
  submittedAt?: Date | string | null;
  durationMins?: number | null;
}

export interface AnalysisReport {
  version: number;
  overall: {
    score: number;
    maxScore: number;
    percentage: number;
    accuracy: number;
    totalQuestions: number;
    attempted: number;
    correct: number;
    incorrect: number;
    skipped: number;
    ungraded: number;
    attemptRate: number;
  };
  band: Band;
  time: {
    timeTakenSec: number;
    allottedSec: number;
    utilisation: number;
    avgSecPerAttempted: number;
  };
  subjects: Breakdown[];
  topics: Breakdown[];
  topicsAvailable: boolean;
  difficulty: Breakdown[];
  strengths: Insight[];
  weakAreas: Insight[];
  recommendations: Recommendation[];
  questionMap: Array<{ index: number; subject: string; outcome: QuestionResult['outcome']; markedForReview: boolean }>;
}

export function bandFor(percentage: number): Band {
  if (percentage >= 80) {
    return { key: 'excellent', label: 'Excellent', description: 'A strong command of the tested concepts.' };
  }
  if (percentage >= 60) {
    return { key: 'strong', label: 'Strong', description: 'A solid base with a few areas to tighten.' };
  }
  if (percentage >= 40) {
    return { key: 'developing', label: 'Developing', description: 'The fundamentals are forming; targeted practice will lift the score.' };
  }
  return { key: 'foundation', label: 'Building foundations', description: 'Revisiting core concepts first will make the biggest difference.' };
}

function aggregate(items: QuestionResult[], key: string, label: string, subject?: string): Breakdown {
  const gradable = items.filter((q) => q.gradable);
  const correct = items.filter((q) => q.outcome === 'correct').length;
  const incorrect = items.filter((q) => q.outcome === 'incorrect').length;
  const score = items.reduce((sum, q) => sum + q.awarded, 0);
  const maxScore = gradable.reduce((sum, q) => sum + q.max, 0);
  return {
    key,
    label,
    ...(subject ? { subject } : {}),
    total: items.length,
    attempted: items.filter((q) => q.attempted).length,
    correct,
    incorrect,
    skipped: items.filter((q) => q.outcome === 'skipped').length,
    score: round2(Math.max(0, score)),
    maxScore: round2(maxScore),
    percentage: maxScore > 0 ? round2((Math.max(0, score) / maxScore) * 100) : 0,
    accuracy: correct + incorrect > 0 ? round2((correct / (correct + incorrect)) * 100) : 0,
  };
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    const list = groups.get(key) || [];
    list.push(item);
    groups.set(key, list);
  }
  return groups;
}

const toDate = (value: Date | string | null | undefined): Date | null => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function timingFor(input: TimingInput, attempted: number): AnalysisReport['time'] {
  const allottedSec = Math.max(0, Math.round((Number(input.durationMins) || 0) * 60));
  const started = toDate(input.startedAt);
  const submitted = toDate(input.submittedAt);
  let timeTakenSec = started && submitted ? Math.round((submitted.getTime() - started.getTime()) / 1000) : 0;
  timeTakenSec = Math.max(0, allottedSec > 0 ? Math.min(timeTakenSec, allottedSec) : timeTakenSec);
  return {
    timeTakenSec,
    allottedSec,
    utilisation: allottedSec > 0 ? round2((timeTakenSec / allottedSec) * 100) : 0,
    avgSecPerAttempted: attempted > 0 ? Math.round(timeTakenSec / attempted) : 0,
  };
}

const DIFFICULTY_ORDER = ['easy', 'medium', 'hard'];

export function analyzeAttempt(summary: ScoreSummary, timing: TimingInput = {}): AnalysisReport {
  const perQuestion = summary.perQuestion || [];

  const subjects = [...groupBy(perQuestion, (q) => q.subject || 'General')]
    .map(([subject, items]) => aggregate(items, subject, subject))
    .sort((a, b) => a.label.localeCompare(b.label));

  // A topic is the most specific label the bank carries: topic, else chapter.
  const topicLabel = (q: QuestionResult) => (q.topic || q.chapter || '').trim();
  const topicsAvailable = perQuestion.some((q) => topicLabel(q));
  const topics = [...groupBy(perQuestion, (q) => (topicLabel(q) ? `${q.subject}::${topicLabel(q)}` : ''))]
    .map(([key, items]) => aggregate(items, key, topicLabel(items[0]), items[0].subject))
    .sort((a, b) => a.percentage - b.percentage || b.total - a.total || a.label.localeCompare(b.label));

  const difficulty = [...groupBy(perQuestion, (q) => (q.difficulty || '').toLowerCase())]
    .map(([level, items]) => aggregate(items, level, level.charAt(0).toUpperCase() + level.slice(1)))
    .sort((a, b) => DIFFICULTY_ORDER.indexOf(a.key) - DIFFICULTY_ORDER.indexOf(b.key));

  const gradableTotal = (b: Breakdown) => b.correct + b.incorrect + b.skipped;

  const subjectInsights = subjects.filter((s) => gradableTotal(s) >= MIN_SUBJECT_SAMPLE);
  const topicInsights = topics.filter((t) => gradableTotal(t) >= MIN_TOPIC_SAMPLE);

  const describe = (b: Breakdown) =>
    `${b.correct} of ${gradableTotal(b)} correct${b.skipped ? `, ${b.skipped} not attempted` : ''}`;

  const strengths: Insight[] = [
    ...subjectInsights
      .filter((s) => s.percentage >= STRENGTH_THRESHOLD)
      .map((s) => ({ kind: 'subject' as const, area: s.label, percentage: s.percentage, detail: describe(s) })),
    ...topicInsights
      .filter((t) => t.percentage >= STRENGTH_THRESHOLD)
      .map((t) => ({ kind: 'topic' as const, area: t.label, subject: t.subject, percentage: t.percentage, detail: describe(t) })),
  ].sort((a, b) => b.percentage - a.percentage);

  const weakAreas: Insight[] = [
    ...subjectInsights
      .filter((s) => s.percentage < WEAKNESS_THRESHOLD)
      .map((s) => ({ kind: 'subject' as const, area: s.label, percentage: s.percentage, detail: describe(s) })),
    ...topicInsights
      .filter((t) => t.percentage < WEAKNESS_THRESHOLD)
      .map((t) => ({ kind: 'topic' as const, area: t.label, subject: t.subject, percentage: t.percentage, detail: describe(t) })),
  ].sort((a, b) => a.percentage - b.percentage);

  const time = timingFor(timing, summary.attempted);
  const gradableCount = summary.correct + summary.incorrect + summary.skipped;
  const attemptRate = gradableCount > 0 ? round2(((summary.correct + summary.incorrect) / gradableCount) * 100) : 0;

  const recommendations = buildRecommendations({ summary, weakAreas, strengths, subjects, time, attemptRate });

  return {
    version: ANALYTICS_VERSION,
    overall: {
      score: summary.score,
      maxScore: summary.maxScore,
      percentage: summary.percentage,
      accuracy: summary.accuracy,
      totalQuestions: summary.totalQuestions,
      attempted: summary.attempted,
      correct: summary.correct,
      incorrect: summary.incorrect,
      skipped: summary.skipped,
      ungraded: summary.ungraded,
      attemptRate,
    },
    band: bandFor(summary.percentage),
    time,
    subjects,
    topics,
    topicsAvailable,
    difficulty,
    strengths,
    weakAreas,
    recommendations,
    questionMap: perQuestion.map((q) => ({
      index: q.index,
      subject: q.subject,
      outcome: q.outcome,
      markedForReview: q.markedForReview,
    })),
  };
}

const MAX_RECOMMENDATIONS = 5;

function buildRecommendations(input: {
  summary: ScoreSummary;
  weakAreas: Insight[];
  strengths: Insight[];
  subjects: Breakdown[];
  time: AnalysisReport['time'];
  attemptRate: number;
}): Recommendation[] {
  const { summary, weakAreas, strengths, subjects, time, attemptRate } = input;
  const out: Recommendation[] = [];
  const noNegativeMarking = true; // AGTS papers carry no negative marking.

  // 1. The weakest specific areas first — a topic is more actionable than a subject.
  const weakTopics = weakAreas.filter((w) => w.kind === 'topic').slice(0, 2);
  for (const w of weakTopics) {
    out.push({
      title: `Revise ${w.area}${w.subject ? ` (${w.subject})` : ''}`,
      detail: `You scored ${w.percentage}% here (${w.detail}). Rework the core concepts, then practise a short set of questions on this topic before moving on.`,
      area: w.area,
    });
  }
  const weakSubjects = weakAreas.filter((w) => w.kind === 'subject' && !weakTopics.some((t) => t.subject === w.area));
  for (const w of weakSubjects.slice(0, 2)) {
    out.push({
      title: `Strengthen ${w.area} fundamentals`,
      detail: `${w.area} came in at ${w.percentage}% (${w.detail}). A structured revision of the previous class's ${w.area} syllabus is the quickest way to lift this.`,
      area: w.area,
    });
  }

  // 2. Unattempted questions.
  const gradable = summary.correct + summary.incorrect + summary.skipped;
  if (gradable > 0 && summary.skipped / gradable >= 0.25) {
    out.push({
      title: 'Attempt more of the paper',
      detail: `${summary.skipped} of ${gradable} questions were left unanswered.${
        noNegativeMarking ? ' There is no negative marking, so an attempted question can only add to your score.' : ''
      }`,
    });
  }

  // 3. Accuracy versus coverage.
  if (summary.correct + summary.incorrect >= 5) {
    if (summary.accuracy < 60 && attemptRate >= 70) {
      out.push({
        title: 'Slow down and verify',
        detail: `Your accuracy was ${summary.accuracy}% on the questions you attempted. Re-read each question and eliminate options before committing to an answer.`,
      });
    } else if (summary.accuracy >= 80 && attemptRate < 70) {
      out.push({
        title: 'Build speed',
        detail: `You were accurate (${summary.accuracy}%) but attempted ${attemptRate}% of the paper. Timed practice will help you reach more questions.`,
      });
    }
  }

  // 4. Time.
  if (time.allottedSec > 0 && time.utilisation < 50 && summary.percentage < 60) {
    out.push({
      title: 'Use the full time',
      detail: `You finished in ${Math.round(time.timeTakenSec / 60)} of ${Math.round(time.allottedSec / 60)} minutes. Spending the remaining time reviewing answers usually recovers marks.`,
    });
  }

  // 5. Stretch goal when there is nothing to fix.
  if (out.length === 0) {
    const best = strengths.find((s) => s.kind === 'subject') || [...subjects].sort((a, b) => b.percentage - a.percentage)[0];
    const area = best ? ('area' in best ? best.area : best.label) : '';
    out.push({
      title: 'Keep stretching',
      detail: area
        ? `A strong result. Challenge yourself with higher-order problems in ${area} to keep improving.`
        : 'A strong result. Challenge yourself with higher-order problems to keep improving.',
      ...(area ? { area } : {}),
    });
  }

  return out.slice(0, MAX_RECOMMENDATIONS);
}
