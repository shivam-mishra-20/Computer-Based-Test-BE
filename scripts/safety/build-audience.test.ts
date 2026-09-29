/**
 * A build knows what it is for, and one rule bends for it.
 *
 * ── What this protects ──────────────────────────────────────────────────────
 * An organization's app can now be built for two audiences. A RELEASE must
 * reach its server over https; an INTERNAL TESTING build may point at a
 * plaintext address, so somebody can install an APK on their own phone and
 * talk to a laptop on the office network. That is one rule, relaxed for one
 * case, and everything about it is dangerous in the direction of being too
 * permissive:
 *
 *   · a profile parsed from a query string must never widen the rules;
 *   · the relaxation must apply to the transport rule and NOTHING else — a
 *     loopback address and a `pending:` organization id are mistakes in an
 *     internal build too;
 *   · the profile the console judged must be the profile the build runs under.
 *     It was not: eas.json set no APP_PROFILE, `EAS_BUILD_PROFILE` is the
 *     profile NAME (`org-test-apk`) which the app's validator does not accept,
 *     so every cloud build fell back to 'development' — the loosest rules
 *     there are — while the console reported on 'production'.
 *
 * None of this needs a database, a queue or Expo, so none of it is here.
 *
 *   npm run safety:build-audience
 */

import {
  BRAND_ROLES,
  resolveBrandConfig,
  SUPPORTED_AUTH_ROLES,
  parseBuildProfile,
  validateMobileIdentity,
  SELECTABLE_BUILD_PROFILES,
  type MobileBuildIdentity,
} from '../../src/core/platform/mobileBuildRules';
import { easJsonFor } from '../../src/core/platform/appBuildWorkspace';

let checks = 0;
let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  checks++;
  if (!ok) failures++;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label);
  if (!ok && detail) console.log('      ' + detail);
}

/** A complete, valid organization, so each case varies one thing. */
function identity(
  overrides: Partial<MobileBuildIdentity> = {},
): MobileBuildIdentity {
  return {
    orgId: '507f1f77bcf86cd799439011',
    slug: 'test-institute',
    appName: 'Test Institute',
    tagline: 'Excellence in every examination',
    androidPackage: 'com.platform.testinstitute',
    iosBundleId: 'com.platform.testinstitute',
    scheme: 'testinstitute',
    primaryColor: '#C2410C',
    secondaryColor: '#F59E0B',
    accentColor: '#7C2D12',
    backgroundColor: '#0B0705',
    apiBaseUrl: 'https://api.test.example.com/api',
    assetsPresent: true,
    ...overrides,
  } as MobileBuildIdentity;
}

const fieldsFailing = (
  id: MobileBuildIdentity,
  profile: 'production' | 'preview',
) => validateMobileIdentity(id, profile).map((i) => i.field);

console.log('\nBUILD AUDIENCE\n');

/* ── 1. Parsing a profile can only ever tighten ──────────────────────────── */

console.log('reading the audience from a request');

check('"preview" is accepted', parseBuildProfile('preview') === 'preview');
check(
  '"production" is accepted',
  parseBuildProfile('production') === 'production',
);
check(
  'case and padding do not matter',
  parseBuildProfile('  PREVIEW ') === 'preview',
);

for (const junk of [
  undefined,
  null,
  '',
  'development',
  'dev',
  'org-test-apk',
  'PRODUCTION!',
  42,
  {},
]) {
  check(
    `${JSON.stringify(junk)} falls back to the STRICT profile`,
    parseBuildProfile(junk) === 'production',
    'a parser that defaulted the other way would let a query string relax the rules',
  );
}

check(
  'development is not selectable at all',
  !(SELECTABLE_BUILD_PROFILES as readonly string[]).includes('development'),
  'it tolerates a missing address and a pending id — an installable artifact from one reaches nothing',
);

/* ── 2. Exactly one rule bends ───────────────────────────────────────────── */

console.log('\nwhat an internal build is allowed');

const plaintext = identity({ apiBaseUrl: 'http://192.168.29.188:5000/api' });

check(
  'a RELEASE refuses a plaintext address',
  fieldsFailing(plaintext, 'production').includes('apiBaseUrl'),
  'credentials over http on a student device is the thing this rule exists for',
);
check(
  'an INTERNAL build accepts one',
  fieldsFailing(plaintext, 'preview').length === 0,
  JSON.stringify(validateMobileIdentity(plaintext, 'preview')),
);

/* -- and nothing else does -- */

const cases: [string, MobileBuildIdentity, string][] = [
  [
    'a loopback address',
    identity({ apiBaseUrl: 'http://localhost:5000/api' }),
    'apiBaseUrl',
  ],
  [
    'the emulator alias',
    identity({ apiBaseUrl: 'http://10.0.2.2:5000/api' }),
    'apiBaseUrl',
  ],
  [
    'a pending organization id',
    identity({ orgId: 'pending:test-institute' }),
    'orgId',
  ],
  ['a missing address', identity({ apiBaseUrl: '' }), 'apiBaseUrl'],
  [
    'an address with no /api suffix',
    identity({ apiBaseUrl: 'http://192.168.29.188:5000' }),
    'apiBaseUrl',
  ],
  [
    'a package name the stores would refuse',
    identity({ androidPackage: 'Test App' }),
    'androidPackage',
  ],
  [
    'missing native assets',
    identity({ assetsPresent: false, missingAssets: ['icon.png'] }),
    'assets',
  ],
];

for (const [label, id, field] of cases) {
  check(
    `${label} is refused for an internal build too`,
    fieldsFailing(id, 'preview').includes(field),
    'preview relaxes the transport rule and no other: ' +
      JSON.stringify(fieldsFailing(id, 'preview')),
  );
}

check(
  'a valid release configuration is still valid',
  validateMobileIdentity(identity(), 'production').length === 0,
  JSON.stringify(validateMobileIdentity(identity(), 'production')),
);

/* ── 3. The build runs under the profile it was judged against ───────────── */

console.log('\nwhat the build is told');

const release = JSON.parse(
  easJsonFor({
    profileName: 'org-test-institute-apk',
    slug: 'test-institute',
    artifactType: 'apk',
    apiBaseUrl: 'https://api.test.example.com/api',
    appProfile: 'production',
  }),
).build['org-test-institute-apk'];

const internal = JSON.parse(
  easJsonFor({
    profileName: 'org-test-institute-apk',
    slug: 'test-institute',
    artifactType: 'apk',
    apiBaseUrl: 'http://192.168.29.188:5000/api',
    appProfile: 'preview',
  }),
).build['org-test-institute-apk'];

check(
  'a release build is told it is production',
  release.env.APP_PROFILE === 'production',
);
check(
  'an internal build is told it is preview',
  internal.env.APP_PROFILE === 'preview',
);
check(
  'APP_PROFILE is one of the three the app accepts',
  ['development', 'preview', 'production'].includes(internal.env.APP_PROFILE),
  'EAS_BUILD_PROFILE is the profile NAME and is not — which is why the fallback was silently development',
);
check(
  'the plaintext address reaches the build',
  internal.env.EXPO_PUBLIC_API_BASE_URL === 'http://192.168.29.188:5000/api',
);
check(
  'the organization still selects itself',
  internal.env.ORG_ID === 'test-institute' &&
    release.env.ORG_ID === 'test-institute',
);
check(
  'the audience does not change the artifact',
  release.android.buildType === 'apk' && internal.android.buildType === 'apk',
  'APK vs AAB is a separate decision and must stay one',
);

/* ── 5. What an organization owns, and what it cannot break ──────────────── */

console.log('\nthe brand an organization configures');

const blank = resolveBrandConfig(null);
check(
  'an organization that set nothing still gets a complete app',
  Boolean(
    blank.appName &&
      blank.authCopy.welcomeTitle &&
      blank.palette.primaryColor &&
      blank.roles.length,
  ),
  JSON.stringify(blank),
);
check(
  '...and its defaults name no vendor',
  !/client platform/i.test(JSON.stringify(blank)),
  'the single most damaging string a white-label app can ship, and it ships as a fallback nobody reviewed',
);

const brand = resolveBrandConfig({
  appName: '  Lakeside   Science  Academy  ',
  tagline: 'Science, taught properly',
  palette: { primaryColor: 'c2410c', secondaryColor: '#0af' },
  authCopy: { welcomeTitle: 'x'.repeat(400) },
  roles: { teacher: true, parent: true },
  registrationPolicy: 'invite',
});

check(
  'whitespace in a name is collapsed, not preserved',
  brand.appName === 'Lakeside Science Academy',
  brand.appName,
);
check(
  'a colour without a hash is still a colour',
  brand.palette.primaryColor === '#C2410C',
  brand.palette.primaryColor,
);
check(
  'a three-digit colour is expanded',
  brand.palette.secondaryColor === '#00AAFF',
  brand.palette.secondaryColor,
);
check(
  'copy is capped rather than refused',
  brand.authCopy.welcomeTitle.length <= 70,
  'a 400-character headline is not invalid, it is a broken screen — and refusing it tells an administrator nothing',
);
check(
  'the welcome default names the institute',
  resolveBrandConfig({ appName: 'Lakeside' }).authCopy.welcomeTitle ===
    'Welcome to Lakeside',
);
check(
  'a splash background falls back to the app background, not to a constant',
  resolveBrandConfig({ palette: { backgroundColor: '#101820' } }).palette
    .splashBackgroundColor === '#101820',
  'a launch image in a different black than the screen it hands over to is a visible seam',
);

check(
  'a requested role the platform can authenticate is enabled',
  brand.roles.includes('teacher') && brand.roles.includes('parent') && brand.unsupportedRoles.length === 0,
  JSON.stringify({ roles: brand.roles, unsupported: brand.unsupportedRoles }),
);
check(
  'parent is supported, in one place — since guardian links (2026-09-23)',
  BRAND_ROLES.includes('parent') && SUPPORTED_AUTH_ROLES.includes('parent'),
  'the backend now has a parent role, a verified parent-to-student link, and a parent-only API',
);
check(
  'a role nobody asked for stays off',
  !resolveBrandConfig({ roles: { teacher: true } }).roles.includes('parent'),
  'Parent is offered only when the organization turns it on',
);
check(
  'admin is never a role an app offers, whatever is asked',
  !resolveBrandConfig({ roles: { admin: true, teacher: true } as never }).roles.includes('admin' as never) &&
    !(BRAND_ROLES as readonly string[]).includes('admin'),
  'administrators are appointed by the institute, never self-registered',
);
check(
  'students cannot be switched off',
  resolveBrandConfig({
    roles: { student: false, teacher: true },
  }).roles.includes('student'),
  'an app with no role that can sign in has nobody to sign in',
);

check(
  'an unknown registration policy becomes the safe one — closed',
  resolveBrandConfig({ registrationPolicy: 'anything' as never })
    .registrationPolicy === 'invite',
  'public registration writes new accounts into a tenant; an unrecognised value must not open it',
);
check(
  'an organization that never answered is closed, not open',
  resolveBrandConfig({}).registrationPolicy === 'invite' &&
    resolveBrandConfig(null).registrationPolicy === 'invite',
  'opt-in: registration is something an institute switches ON',
);
check(
  'the invite policy changes what the register tab says',
  brand.registrationPolicy === 'invite' &&
    /created by your institute/i.test(brand.authCopy.registerMessage),
  brand.authCopy.registerMessage,
);

// -- Idempotent where it counts --------------------------------------------
// The build writes a RESOLVED block into the organization's configuration
// file, and the device resolves it AGAIN on launch rather than rendering from
// `extra` unchecked. So a second pass must not change what the app does.
//
// `unsupportedRoles` is the one field that legitimately differs, and it should:
// it reports what the INPUT asked for and could not have. Feeding a resolved
// config back in asks only for the roles that worked, so the list is correctly
// empty the second time. Asserting it stable would be asserting that a report
// about the request survives the request being different.
const second = resolveBrandConfig(brand as never);
check(
  'resolving an already-resolved brand does not change what the app does',
  JSON.stringify({ ...second, unsupportedRoles: [] }) ===
    JSON.stringify({ ...brand, unsupportedRoles: [] }),
  JSON.stringify({ first: brand, second }),
);
check(
  '...and the roles survive the round trip',
  second.roles.join(',') === brand.roles.join(','),
  'this is the one that broke: the record form lost every role but Student on the second pass, ' +
    'so the Teacher tab vanished on a real device while every single-pass test still passed',
);

console.log('\n  ' + (checks - failures) + '/' + checks + ' checks passed.\n');
process.exit(failures ? 1 : 0);
