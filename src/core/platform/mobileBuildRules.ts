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
