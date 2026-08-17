/**
 * The module registry — the atomic units of entitlement.
 *
 * A module is what gets sold, switched on, and gated. This registry is CODE,
 * not data, and deliberately so: a module's key is referenced by
 * `requireModule('exams')` at route level, so a module that exists in the
 * database but not in the code is unreferenceable, and one that exists in code
 * but not the database would silently deny. Keeping the catalogue in one typed
 * file makes both impossible, and makes "what can we sell" answerable by
 * reading a single file.
 *
 * Prices and plan composition are NOT here — those are data, they change
 * without a deploy, and they live in the Plan collection.
 *
 * ── Dependencies ────────────────────────────────────────────────────────────
 * `requires` is enforced at resolution time. Selling Results without Exams
 * would produce a tenant whose results screen queries exams they cannot access
 * — a support ticket that looks like a bug and is actually a packaging error.
 */

export type ModuleTier = 'core' | 'education' | 'assessment' | 'ai' | 'premium';

/**
 * What happens to a tenant's data when a module is switched off.
 *
 * `retain` is the default for every module and the only value used today. A
 * customer who downgrades in March and loses their exam history has told every
 * institute in their city by April; in a market this word-of-mouth driven that
 * is unrecoverable. Retention is also what makes re-upgrade instant, which is
 * the cheapest revenue there is.
 */
export type OnDisable = 'retain' | 'archive';

export interface ModuleDefinition {
  key: string;
  name: string;
  tier: ModuleTier;
  /** Module keys that must also be enabled. Enforced during resolution. */
  requires: string[];
  /** Human summary — surfaced in the console and in plan comparisons. */
  description: string;
  /** Metered resources this module consumes, for usage records later. */
  meters?: string[];
  onDisable: OnDisable;
}

/**
 * Core modules are ALWAYS enabled and can never be sold separately or disabled.
 * Everything else depends on them, so a tenant without Users is not a cheaper
 * tenant — it is a broken one.
 */
export const CORE_MODULE_KEYS = [
  'auth',
  'organizations',
  'users',
  'rbac',
  'notifications',
  'files',
  'audit',
  'settings',
] as const;

export const MODULES: ModuleDefinition[] = [
  // ── Core — always on ─────────────────────────────────────────────────────
  { key: 'auth', name: 'Authentication', tier: 'core', requires: [], onDisable: 'retain',
    description: 'Login, sessions, password reset.' },
  { key: 'organizations', name: 'Organizations', tier: 'core', requires: [], onDisable: 'retain',
    description: 'Tenant record, status, configuration.' },
  { key: 'users', name: 'Users', tier: 'core', requires: ['auth'], onDisable: 'retain',
    description: 'Accounts, invitations, bulk import.' },
  { key: 'rbac', name: 'Roles & Permissions', tier: 'core', requires: ['users'], onDisable: 'retain',
    description: 'Role templates and permission assignment.' },
  { key: 'notifications', name: 'Notifications', tier: 'core', requires: ['users'], onDisable: 'retain',
    description: 'In-app, push and real-time delivery.', meters: ['notifications.sent'] },
  { key: 'files', name: 'Files', tier: 'core', requires: [], onDisable: 'retain',
    description: 'Upload, signed access, storage quota.', meters: ['storage.bytes'] },
  { key: 'audit', name: 'Audit Logs', tier: 'core', requires: [], onDisable: 'retain',
    description: 'Action trail with tiered retention.' },
  { key: 'settings', name: 'Settings', tier: 'core', requires: [], onDisable: 'retain',
    description: 'Per-organization configuration store.' },

  // ── Education ────────────────────────────────────────────────────────────
  { key: 'students', name: 'Students', tier: 'education', requires: ['users'], onDisable: 'retain',
    description: 'Roster, enrolment, profiles.', meters: ['students.active'] },
  { key: 'teachers', name: 'Teachers', tier: 'education', requires: ['users'], onDisable: 'retain',
    description: 'Staff records, assignment, workload.', meters: ['teachers.active'] },
  { key: 'classes', name: 'Classes & Batches', tier: 'education', requires: ['students'], onDisable: 'retain',
    description: 'Class levels, batches, rooms.' },
  { key: 'subjects', name: 'Subjects', tier: 'education', requires: ['classes'], onDisable: 'retain',
    description: 'Per-organization subject registry.' },
  { key: 'scheduling', name: 'Scheduling', tier: 'education', requires: ['classes', 'teachers'], onDisable: 'retain',
    description: 'Timetable with conflict validation.' },
  { key: 'homework', name: 'Homework', tier: 'education', requires: ['classes'], onDisable: 'retain',
    description: 'Assign, submit, track.' },
  { key: 'materials', name: 'Materials', tier: 'education', requires: ['classes', 'files'], onDisable: 'retain',
    description: 'Notes, resources, syllabus.' },
  { key: 'attendance', name: 'Attendance', tier: 'education', requires: ['students', 'classes'], onDisable: 'retain',
    description: 'Marking, rules, leave, EOD reports.' },
  { key: 'courses', name: 'Courses & Lectures', tier: 'education', requires: ['classes', 'files'], onDisable: 'retain',
    description: 'Course structure, video, progress.' },
  { key: 'doubts', name: 'Doubts', tier: 'education', requires: ['students', 'teachers'], onDisable: 'retain',
    description: 'Two-way student–teacher chat.' },

  // ── Assessment — the wedge, in every plan ────────────────────────────────
  { key: 'exams', name: 'Exams', tier: 'assessment', requires: ['classes'], onDisable: 'retain',
    description: 'Build, schedule, publish, assign.', meters: ['exams.conducted'] },
  { key: 'cbt', name: 'CBT Player', tier: 'assessment', requires: ['exams'], onDisable: 'retain',
    description: 'Timed delivery, offline queue, anti-cheat.' },
  { key: 'results', name: 'Results', tier: 'assessment', requires: ['exams'], onDisable: 'retain',
    description: 'Grading and the publish state machine.' },
  { key: 'evaluation', name: 'Evaluation', tier: 'assessment', requires: ['results'], onDisable: 'retain',
    description: 'Manual override, per-question marks, audit.' },
  { key: 'rankings', name: 'Rankings', tier: 'assessment', requires: ['results'], onDisable: 'retain',
    description: 'Leaderboard, percentile, rank.' },
  { key: 'questionBank', name: 'Question Bank', tier: 'assessment', requires: ['subjects'], onDisable: 'retain',
    description: 'Store, tag, search, blueprint.' },
  { key: 'questionImport', name: 'Question Import', tier: 'assessment', requires: ['questionBank'], onDisable: 'retain',
    description: 'PDF/EPUB/OCR extraction with LaTeX normalization.' },
  { key: 'offlineTests', name: 'Offline Tests', tier: 'assessment', requires: ['exams'], onDisable: 'retain',
    description: 'Paper tests, results entry, room allocation.' },
  { key: 'analytics', name: 'Analytics', tier: 'assessment', requires: ['results'], onDisable: 'retain',
    description: 'Per-student and per-exam performance.' },

  // ── AI — metered ─────────────────────────────────────────────────────────
  { key: 'ai', name: 'AI Generation', tier: 'ai', requires: ['questionBank'], onDisable: 'retain',
    description: 'Question and content generation.', meters: ['ai.generations', 'ai.tokens'] },
  { key: 'aiAnalysis', name: 'AI Analysis', tier: 'ai', requires: ['ai', 'analytics'], onDisable: 'retain',
    description: 'Performance insight and weak-area detection.', meters: ['ai.generations'] },

  // ── Premium ──────────────────────────────────────────────────────────────
  { key: 'advancedAnalytics', name: 'Advanced Analytics', tier: 'premium', requires: ['analytics'], onDisable: 'retain',
    description: 'Cohort, trend and predictive reporting.' },
  { key: 'whiteLabel', name: 'White Label', tier: 'premium', requires: [], onDisable: 'retain',
    description: 'Full branding with no platform marks.' },
  { key: 'customDomain', name: 'Custom Domain', tier: 'premium', requires: ['whiteLabel'], onDisable: 'retain',
    description: 'Own domain with automated TLS.' },
  { key: 'apiAccess', name: 'API Access', tier: 'premium', requires: [], onDisable: 'retain',
    description: 'Keys, webhooks, documentation.', meters: ['api.calls'] },
  { key: 'integrations', name: 'Integrations', tier: 'premium', requires: [], onDisable: 'retain',
    description: 'Biometric, ERP and accounting connectors.' },
];

const BY_KEY = new Map(MODULES.map((m) => [m.key, m]));

export function getModule(key: string): ModuleDefinition | undefined {
  return BY_KEY.get(key);
}

export function isCoreModule(key: string): boolean {
  return (CORE_MODULE_KEYS as readonly string[]).includes(key);
}

export function allModuleKeys(): string[] {
  return MODULES.map((m) => m.key);
}

/**
 * Expand a set of module keys to include everything they depend on.
 *
 * Selling "Results" without "Exams" produces a tenant whose results screen
 * queries exams they cannot access — a packaging error that presents as a bug.
 * Rather than reject such a plan, dependencies are added: the customer paid for
 * a working Results module, and Results does not work alone.
 *
 * Core modules are always included; they are not optional in any plan.
 */
export function expandDependencies(keys: string[]): string[] {
  const resolved = new Set<string>(CORE_MODULE_KEYS);
  const visit = (key: string, seen: Set<string>) => {
    if (resolved.has(key)) return;
    if (seen.has(key)) return; // cycle guard — see validateRegistry()
    seen.add(key);
    const def = BY_KEY.get(key);
    if (!def) return; // unknown keys are dropped by resolution, not expanded
    for (const dep of def.requires) visit(dep, seen);
    resolved.add(key);
  };
  for (const key of keys) visit(key, new Set());
  return [...resolved].sort();
}

/**
 * Structural checks on the registry itself, run at startup and in CI.
 *
 * A dangling dependency or a cycle is a developer error that would otherwise
 * surface as a tenant mysteriously missing a module they paid for.
 */
export function validateRegistry(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const keys = new Set(MODULES.map((m) => m.key));

  if (keys.size !== MODULES.length) {
    errors.push('duplicate module keys in the registry');
  }

  for (const module of MODULES) {
    for (const dep of module.requires) {
      if (!keys.has(dep)) {
        errors.push(`module "${module.key}" requires unknown module "${dep}"`);
      }
    }
  }

  for (const key of CORE_MODULE_KEYS) {
    if (!keys.has(key)) errors.push(`core module "${key}" is missing from the registry`);
  }

  // Cycle detection via depth-first colouring.
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>(MODULES.map((m) => [m.key, WHITE]));
  const walk = (key: string, path: string[]): void => {
    if (colour.get(key) === BLACK) return;
    if (colour.get(key) === GREY) {
      errors.push(`dependency cycle: ${[...path, key].join(' -> ')}`);
      return;
    }
    colour.set(key, GREY);
    for (const dep of BY_KEY.get(key)?.requires ?? []) walk(dep, [...path, key]);
    colour.set(key, BLACK);
  };
  for (const module of MODULES) walk(module.key, []);

  return { ok: errors.length === 0, errors };
}
