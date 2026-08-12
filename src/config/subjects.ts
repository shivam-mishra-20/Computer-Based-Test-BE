/**
 * Canonical subject list offered by pickers across the products.
 *
 * Mirrors the list the mobile Homework module ships (`homework/create.tsx`),
 * so a teacher sees the same subjects wherever they are asked for one. Kept
 * server-side rather than duplicated per client, so adding a subject is a
 * single change that every surface picks up.
 *
 * NOTE: this is a picker convenience list, not a registry — there is no Subject
 * collection, and `subject` is stored as a descriptive string on the documents
 * that use it. Content-derived subjects are unioned on top of this at runtime,
 * so anything already in the database still appears even if it is not listed
 * here.
 */
export const CURRICULUM_SUBJECTS: string[] = [
  'Physics',
  'Chemistry',
  'Mathematics',
  'Biology',
  'Science',
  'English',
  'Hindi',
  'Social Studies',
  'Commerce',
  'Business Studies',
  'Accountancy',
  'Economics',
  'Statistics',
  'Applied Mathematics',
  'Computer Science',
];
