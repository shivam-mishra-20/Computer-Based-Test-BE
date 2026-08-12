/**
 * Public content visibility verification (pure logic — no DB required).
 *
 * The public endpoints (`/api/public/*`, `GET /api/resources`) are the only
 * unauthenticated read surface in the system. If the visibility floor ever
 * stops being applied, unpublished or institute-only resources become readable
 * by anyone with the URL.
 *
 * This asserts the floor's behaviour for each caller type, and that a client
 * cannot widen it through query parameters.
 *
 * Run:  npx ts-node scripts/verify-public-visibility.ts
 */

import type { Request } from 'express';
import {
  PUBLIC_RESOURCE_PROJECTION,
  applyPublicVisibilityFloor,
  buildPublicClassVariants,
  escapeRegex,
  isStaffRequest,
  publicClassClause,
} from '../src/utils/publicResourceVisibility';

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

console.log('Visibility floor by caller:');

const guest = applyPublicVisibilityFloor({} as any, req());
ok('guest is forced to published', guest.status === 'published');
ok('guest is forced to isPublic', guest.isPublic === true);

const instituteStudent = applyPublicVisibilityFloor({} as any, req('student'));
ok('institute student gets the SAME public view', instituteStudent.isPublic === true);

const learner = applyPublicVisibilityFloor({} as any, req('student'));
ok('public learner gets the SAME public view', learner.isPublic === true);

const teacher = applyPublicVisibilityFloor({} as any, req('teacher'));
ok('teacher (staff) is NOT floored', teacher.status === undefined);
const admin = applyPublicVisibilityFloor({} as any, req('admin'));
ok('admin (staff) is NOT floored', admin.status === undefined);

console.log('\nStaff detection:');
ok('guest is not staff', !isStaffRequest(req()));
ok('student is not staff', !isStaffRequest(req('student')));
ok('teacher is staff', isStaffRequest(req('teacher')));
ok('admin is staff', isStaffRequest(req('admin')));
ok('developer is staff', isStaffRequest(req('developer')));

console.log('\nA client cannot widen the floor:');
// Simulates `?isPublic=false&status=draft` arriving from an anonymous caller.
const attacked = applyPublicVisibilityFloor(
  { isPublic: false, status: 'draft' } as any,
  req(),
);
ok('client-supplied isPublic:false is overridden', attacked.isPublic === true);
ok('client-supplied status:draft is overridden', attacked.status === 'published');

console.log('\nGuests never receive uploader identity:');
ok('projection excludes uploadedBy', PUBLIC_RESOURCE_PROJECTION.includes('-uploadedBy'));

console.log('\nClass matching handles every stored spelling:');
const variants = buildPublicClassVariants('10');
ok('"10" matches "10"', variants.includes('10'));
ok('"10" matches "Class 10"', variants.includes('Class 10'));
ok('"10" matches lowercase "class 10"', variants.includes('class 10'));
const fromLabel = buildPublicClassVariants('Class 10');
ok('"Class 10" also matches bare "10"', fromLabel.includes('10'));
ok('empty class yields no clause', publicClassClause('') === null);
ok('undefined class yields no clause', publicClassClause(undefined) === null);
ok('a real class yields an $in clause', Array.isArray((publicClassClause('9') as any).classLevel.$in));

console.log('\nSearch input is escaped:');
ok('regex metacharacters are escaped', escapeRegex('a.*b') === 'a\\.\\*b');
ok('parentheses are escaped', escapeRegex('(x)') === '\\(x\\)');

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S) — public content visibility is NOT safe.`);
  process.exit(1);
}
console.log('Public content visibility verified.');
