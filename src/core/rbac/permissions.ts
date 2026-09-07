/**
 * The permission vocabulary — fixed, platform-controlled.
 *
 * ── Why tenants cannot invent permission strings ────────────────────────────
 * A permission is only meaningful if some route checks it. A tenant that could
 * mint `students.superedit` would get a role that reads impressively and grants
 * nothing, and the support ticket ("my Centre Manager cannot edit students")
 * would look like a platform bug. The vocabulary is therefore closed: tenants
 * compose ROLES freely from these strings, but cannot add to the list.
 *
 * ── resource.action ─────────────────────────────────────────────────────────
 * Two segments, always — so a UI can group by resource without parsing
 * conventions, and a wildcard grant has an obvious meaning if it is ever needed.
 */

export const PERMISSIONS = [
  'users.read', 'users.create', 'users.update', 'users.delete', 'users.invite',
  'roles.read', 'roles.create', 'roles.update', 'roles.delete',

  'students.read', 'students.create', 'students.update', 'students.delete', 'students.import',
  'teachers.read', 'teachers.create', 'teachers.update', 'teachers.delete',

  'classes.read', 'classes.manage',
  'subjects.read', 'subjects.manage',
  'batches.read', 'batches.manage',
  'rooms.read', 'rooms.manage',
  'schedule.read', 'schedule.manage',
  'syllabus.read', 'syllabus.manage',

  'exams.read', 'exams.create', 'exams.update', 'exams.delete', 'exams.publish',
  'attempts.read', 'attempts.grade',
  'results.read', 'results.publish', 'results.export', 'results.override',
  'questions.read', 'questions.create', 'questions.update', 'questions.delete', 'questions.import',

  'attendance.read', 'attendance.mark', 'attendance.manage',
  'homework.read', 'homework.manage',
  'materials.read', 'materials.manage',
  'doubts.read', 'doubts.respond',
  'courses.read', 'courses.manage',
  'leaves.read', 'leaves.approve',
  'announcements.read', 'announcements.manage',

  'analytics.read', 'reports.read', 'reports.export',

  'org.read', 'org.settings', 'org.branding', 'org.integrations',
  'audit.read',

  'ai.generate', 'ai.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET = new Set<string>(PERMISSIONS);

export function isValidPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/** Filter to known permissions — silently drops anything invented. */
export function sanitizePermissions(values: string[]): Permission[] {
  return [...new Set(values.filter(isValidPermission))] as Permission[];
}

/**
 * Legacy role to permission mapping — the compatibility bridge.
 *
 * Abhigyan's 158 users carry role: admin | teacher | student and no role
 * documents. If requirePermission() denied them, every converted route would
 * 403 for the entire existing customer.
 *
 * A user with no assigned roles therefore falls back to these sets, which are a
 * transcription of what each legacy role can already do. Converting a route
 * from requireRole('teacher','admin') to requirePermission('exams.create')
 * changes nothing for Org 001 — the only way 271 gates can migrate
 * progressively rather than in one unreviewable commit.
 */
export const LEGACY_ROLE_PERMISSIONS: Record<string, Permission[]> = {
  admin: [...PERMISSIONS],

  teacher: [
    'users.read',
    'students.read', 'students.create', 'students.update', 'students.import',
    'teachers.read',
    'classes.read', 'subjects.read', 'batches.read', 'rooms.read',
    'schedule.read', 'schedule.manage', 'syllabus.read', 'syllabus.manage',
    'exams.read', 'exams.create', 'exams.update', 'exams.delete', 'exams.publish',
    'attempts.read', 'attempts.grade',
    'results.read', 'results.publish', 'results.export', 'results.override',
    'questions.read', 'questions.create', 'questions.update', 'questions.delete', 'questions.import',
    'attendance.read', 'attendance.mark',
    'homework.read', 'homework.manage',
    'materials.read', 'materials.manage',
    'doubts.read', 'doubts.respond',
    'courses.read', 'courses.manage',
    'leaves.read',
    'announcements.read', 'announcements.manage',
    'analytics.read', 'reports.read', 'reports.export',
    'ai.generate', 'ai.read',
  ],

  student: [
    'exams.read',
    'attempts.read',
    'results.read',
    'schedule.read',
    'attendance.read',
    'homework.read',
    'materials.read',
    'doubts.read',
    'courses.read',
    'announcements.read',
    'leaves.read',
    'syllabus.read',
  ],
};

/**
 * System role templates seeded into every new organization.
 *
 * Cloneable but not editable: a customer who breaks their own Org Admin role
 * locks themselves out, and the support path for that is worse than the
 * flexibility is worth.
 */
export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
}

export const SYSTEM_ROLE_TEMPLATES: RoleTemplate[] = [
  {
    key: 'admin',
    name: 'Organization Admin',
    description: 'Full access to everything in this organization.',
    permissions: [...PERMISSIONS],
  },
  {
    key: 'teacher',
    name: 'Teacher',
    description: 'Teaching staff — classes, exams, results, attendance.',
    permissions: LEGACY_ROLE_PERMISSIONS.teacher,
  },
  {
    key: 'student',
    name: 'Student',
    description: 'Read-only access to their own academic records.',
    permissions: LEGACY_ROLE_PERMISSIONS.student,
  },
  {
    key: 'front_desk',
    name: 'Front Desk',
    description: 'Reception — enrolment and attendance, no academic authority.',
    permissions: [
      'students.read', 'students.create', 'students.update',
      'attendance.read', 'attendance.mark',
      'schedule.read', 'announcements.read',
    ],
  },
  {
    key: 'auditor',
    name: 'Read-only Auditor',
    description: 'Sees everything, changes nothing.',
    permissions: PERMISSIONS.filter((p) => p.endsWith('.read')) as Permission[],
  },
];

/** Permissions a legacy role grants; empty for an unknown role. */
export function permissionsForLegacyRole(role?: string | null): Permission[] {
  if (!role) return [];
  return LEGACY_ROLE_PERMISSIONS[role] ?? [];
}
