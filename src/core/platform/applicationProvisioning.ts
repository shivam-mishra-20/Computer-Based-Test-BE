/**
 * Turning a submitted application into provisioning input, and saying honestly
 * whether it is ready.
 *
 * ── The one job ─────────────────────────────────────────────────────────────
 * An admin should open an approved application, press one button, and get a
 * configured organization. Everything that stands between those two things is
 * either a mapping (done here) or a genuine gap in what the applicant supplied
 * (reported here). Nothing in this file provisions anything: it produces the
 * input that `onboardOrganization()` already knows how to apply.
 *
 * That boundary is deliberate. `onboardOrganization()` is the only sequence
 * that creates organizations, and it is idempotent, resumable and audited. A
 * second one — even a well-meaning "but this one handles applications" — would
 * be a second set of rules to keep in step, and the one nobody is looking at
 * is the one that drifts.
 *
 * ── Why the admin block is NOT mapped ───────────────────────────────────────
 * The application carries the initial administrator's name and email, and
 * deliberately no password: a public form is the wrong place to receive one.
 * So approval prefills those two fields in the console and staff supply the
 * credential there, which is the existing flow. Mapping an admin here would
 * mean inventing a password or provisioning an account nobody can sign into.
 */

import {
  isValidHexColor,
  slugifyOrgName,
  validateMobileIdentity,
  type MobileBuildIssue,
} from './mobileBuildRules';
import type { ConfigInput } from './organizations';
import type { OnboardingInput } from './onboarding';
import type { IOrganizationRegistration } from '../../models/OrganizationRegistration';

/* ══════════════════════════════════════════════════════════════════════════
   Presets
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Named starting points, expressed as module KEYS from `moduleRegistry.ts`.
 *
 * These are conveniences, not entitlements: the plan an organization actually
 * receives is decided in the console. A preset only decides what the form
 * ticks by default, and the applicant can change any of it.
 *
 * Every key below exists in the registry — `verifyApplicationPresets()` in the
 * safety suite asserts that, because a typo here becomes a module that is
 * silently never granted.
 */
export const MODULE_PRESETS: Record<string, string[]> = {
  coaching: [
    'students', 'teachers', 'classes', 'subjects', 'attendance', 'scheduling',
    'exams', 'cbt', 'results', 'rankings', 'questionBank', 'homework',
    'materials', 'doubts', 'notifications',
  ],
  school: [
    'students', 'teachers', 'classes', 'subjects', 'attendance', 'scheduling',
    'exams', 'results', 'homework', 'materials', 'notifications',
  ],
  'test-prep': [
    'students', 'teachers', 'classes', 'subjects', 'exams', 'cbt', 'results',
    'rankings', 'questionBank', 'questionImport', 'analytics', 'offlineTests',
    'notifications',
  ],
  custom: [],
};

/* ══════════════════════════════════════════════════════════════════════════
   Readiness
   ══════════════════════════════════════════════════════════════════════════ */

export interface ReadinessCheck {
  key: string;
  label: string;
  ok: boolean;
  /** What is missing, in the words an admin would use to go and fix it. */
  detail?: string;
  /** True when this alone stops provisioning. */
  blocking: boolean;
}

export interface ApplicationReadiness {
  status: 'READY' | 'NEEDS_ATTENTION';
  checks: ReadinessCheck[];
  blockingCount: number;
  /** Mobile-specific issues, from the shared build validator. */
  mobileIssues: MobileBuildIssue[];
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Duplicate detection, shared by every list section.
 *
 * Returns the offending values rather than a boolean: "two classes share a
 * key" is not actionable, "class key '11' appears twice" is.
 */
function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const raw of values) {
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    if (seen.has(v)) dupes.add(raw.trim());
    else seen.add(v);
  }
  return [...dupes];
}

/**
 * Every reason this application is or is not ready to provision.
 *
 * ── Blocking vs not ─────────────────────────────────────────────────────────
 * Blocking means `onboardOrganization()` would fail or would produce an
 * organization nobody can use. Non-blocking means an admin can proceed and fix
 * it afterwards from the console. Marking everything blocking would make the
 * report useless — an admin would learn to override it wholesale — so the line
 * is drawn at "can this organization actually be operated".
 *
 * Mobile checks are deliberately NON-blocking: a shared multi-tenant build
 * serves an organization perfectly well, and a dedicated white-label binary is
 * a separate commercial decision. Provisioning should not wait on a package
 * name nobody has asked for yet.
 */
export function assessApplication(registration: IOrganizationRegistration): ApplicationReadiness {
  const app = registration.application ?? {};
  const org = app.organization ?? {};
  const branding = app.branding ?? {};
  const academic = app.academic ?? {};
  const staff = app.staff ?? {};
  const checks: ReadinessCheck[] = [];

  const add = (key: string, label: string, ok: boolean, blocking: boolean, detail?: string) =>
    checks.push({ key, label, ok, blocking, detail: ok ? undefined : detail });

  // ── The application itself ───────────────────────────────────────────────
  const hasApplication = Boolean(registration.application);
  add(
    'application',
    'Application submitted',
    hasApplication,
    false,
    'This registration predates the onboarding form. Its details can be completed here before approving.',
  );

  // ── Organization ─────────────────────────────────────────────────────────
  add('orgName', 'Organization name', Boolean(text(registration.organizationName)), true, 'Required.');
  const slug = registration.orgSlug || slugifyOrgName(registration.organizationName ?? '');
  add('slug', 'Slug can be derived', Boolean(slug), true, 'The institute name produces no usable slug. Set one explicitly.');
  add(
    'contact',
    'Contact details',
    Boolean(text(registration.email) && text(registration.phone)),
    true,
    'A contact email and phone are required.',
  );
  add(
    'address',
    'Address',
    Boolean(text(org.city) || text(registration.city)),
    false,
    'No city recorded.',
  );

  // ── Branding ─────────────────────────────────────────────────────────────
  const appName = text(branding.appName) || text(registration.organizationName);
  add('appName', 'App display name', Boolean(appName), true, 'Required — it is the home-screen label.');
  add(
    'tagline',
    'Tagline',
    Boolean(text(branding.tagline)),
    false,
    'Not supplied. Required only for a dedicated mobile build.',
  );

  const colours: [string, string][] = [
    ['primaryColor', 'Primary colour'],
    ['secondaryColor', 'Secondary colour'],
    ['accentColor', 'Accent colour'],
  ];
  const badColours = colours.filter(([k]) => {
    const v = text((branding as Record<string, unknown>)[k]);
    return !v || !isValidHexColor(v);
  });
  add(
    'colours',
    'Brand colours valid',
    badColours.length === 0,
    false,
    badColours.length
      ? `${badColours.map(([, l]) => l).join(', ')} missing or not a hex colour.`
      : undefined,
  );

  const assets = rows(app.assets);
  add(
    'logo',
    'Logo uploaded',
    assets.some((a) => (a as { kind?: string }).kind === 'logo'),
    false,
    'No logo uploaded. Needed before a dedicated mobile build; the shared app uses platform defaults.',
  );

  // ── Academic structure ───────────────────────────────────────────────────
  const classLevels = rows(academic.classLevels);
  const subjects = rows(academic.subjects);
  const roomRows = rows(academic.rooms);
  const batchRows = rows(academic.batches);

  add('classLevels', 'Class levels', classLevels.length > 0, true, 'At least one class level is required — students cannot be placed without one.');
  add('subjects', 'Subjects', subjects.length > 0, true, 'At least one subject is required.');
  add('rooms', 'Rooms', roomRows.length > 0, false, 'No rooms configured. Exam seating needs them; they can be added later.');
  add('batches', 'Batches', batchRows.length > 0, false, 'No batches configured.');

  const dupClass = duplicates(classLevels.map((c) => String((c as { key?: string }).key ?? '')));
  const dupSubject = duplicates(subjects.map((s) => String((s as { name?: string }).name ?? '')));
  const dupRoom = duplicates(roomRows.map((r) => String((r as { name?: string }).name ?? '')));
  const dupBatch = duplicates(batchRows.map((b) => String((b as { name?: string }).name ?? '')));
  const allDupes = [
    dupClass.length ? `class keys: ${dupClass.join(', ')}` : '',
    dupSubject.length ? `subjects: ${dupSubject.join(', ')}` : '',
    dupRoom.length ? `rooms: ${dupRoom.join(', ')}` : '',
    dupBatch.length ? `batches: ${dupBatch.join(', ')}` : '',
  ].filter(Boolean);
  add(
    'duplicates',
    'No duplicate entries',
    allDupes.length === 0,
    true,
    allDupes.length ? `Duplicates would overwrite each other — ${allDupes.join('; ')}.` : undefined,
  );

  // A batch naming a class level that does not exist produces a batch nobody
  // can assign anyone to. Cheap to catch here, confusing to discover later.
  const classKeys = new Set(classLevels.map((c) => String((c as { key?: string }).key ?? '').toLowerCase()));
  const orphanBatches = batchRows
    .filter((b) => rows((b as { classLevels?: unknown }).classLevels).some((k) => !classKeys.has(String(k).toLowerCase())))
    .map((b) => String((b as { name?: string }).name ?? '?'));
  add(
    'relationships',
    'Batches reference real class levels',
    orphanBatches.length === 0,
    true,
    orphanBatches.length ? `These batches name a class level that was not defined: ${orphanBatches.join(', ')}.` : undefined,
  );

  // ── Modules ──────────────────────────────────────────────────────────────
  const addOns = rows(app.modules?.addOns);
  add('modules', 'Modules selected', addOns.length > 0, false, 'None selected. The organization would start with the plan default only.');

  // ── Administrator ────────────────────────────────────────────────────────
  const admins = rows(staff.admins) as { name?: string; email?: string }[];
  const primary = admins.find((a) => (a as { isPrimary?: boolean }).isPrimary) ?? admins[0];
  add(
    'admin',
    'Initial administrator',
    Boolean(primary && text(primary.name) && text(primary.email)),
    false,
    'No administrator named. One can be entered at approval; provisioning will otherwise create none.',
  );

  // ── Mobile build ─────────────────────────────────────────────────────────
  // Read through the SAME validator the build and the console readiness use.
  const mobile = (registration as unknown as { mobilePreview?: Record<string, unknown> }).mobilePreview ?? {};
  const mobileIssues = validateMobileIdentity(
    {
      orgId: registration.orgId ? String(registration.orgId) : '',
      slug,
      appName,
      tagline: text(branding.tagline),
      androidPackage: text(mobile.androidPackage),
      iosBundleId: text(mobile.iosBundleId),
      scheme: text(mobile.scheme),
      apiBaseUrl: text(mobile.apiBaseUrl),
      primaryColor: text(branding.primaryColor),
      secondaryColor: text(branding.secondaryColor),
      accentColor: text(branding.accentColor),
      backgroundColor: text(branding.splashBackgroundColor) || '#05070C',
      assetsPresent: assets.length > 0,
    },
    'production',
  );
  add(
    'mobile',
    'Dedicated mobile build ready',
    mobileIssues.length === 0,
    false,
    mobileIssues.length
      ? `${mobileIssues.length} item(s) outstanding. Only needed for a dedicated white-label app — the shared app works without them.`
      : undefined,
  );

  const blocking = checks.filter((c) => !c.ok && c.blocking);
  return {
    status: blocking.length === 0 ? 'READY' : 'NEEDS_ATTENTION',
    checks,
    blockingCount: blocking.length,
    mobileIssues,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   Mapping
   ══════════════════════════════════════════════════════════════════════════ */

/** Only keys the module registry actually knows. */
function knownModules(keys: unknown[]): string[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const registry = require('../entitlements/moduleRegistry');
  const all: Set<string> = new Set(
    (registry.MODULES ?? registry.moduleRegistry ?? []).map((m: { key: string }) => m.key),
  );
  // An unknown key is dropped rather than passed through: the entitlement
  // resolver would ignore it anyway, and dropping it here means the
  // provisioning result reports what was actually applied.
  return keys.map(String).filter((k) => all.has(k));
}

export interface MappedOnboarding {
  input: Omit<OnboardingInput, 'admin'>;
  /** Prefill for the console's administrator fields. Never a password. */
  adminPrefill: { name: string; email: string } | null;
  /** Module keys that were requested but are not in the registry. */
  droppedModules: string[];
}

/**
 * The application, expressed as `onboardOrganization()` input.
 *
 * Every section maps onto something that orchestrator already applies. What
 * the applicant did not supply is simply absent — `onboardOrganization` skips
 * an absent block rather than writing an empty one, so a partial application
 * produces a partially configured organization rather than one full of blanks.
 */
export function applicationToOnboardingInput(
  registration: IOrganizationRegistration,
  overrides: { slug?: string; status?: string; notes?: string } = {},
): MappedOnboarding {
  const app = registration.application ?? {};
  const org = app.organization ?? {};
  const branding = app.branding ?? {};
  const academic = app.academic ?? {};
  const policy = app.policy ?? {};
  const staff = app.staff ?? {};

  const slug =
    registration.orgSlug ||
    text(overrides.slug) ||
    slugifyOrgName(registration.organizationName ?? '');

  // ── Branding: only fields Org.branding actually has ──────────────────────
  const mappedBranding: Record<string, unknown> = {};
  const brandPairs: [string, unknown][] = [
    ['appName', text(branding.appName) || registration.organizationName],
    ['tagline', text(branding.tagline)],
    ['primaryColor', text(branding.primaryColor)],
    ['secondaryColor', text(branding.secondaryColor)],
    ['accentColor', text(branding.accentColor)],
    ['splashBackgroundColor', text(branding.splashBackgroundColor)],
    ['documentHeader', text(org.legalName) || registration.organizationName],
    ['documentAddress', [org.addressLine1, org.addressLine2, org.city, org.state, org.postalCode].filter(Boolean).join(', ')],
    ['emailFromName', text(branding.appName) || registration.organizationName],
  ];
  for (const [k, v] of brandPairs) if (v) mappedBranding[k] = v;

  // ── Locale ───────────────────────────────────────────────────────────────
  const locale: Record<string, unknown> = {};
  if (policy.locale?.timezone) locale.timezone = policy.locale.timezone;
  if (policy.locale?.currency) locale.currency = policy.locale.currency;
  if (policy.locale?.language) locale.language = policy.locale.language;

  // ── Academic → ConfigInput, field for field ──────────────────────────────
  const configuration: ConfigInput = {};
  if (rows(academic.classLevels).length) {
    configuration.classLevels = (academic.classLevels ?? []).map((c, i) => ({
      key: String(c.key ?? '').toLowerCase(),
      label: String(c.label ?? c.key ?? ''),
      aliases: c.aliases?.length ? c.aliases : [String(c.key ?? ''), String(c.label ?? '')].filter(Boolean),
      order: c.order ?? i,
    }));
  }
  if (rows(academic.subjects).length) {
    configuration.subjects = (academic.subjects ?? []).map((s, i) => ({
      name: String(s.name ?? ''),
      code: s.code ? String(s.code) : undefined,
      order: s.order ?? i,
    }));
  }
  if (rows(academic.rooms).length) {
    configuration.rooms = (academic.rooms ?? []).map((r, i) => ({
      name: String(r.name ?? ''),
      capacity: typeof r.capacity === 'number' ? r.capacity : undefined,
      order: r.order ?? i,
    }));
  }
  if (rows(academic.batches).length) {
    configuration.batches = (academic.batches ?? []).map((b) => ({
      name: String(b.name ?? ''),
      classLevels: (b.classLevels ?? []).map((k) => String(k).toLowerCase()),
    }));
  }

  // ── Policy: drop empty sections so nothing writes a blank ────────────────
  const mappedPolicy: Record<string, unknown> = {};
  for (const section of ['exam', 'grading', 'attendance', 'leave'] as const) {
    const value = (policy as Record<string, unknown>)[section];
    if (value && typeof value === 'object' && Object.keys(value).length) {
      mappedPolicy[section] = value;
    }
  }
  if (Object.keys(locale).length) mappedPolicy.locale = locale;

  // ── Modules ──────────────────────────────────────────────────────────────
  const requested = rows(app.modules?.addOns).map(String);
  const preset = text(app.modules?.preset);
  const fromPreset = preset && MODULE_PRESETS[preset] ? MODULE_PRESETS[preset] : [];
  const wanted = [...new Set([...fromPreset, ...requested])];
  const addOns = knownModules(wanted);
  const droppedModules = wanted.filter((k) => !addOns.includes(k));

  // ── Administrator: prefill only ──────────────────────────────────────────
  const admins = rows(staff.admins) as { name?: string; email?: string; isPrimary?: boolean }[];
  const primary = admins.find((a) => a.isPrimary) ?? admins[0];
  const adminPrefill =
    primary && text(primary.name) && text(primary.email)
      ? { name: text(primary.name), email: text(primary.email) }
      : registration.contactName && registration.email
        ? { name: registration.contactName, email: registration.email }
        : null;

  const input: Omit<OnboardingInput, 'admin'> = {
    organization: {
      name: registration.organizationName,
      slug,
      status: overrides.status,
      notes:
        overrides.notes ??
        `Provisioned from application ${String(registration._id)} ` +
          `(${registration.contactName}, ${registration.email}).`,
    },
    ...(Object.keys(mappedBranding).length ? { branding: mappedBranding } : {}),
    ...(Object.keys(locale).length ? { locale } : {}),
    ...(Object.keys(configuration).length ? { configuration } : {}),
    ...(Object.keys(mappedPolicy).length ? { policy: mappedPolicy } : {}),
    ...(addOns.length ? { subscription: { addOns, status: 'trialing' } } : {}),
  };

  return { input, adminPrefill, droppedModules };
}
