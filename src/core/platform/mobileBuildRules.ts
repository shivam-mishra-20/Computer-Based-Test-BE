/**
 * The rules that decide whether an organization can become a mobile app.
 *
 * ── Why this lives in the backend ───────────────────────────────────────────
 * Two places need to answer "is this configuration buildable":
 *
 *   · THIS SERVER, when the console asks whether an organization is ready and
 *     when it generates that organization's build configuration;
 *   · `client-platform-app/config/resolve.js`, at BUILD time, where the answer
 *     decides whether `expo prebuild` produces a binary at all.
 *
 * If those two disagree, the console reports READY for a build that then fails
 * — or refuses one that would have succeeded, and somebody edits until the
 * console is happy and the app is wrong. Silent in both directions, which is
 * why one definition matters.
 *
 * ── Why it is COPIED rather than imported ───────────────────────────────────
 * It was briefly imported from `@platform/client-core`, and that broke the
 * production container. Three reasons, each sufficient on its own:
 *
 *   1. That package is a SIBLING GIT REPOSITORY. `file:../platform-client-core`
 *      resolves on a developer's machine and nowhere else; Railway clones this
 *      repository alone, so the path does not exist during install.
 *   2. `package-lock.json` is git-ignored here, so the container installs from
 *      `package.json` fresh — there is no lockfile entry to fall back on.
 *   3. The build bundles with `--packages=external`, so esbuild never resolves
 *      bare imports. `require("@platform/client-core")` survived into
 *      `dist/server.js` and failed at startup, long after the build reported
 *      success.
 *
 * There is also a direction problem underneath the packaging one: that package
 * describes itself as "shared by client-platform-web and client-platform-app".
 * A server that depends on a client package has its arrows backwards. The
 * platform's rules belong to the platform.
 *
 * ── How the two copies are kept honest ──────────────────────────────────────
 * `platform-client-core/src/mobileBuild.ts` mirrors everything below this
 * header so the two clients can validate at build time without reaching into a
 * server. `npm run safety:mobile-rules` compares them and fails on any
 * difference. It skips — loudly — where the sibling checkout is absent, because
 * a container has no opinion about a repository it was never given.
 *
 * No Node APIs, no React, no fetch: this module is imported by Express here and
 * mirrored into a package that loads inside the Expo config loader.
 */

/* ══════════════════════════════════════════════════════════════════════════
   Predicates — one definition each
   ══════════════════════════════════════════════════════════════════════════ */

/** Reverse-DNS, at least two segments, lowercase. What both stores accept. */
export const PACKAGE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** A URL scheme the OS will route: a letter, then letters/digits/+/-/. */
export const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;

export const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Hosts that resolve to the machine running the code.
 *
 * `10.0.2.2` is included because it is the Android emulator's alias for its
 * host — correct in development, meaningless on a real device.
 */
export const LOOPBACK_PATTERN = /^(127\.0\.0\.1|localhost|\[?::1\]?|0\.0\.0\.0|10\.0\.2\.2)$/i;

/** A kebab-case organization slug. */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Marks a value that is deliberately not real yet.
 *
 * An organization id is minted at provisioning, so it genuinely cannot be
 * known while an institute is being set up. `pending:` says "not real on
 * purpose": development builds accept it, anything that ships refuses it.
 */
export const PENDING_PREFIX = 'pending:';

export function isPendingValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PENDING_PREFIX);
}

export function isValidPackageId(value: string | null | undefined): boolean {
  return typeof value === 'string' && PACKAGE_PATTERN.test(value);
}

export function isValidScheme(value: string | null | undefined): boolean {
  return typeof value === 'string' && SCHEME_PATTERN.test(value);
}

export function isValidHexColor(value: string | null | undefined): boolean {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value);
}

export function isValidSlug(value: string | null | undefined): boolean {
  return typeof value === 'string' && SLUG_PATTERN.test(value) && value.length <= 60;
}

/** The host part of a URL, or '' when there is not one. */
export function hostOfUrl(url: string): string {
  const m = url.match(/^[a-z]+:\/\/([^/:]+)/i);
  return m ? m[1] : '';
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_PATTERN.test(host);
}

/**
 * A URL-safe slug from an institute's name.
 *
 * Shared so the console's preview, the backend's derivation and the app's
 * registry key cannot produce three different answers for one name.
 */
export function slugifyOrgName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/* ══════════════════════════════════════════════════════════════════════════
   The validator
   ══════════════════════════════════════════════════════════════════════════ */

/** How strictly a configuration is judged. */
export type MobileBuildProfile = 'development' | 'preview' | 'production';

/**
 * The profiles an operator may actually choose, and what they mean.
 *
 * `development` is absent on purpose. It tolerates a missing API address and a
 * `pending:` organization id — states that exist only while an institute is
 * half-provisioned — and an installable artifact produced from one of those is
 * an app that cannot reach anything, handed to somebody as though it could.
 *
 * `preview` is the internal-testing build: it still refuses a loopback address
 * and a pending id, so every rule that catches a real mistake stays on. The
 * single rule it relaxes is the transport one, which is what lets a tester
 * point a build at a server on the office network that has no certificate.
 */
export const SELECTABLE_BUILD_PROFILES = ['production', 'preview'] as const;

export type SelectableBuildProfile = (typeof SELECTABLE_BUILD_PROFILES)[number];

/**
 * Read a profile from an untrusted string.
 *
 * Falls back to `production` rather than throwing, and `production` is the
 * STRICTEST of the two — so a malformed value, a stale client or a typo can
 * only ever tighten the rules. A parser that defaulted the other way would let
 * a query string relax them.
 */
export function parseBuildProfile(value: unknown): SelectableBuildProfile {
  const text = String(value ?? '').trim().toLowerCase();
  return (SELECTABLE_BUILD_PROFILES as readonly string[]).includes(text)
    ? (text as SelectableBuildProfile)
    : 'production';
}

export interface MobileBuildIssue {
  field: string;
  message: string;
}

/**
 * Everything the rules below look at.
 *
 * Deliberately flat and free of both sides' internal shapes: the app builds it
 * from `config/organizations/<slug>.js`, the server from an `Org` document,
 * and neither has to know the other's structure.
 */
export interface MobileBuildIdentity {
  orgId?: string | null;
  slug?: string | null;
  appName?: string | null;
  tagline?: string | null;
  androidPackage?: string | null;
  iosBundleId?: string | null;
  scheme?: string | null;
  apiBaseUrl?: string | null;
  primaryColor?: string | null;
  secondaryColor?: string | null;
  accentColor?: string | null;
  backgroundColor?: string | null;
  /**
   * Whether the five bundled assets are accounted for. The app proves this by
   * reading the disk; the server proves it by having URLs recorded. Passed in
   * rather than computed, because only the caller knows which it can check.
   */
  assetsPresent?: boolean;
  /** What is missing, for the message. Ignored when `assetsPresent`. */
  missingAssets?: string[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Every field-level reason this configuration could not build.
 *
 * Returns a list rather than the first failure: somebody finalizing an
 * organization should see all six missing values at once, not discover them
 * one save at a time.
 */
export function validateMobileIdentity(
  input: MobileBuildIdentity,
  profile: MobileBuildProfile = 'production',
): MobileBuildIssue[] {
  const issues: MobileBuildIssue[] = [];
  const fail = (field: string, message: string) => issues.push({ field, message });
  const shipped = profile === 'preview' || profile === 'production';

  // ── Identity ─────────────────────────────────────────────────────────────
  const orgId = text(input.orgId);
  if (!orgId) {
    fail('orgId', 'The organization id is required — the app cannot brand itself before sign-in without it.');
  } else if (isPendingValue(orgId) && shipped) {
    fail(
      'orgId',
      `Still "${orgId}". This organization has not been provisioned yet, so there is no id to build ` +
        `against. A ${profile} build cannot carry the placeholder.`,
    );
  }

  const slug = text(input.slug);
  if (!slug) fail('slug', 'A slug is required.');
  else if (!isValidSlug(slug)) fail('slug', `"${slug}" is not a valid slug (lowercase, digits and hyphens).`);

  if (!text(input.appName)) fail('appName', 'An app name is required — it is the home-screen label.');
  if (!text(input.tagline)) fail('tagline', 'A tagline is required — it is shown under the name on launch.');

  // ── Native identity ──────────────────────────────────────────────────────
  const androidPackage = text(input.androidPackage);
  if (!androidPackage) fail('androidPackage', 'An Android package name is required.');
  else if (!isValidPackageId(androidPackage)) {
    fail('androidPackage', `"${androidPackage}" is not a valid Android applicationId (lowercase reverse-DNS, at least two segments).`);
  }

  const iosBundleId = text(input.iosBundleId);
  if (!iosBundleId) fail('iosBundleId', 'An iOS bundle identifier is required.');
  else if (!isValidPackageId(iosBundleId)) {
    fail('iosBundleId', `"${iosBundleId}" is not a valid iOS bundle identifier.`);
  }

  const scheme = text(input.scheme);
  if (!scheme) fail('scheme', 'A deep-link scheme is required.');
  else if (!isValidScheme(scheme)) fail('scheme', `"${scheme}" is not a usable deep-link scheme.`);

  // ── Colours ──────────────────────────────────────────────────────────────
  const colours: [keyof MobileBuildIdentity, string][] = [
    ['primaryColor', 'Primary colour'],
    ['secondaryColor', 'Secondary colour'],
    ['accentColor', 'Accent colour'],
    ['backgroundColor', 'Background colour'],
  ];
  for (const [key, label] of colours) {
    const value = text(input[key]);
    if (!value) fail(String(key), `${label} is required.`);
    else if (!isValidHexColor(value)) fail(String(key), `"${value}" is not a hex colour.`);
  }

  // ── The address ──────────────────────────────────────────────────────────
  const apiBaseUrl = text(input.apiBaseUrl);
  if (!apiBaseUrl) {
    if (shipped) {
      fail(
        'apiBaseUrl',
        `A ${profile} build must have an API address. There is deliberately no default: a shipped ` +
          'app that quietly points at localhost points at the phone it is running on.',
      );
    }
  } else {
    if (!/^https?:\/\//i.test(apiBaseUrl)) {
      fail('apiBaseUrl', `"${apiBaseUrl}" must start with http:// or https://`);
    }
    const host = hostOfUrl(apiBaseUrl);
    if (shipped && isLoopbackHost(host)) {
      fail(
        'apiBaseUrl',
        `"${host}" is a loopback address. On a device that is the device itself, so a ${profile} ` +
          'build pointed there can never reach anything.',
      );
    }
    if (profile === 'production' && /^http:\/\//i.test(apiBaseUrl)) {
      fail('apiBaseUrl', 'A production build must use https.');
    }
    if (!/\/api$/.test(apiBaseUrl)) {
      fail('apiBaseUrl', `"${apiBaseUrl}" should end with /api — the suffix is part of the base, not something the client appends.`);
    }
  }

  // ── Assets ───────────────────────────────────────────────────────────────
  if (input.assetsPresent === false) {
    const missing = input.missingAssets?.length ? input.missingAssets.join(', ') : 'one or more';
    fail('assets', `Native assets are not ready: ${missing}. They are bundled at build time and cannot be added later.`);
  }

  return issues;
}

/* ══════════════════════════════════════════════════════════════════════════
   Readiness
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * `NOT_CONFIGURED` — nothing has been entered; nobody has started.
 * `INCOMPLETE`     — started, but something required is missing or invalid.
 * `READY`          — every rule above passes for the given profile.
 */
export type MobileBuildStatus = 'NOT_CONFIGURED' | 'INCOMPLETE' | 'READY';

/**
 * The status, derived from the same issues a build would raise.
 *
 * `NOT_CONFIGURED` is distinguished from `INCOMPLETE` on purpose: "nobody has
 * touched this yet" and "somebody tried and it is wrong" are different pieces
 * of operational news, and a queue that shows them identically hides the
 * second.
 */
export function mobileBuildStatus(
  input: MobileBuildIdentity,
  issues: MobileBuildIssue[],
): MobileBuildStatus {
  if (issues.length === 0) return 'READY';
  const started = Boolean(
    text(input.androidPackage) || text(input.iosBundleId) || text(input.scheme),
  );
  return started ? 'INCOMPLETE' : 'NOT_CONFIGURED';
}

/* ══════════════════════════════════════════════════════════════════════════
   Reconciliation
   ══════════════════════════════════════════════════════════════════════════ */

export interface MobileBuildMismatch {
  field: string;
  /** What the organization record says. */
  expected: string;
  /** What the build configuration says. */
  actual: string;
}

/** The fields whose disagreement changes what the built app is or does. */
export const RECONCILED_FIELDS: (keyof MobileBuildIdentity)[] = [
  'orgId',
  'slug',
  'appName',
  'tagline',
  'androidPackage',
  'iosBundleId',
  'scheme',
  'apiBaseUrl',
  'primaryColor',
  'secondaryColor',
  'accentColor',
  'backgroundColor',
];

/**
 * Where the organization record and a build configuration disagree.
 *
 * The comparison is deliberately narrow: it covers what ends up baked into a
 * binary or shown before sign-in, and nothing else. A field absent from BOTH
 * sides is not a mismatch — it is a gap the validator already reports, and
 * counting it twice would make an unconfigured organization look like a
 * conflict.
 */
export function reconcileMobileBuild(
  organization: MobileBuildIdentity,
  build: MobileBuildIdentity,
): MobileBuildMismatch[] {
  const mismatches: MobileBuildMismatch[] = [];
  for (const field of RECONCILED_FIELDS) {
    const expected = text(organization[field]);
    const actual = text(build[field]);
    if (!expected && !actual) continue;
    // Colours and identifiers are compared case-insensitively: `#4F46E5` and
    // `#4f46e5` are the same colour, and treating them as a conflict would
    // teach people to ignore the report.
    if (expected.toLowerCase() !== actual.toLowerCase()) {
      mismatches.push({ field: String(field), expected, actual });
    }
  }
  return mismatches;
}

/* ══════════════════════════════════════════════════════════════════════════
   Brand configuration — what an organization owns
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The app experience an organization defines for itself.
 *
 * ── Why this is here and not in each client ─────────────────────────────────
 * Three things have to agree about what an institute's app looks like: the
 * BUILD (which bakes it into a binary), the APP (which renders it before any
 * network call), and the ADMIN PREVIEW (which promises an administrator what
 * their users will see). A preview that resolves defaults differently from the
 * build is a promise the product does not keep, and it is the kind of drift
 * nobody notices until an institute complains that the app is not what they
 * configured.
 *
 * So there is one resolver, in the file that is already mirrored byte-for-byte
 * into `@platform/client-core` and checked by `npm run safety:mobile-rules`.
 * The build reads it here, the app reads the mirror, and the admin preview
 * asks this server rather than re-implementing it.
 *
 * ── What an organization owns, and what it does not ─────────────────────────
 * It owns its IDENTITY and its ATMOSPHERE: name, logo, the accent colours, the
 * glow behind the glass, the words on the sign-in screen, which roles may
 * register.
 *
 * It does not own legibility. Surfaces and body text are fixed by the platform
 * — see the note in the app's `branding.ts`. An institute choosing its accent
 * is branding; an institute choosing its body-text colour is an accessibility
 * incident with a support ticket attached. The semantic states (success,
 * warning, danger) ARE overridable, because they are accents too, but they
 * fall back to values chosen for contrast rather than to the brand colour.
 */

/** Every colour an organization may set. All optional; all defaulted. */
export interface BrandPalette {
  primaryColor?: string | null;
  secondaryColor?: string | null;
  accentColor?: string | null;
  /** The dark base the pre-auth gradient resolves to. */
  backgroundColor?: string | null;
  /** Native splash background. Distinct from `backgroundColor` on purpose:
   *  one is a launch image, the other is the app's own atmosphere. */
  splashBackgroundColor?: string | null;
  successColor?: string | null;
  warningColor?: string | null;
  dangerColor?: string | null;
}

/** The words on the screens a person sees before they have an account. */
export interface BrandAuthCopy {
  welcomeTitle?: string | null;
  welcomeSubtitle?: string | null;
  loginMessage?: string | null;
  registerMessage?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
}

export type BrandRole = 'student' | 'teacher' | 'parent';

export const BRAND_ROLES: readonly BrandRole[] = ['student', 'teacher', 'parent'];

/**
 * Roles that the PLATFORM can actually authenticate today.
 *
 * All three, as of 2026-09-23. `parent` became supported when the backend
 * gained what it needs: a `parent` user role, a tenant-scoped GuardianLink
 * between a parent and each ward, ward matching by institute-issued student
 * code plus the ward's registered phone, administrator verification before any
 * access, and a default-deny guard that confines a parent token to the parent
 * endpoints (core/guardians, middlewares/authMiddleware).
 *
 * Removing a role from this list turns it off everywhere at once: the mobile
 * role selector, the admin editor and the preview all read it.
 */
export const SUPPORTED_AUTH_ROLES: readonly BrandRole[] = ['student', 'teacher', 'parent'];

/** How someone gets an account. Mirrors what the server will actually do. */
export type RegistrationPolicy = 'open' | 'approval' | 'invite';

/** What an organization sets. Every field optional — this is a patch. */
export interface BrandInput {
  appName?: string | null;
  shortName?: string | null;
  tagline?: string | null;
  palette?: BrandPalette | null;
  authCopy?: BrandAuthCopy | null;
  /**
   * Roles the organization WANTS. Intersected with what works.
   *
   * Accepts the LIST form as well as the record, so a resolved `BrandConfig`
   * can be fed straight back in. That is not a convenience: the build writes a
   * resolved block into the organization's configuration file and the DEVICE
   * re-resolves it on launch — `extra` is the one thing an attacker repacking
   * an APK can edit, so the app will not render from it unchecked. Without the
   * list form that second pass silently dropped every role but Student, and
   * the Teacher tab disappeared on real builds while every test that resolved
   * once still passed.
   */
  roles?: Partial<Record<BrandRole, boolean>> | readonly BrandRole[] | null;
  registrationPolicy?: RegistrationPolicy | null;
}

/** The complete, validated answer. Every field present. */
export interface BrandConfig {
  appName: string;
  shortName: string;
  tagline: string;
  palette: Required<{ [K in keyof BrandPalette]: string }>;
  authCopy: {
    welcomeTitle: string;
    welcomeSubtitle: string;
    loginMessage: string;
    registerMessage: string;
    supportEmail: string;
    supportPhone: string;
  };
  /** Roles this organization enabled AND the platform can authenticate. */
  roles: BrandRole[];
  /** Roles it asked for that the platform cannot deliver yet. */
  unsupportedRoles: BrandRole[];
  registrationPolicy: RegistrationPolicy;
}

/**
 * The neutral palette. Belongs to no customer.
 *
 * Shared with the app's `DEFAULT_BRAND`, which is why the values are repeated
 * rather than imported: this module has no dependencies by design, and the
 * drift check is what keeps the two honest.
 */
export const DEFAULT_PALETTE: Required<{ [K in keyof BrandPalette]: string }> = {
  primaryColor: '#4F46E5',
  secondaryColor: '#0EA5E9',
  accentColor: '#1E293B',
  backgroundColor: '#05070C',
  splashBackgroundColor: '#05070C',
  successColor: '#059669',
  warningColor: '#D97706',
  dangerColor: '#DC2626',
};

function colour(value: unknown, fallback: string): string {
  const candidate = text(value);
  if (!candidate) return fallback;
  const hex = candidate.startsWith('#') ? candidate : '#' + candidate;
  // Expanded here rather than left short, so every consumer receives the same
  // six-digit form and nothing downstream has to handle both.
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    return ('#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]).toUpperCase();
  }
  return HEX_COLOR_PATTERN.test(hex) ? hex.toUpperCase() : fallback;
}

/**
 * Trim, collapse whitespace and cap.
 *
 * Copy reaches a phone screen, so length is a layout concern rather than a
 * validation one — a 400-character tagline is not invalid, it is a broken
 * screen. Capping is the honest fix; refusing would just move the problem to
 * an administrator who cannot see why.
 */
function line(value: unknown, max: number, fallback = ''): string {
  const cleaned = text(value).replace(/\s+/g, ' ');
  if (!cleaned) return fallback;
  return cleaned.length > max ? cleaned.slice(0, max).trimEnd() : cleaned;
}

/** A short form of the name, for a tab bar or a mark. */
function shortenName(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return name;
  // Two words is already short; more than two and the first two carry it.
  return words.length === 2 ? name : words.slice(0, 2).join(' ');
}

/**
 * Resolve an organization's brand input into the complete configuration.
 *
 * Pure, total and idempotent: the same input always produces the same output,
 * missing fields become documented defaults rather than blanks, and resolving
 * an already-resolved config changes nothing. That is what lets the build, the
 * app and the preview run it independently and agree.
 */
export function resolveBrandConfig(input: BrandInput | null | undefined): BrandConfig {
  const source = input ?? {};
  const appName = line(source.appName, 60, 'Learning Platform');
  const tagline = line(source.tagline, 90);

  const p = source.palette ?? {};
  const palette = {
    primaryColor: colour(p.primaryColor, DEFAULT_PALETTE.primaryColor),
    secondaryColor: colour(p.secondaryColor, DEFAULT_PALETTE.secondaryColor),
    accentColor: colour(p.accentColor, DEFAULT_PALETTE.accentColor),
    backgroundColor: colour(p.backgroundColor, DEFAULT_PALETTE.backgroundColor),
    splashBackgroundColor: colour(
      p.splashBackgroundColor,
      // Falls back to the app background rather than to a constant: an
      // institute that set one dark base meant both, and a launch image in a
      // different black than the screen it hands over to is a visible seam.
      colour(p.backgroundColor, DEFAULT_PALETTE.splashBackgroundColor),
    ),
    successColor: colour(p.successColor, DEFAULT_PALETTE.successColor),
    warningColor: colour(p.warningColor, DEFAULT_PALETTE.warningColor),
    dangerColor: colour(p.dangerColor, DEFAULT_PALETTE.dangerColor),
  };

  const c = source.authCopy ?? {};
  // Closed unless the organization opened it. Public registration writes new
  // accounts into a tenant, so it is something an institute switches ON — an
  // organization that never answered the question must not be taking sign-ups
  // because a default answered it for them.
  const registrationPolicy: RegistrationPolicy =
    source.registrationPolicy === 'open' || source.registrationPolicy === 'approval'
      ? source.registrationPolicy
      : 'invite';

  const authCopy = {
    // The default names the institute rather than the product. "Welcome to
    // Client Platform" is the single most damaging string a white-label app
    // can ship, and the way it ships is as a fallback nobody reviewed.
    welcomeTitle: line(c.welcomeTitle, 70, appName ? `Welcome to ${appName}` : 'Welcome'),
    welcomeSubtitle: line(
      c.welcomeSubtitle,
      140,
      'Your classes, exams and results — all in one place.',
    ),
    loginMessage: line(c.loginMessage, 140, 'Sign in to continue.'),
    registerMessage: line(
      c.registerMessage,
      140,
      registrationPolicy === 'invite'
        ? 'Accounts here are created by your institute.'
        : 'Create your account to get started.',
    ),
    supportEmail: line(c.supportEmail, 120),
    supportPhone: line(c.supportPhone, 40),
  };

  const asked = source.roles ?? {};
  const wants = (role: BrandRole): boolean =>
    Array.isArray(asked)
      ? (asked as readonly BrandRole[]).includes(role)
      : (asked as Partial<Record<BrandRole, boolean>>)[role] === true;

  // Student is not optional, and this is the line that enforces it rather
  // than the comment that used to. An app whose organization switched off
  // every role has nobody who can sign in, and producing that silently is
  // worse than ignoring one setting.
  const requested = BRAND_ROLES.filter((role) => role === 'student' || wants(role));

  return {
    appName,
    shortName: line(source.shortName, 24, shortenName(appName)),
    tagline,
    palette,
    authCopy,
    roles: requested.filter((role) => SUPPORTED_AUTH_ROLES.includes(role)),
    unsupportedRoles: requested.filter((role) => !SUPPORTED_AUTH_ROLES.includes(role)),
    registrationPolicy,
  };
}
