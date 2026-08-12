/**
 * Why is an exam refusing to promote?
 *
 * Read-only. Resolves an exam's questions exactly as promoteExamToPublicTest
 * does and reports what it finds, so the answer comes from the data rather than
 * from reasoning about the data.
 *
 * Run:  npx ts-node scripts/diagnose-promotion.ts [examId]
 *       (no id = the 10 most recent exams, summarised)
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db';
import Exam from '../src/models/Exam';
import { findQuestionsByIds, resolveQuestionModel } from '../src/utils/questionSource';
import { GRADABILITY_FIELDS, cloneSections, isAutoGradable } from '../src/utils/publicAssessment';

dotenv.config();

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');

  await mongoose.connect(uri);
  console.log('connected\n');

  const examId = process.argv[2];
  const exams = examId
    ? await Exam.find({ _id: examId }).lean()
    : await Exam.find({}).sort({ createdAt: -1 }).limit(10).lean();

  if (exams.length === 0) {
    console.log('No exams found.');
    return;
  }

  for (const exam of exams as any[]) {
    const sections = cloneSections(exam.sections);
    const questionIds = sections.flatMap((s: any) => s.questionIds || []);

    console.log('─'.repeat(78));
    console.log(`EXAM  ${exam.title}`);
    console.log(`  _id            ${exam._id}`);
    console.log(`  sections       ${sections.length}`);
    console.log(`  questionIds    ${questionIds.length}`);

    if (questionIds.length === 0) {
      console.log('  VERDICT        BLOCKED — exam has no question ids at all');
      console.log(`  section keys   ${JSON.stringify(Object.keys(exam.sections?.[0] || {}))}`);
      continue;
    }

    // Same resolution the exam flow uses: per-class collection, keyed on the
    // exam's own classLevel.
    const bank = exam.classLevel;
    const collection = resolveQuestionModel(bank).collection.name;
    console.log(`  classLevel     ${JSON.stringify(bank)}`);
    console.log(`  collection     ${collection}`);

    const found = await findQuestionsByIds(questionIds, bank, GRADABILITY_FIELDS);
    console.log(`  found in bank  ${found.length} / ${questionIds.length}`);

    if (found.length === 0) {
      console.log(`  VERDICT        BLOCKED — none of these ids resolve in ${collection}`);
      console.log(`  sample id      ${questionIds[0]}`);
      continue;
    }

    // What the type labels claim.
    const byType: Record<string, number> = {};
    for (const q of found as any[]) {
      const t = String(q.type ?? '(none)');
      byType[t] = (byType[t] || 0) + 1;
    }
    console.log(`  types          ${JSON.stringify(byType)}`);

    // What the answer keys actually say.
    const gradable = (found as any[]).filter(isAutoGradable);
    console.log(`  gradable       ${gradable.length} / ${found.length}`);

    if (gradable.length === 0) {
      console.log('  VERDICT        BLOCKED — no question carries an answer key');
      const sample: any = found[0];
      console.log('  sample question:');
      console.log(`    type                    ${sample.type}`);
      console.log(`    options                 ${Array.isArray(sample.options) ? sample.options.length : '(none)'}`);
      if (Array.isArray(sample.options)) {
        console.log(`    options w/ isCorrect    ${sample.options.filter((o: any) => o?.isCorrect).length}`);
        console.log(`    option keys             ${JSON.stringify(Object.keys(sample.options[0] || {}))}`);
      }
      console.log(`    correctAnswerText       ${JSON.stringify(sample.correctAnswerText)}`);
      console.log(`    integerAnswer           ${JSON.stringify(sample.integerAnswer)}`);
      console.log(`    assertionIsTrue         ${JSON.stringify(sample.assertionIsTrue)}`);
    } else {
      console.log('  VERDICT        OK — this exam should promote');
    }
  }

  console.log('─'.repeat(78));
}

main()
  .catch((error) => {
    console.error('FAILED:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
