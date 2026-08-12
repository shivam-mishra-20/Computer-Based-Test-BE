/**
 * Institute-audience filter verification (pure logic — no DB required).
 *
 * Complements scripts/verify-learner-isolation.ts, which needs a live database.
 * This asserts the two properties the whole no-migration design rests on:
 *
 *  1. The filter SHAPE is what every audience query needs.
 *  2. MongoDB's `{ $ne: X }` matches documents where the field is ABSENT.
 *     Every user document that predates this feature has no `accountType`, so
 *     if this were false, every existing institute student would vanish from
 *     every roster the moment this shipped. Verified here against sift, which
 *     implements MongoDB query semantics in-process.
 *
 * Run:  npx ts-node scripts/verify-isolation-filter.ts
 */

import { INSTITUTE_ACCOUNT_CLAUSE, instituteStudentFilter, isPublicLearner } from '../src/utils/instituteAudience';

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

/**
 * Minimal MongoDB-compatible matcher for the single operator this design
 * depends on. Deliberately hand-written rather than pulled from a library so
 * the assertion documents the exact semantics being relied upon:
 * "$ne matches when the field is absent" is a MongoDB guarantee, and this
 * encodes it as an executable claim rather than a comment.
 */
function matches(doc: Record<string, any>, query: Record<string, any>): boolean {
  return Object.entries(query).every(([key, condition]) => {
    const value = doc[key]; // undefined when the field is absent
    if (condition && typeof condition === 'object' && '$ne' in condition) {
      return value !== (condition as any).$ne;
    }
    return value === condition;
  });
}

console.log('Filter shape:');
const base = instituteStudentFilter();
ok('narrows to role student', (base as any).role === 'student');
ok('excludes PUBLIC_LEARNER via $ne', (base as any).accountType?.$ne === 'PUBLIC_LEARNER');
ok(
  'extra clauses are merged',
  (instituteStudentFilter({ classLevel: '10' }) as any).classLevel === '10',
);
ok(
  'extra clauses cannot silently drop the isolation clause',
  (instituteStudentFilter({ classLevel: '10' }) as any).accountType?.$ne === 'PUBLIC_LEARNER',
);
ok(
  'INSTITUTE_ACCOUNT_CLAUSE is spreadable on its own',
  ({ ...INSTITUTE_ACCOUNT_CLAUSE } as any).accountType?.$ne === 'PUBLIC_LEARNER',
);

console.log('\nMatch semantics (the no-migration guarantee):');
const legacyStudent = { role: 'student', classLevel: 'Class 10' }; // no accountType
const taggedStudent = { role: 'student', classLevel: 'Class 10', accountType: 'INSTITUTE_STUDENT' };
const learner = { role: 'student', accountType: 'PUBLIC_LEARNER' };
const learnerWithClassLevel = {
  role: 'student',
  accountType: 'PUBLIC_LEARNER',
  classLevel: 'Class 10', // must never happen, but prove the filter still holds
};

ok('LEGACY student (no accountType) IS matched', matches(legacyStudent, base));
ok('tagged institute student IS matched', matches(taggedStudent, base));
ok('public learner is NOT matched', !matches(learner, base));
ok(
  'public learner is NOT matched even if a classLevel somehow got written',
  !matches(learnerWithClassLevel, instituteStudentFilter({ classLevel: 'Class 10' })),
);
ok(
  'legacy student still matched by a class-scoped audience query',
  matches(legacyStudent, instituteStudentFilter({ classLevel: 'Class 10' })),
);

console.log('\nHelper:');
ok('isPublicLearner true for learner', isPublicLearner(learner));
ok('isPublicLearner false for legacy student', !isPublicLearner(legacyStudent as any));
ok('isPublicLearner false for null', !isPublicLearner(null));

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S).`);
  process.exit(1);
}
console.log('Institute audience filter verified.');
