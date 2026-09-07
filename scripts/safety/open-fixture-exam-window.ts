/**
 * Reopen a fixture exam's schedule so the attempt player can be driven.
 *
 * ── Why this is needed at all ───────────────────────────────────────────────
 * `seed-p6-fixture.ts` writes an exam window relative to the day it runs, so a
 * fixture seeded a week ago has an exam that ENDED a week ago. The client is
 * then correct to disable "Resume attempt" — the exam is closed — and the
 * attempt player, the countdown and answer submission become undrivable.
 * Validating them therefore needs a live window, and inventing one in the
 * client would validate nothing.
 *
 * This moves the window, and only the window: the exam, its questions, its
 * sections, its marking scheme and any existing attempt are untouched, so the
 * thing being tested is the real seeded exam rather than a new one.
 *
 * ── Where this runs, and where it must not ──────────────────────────────────
 * The same rule as every script in this directory: the target database name
 * must differ from production and must identify itself as a scratch fixture.
 * It refuses rather than warns.
 *
 *   P6_MONGO_URI=<scratch> \
 *     node -r ./scripts/safety/dns-preload.js -r ts-node/register/transpile-only \
 *          scripts/safety/open-fixture-exam-window.ts [--hours 6]
 */

import 'dotenv/config';
import mongoose from 'mongoose';
// Before the model import — see core/tenancy/bootstrap. Without it the schema
// has no `orgId` path and this script would strip ownership from any document
// it saved.
import { registerTenancy } from '../../src/core/tenancy/bootstrap';

registerTenancy();

const uri = process.env.P6_MONGO_URI || '';

function dbNameOf(connectionString: string): string {
  const match = connectionString.match(/\/([^/?]+)(\?|$)/);
  return match ? match[1] : '';
}

function argNumber(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) ? value : fallback;
}

async function main(): Promise<void> {
  if (!uri) {
    console.error('P6_MONGO_URI is required.');
    process.exit(2);
  }
  const target = dbNameOf(uri);
  const production = dbNameOf(process.env.MONGO_URI || '');
  if (!target || (production && target === production)) {
    console.error(`Refusing to modify "${target}".`);
    process.exit(2);
  }
  if (!/scratch|fixture|test/i.test(target)) {
    console.error(`Refusing to modify "${target}": it does not identify itself as a scratch fixture.`);
    process.exit(2);
  }

  const hours = argNumber('hours', 6);
  await mongoose.connect(uri);

  const { default: Exam } = await import('../../src/models/Exam');

  // Opened slightly in the past so the exam is LIVE rather than scheduled —
  // a client that correctly refuses to start a future exam would otherwise
  // look like a client that cannot start one at all.
  const startAt = new Date(Date.now() - 5 * 60_000);
  const endAt = new Date(Date.now() + hours * 60 * 60_000);

  const exams = await Exam.find({}).select('_id title schedule orgId').lean();
  console.log(`\n[window] ${exams.length} exams in ${target}`);

  for (const exam of exams as any[]) {
    const previous = exam.schedule?.endAt ? new Date(exam.schedule.endAt).toISOString() : 'none';
    await Exam.updateOne(
      { _id: exam._id },
      { $set: { 'schedule.startAt': startAt, 'schedule.endAt': endAt } },
    );
    console.log(`  ${exam.title}  ${previous} -> ${endAt.toISOString()}`);
  }

  console.log(`\n[window] open until ${endAt.toISOString()} (${hours}h)`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
