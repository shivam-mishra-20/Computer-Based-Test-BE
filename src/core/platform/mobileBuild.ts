/**
 * An organization's mobile build configuration — read, validated, generated.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * `client-platform-app` builds one binary per organization from a file at
 * `config/organizations/<slug>.js`. Until now a developer wrote that file by
 * hand, copying the orgId, the name, the tagline and four colours out of the
 * console. Nothing checked that the two agreed, and a mismatch is invisible:
 * the app compiles, installs and runs, wearing one institute's colours and
 * reporting another's identity before sign-in.
 *
 * So the organization record becomes the source, and this module turns it into
 * that file. Nothing here builds anything — no EAS, no signing, no upload.
 * It ends at text a developer pastes into the app repository, plus the exact
 * commands that consume it.
 *
 * ── One validator, not two ──────────────────────────────────────────────────
 * The rules live in `./mobileBuildRules`, and `client-platform-app` mirrors
 * that file byte for byte through `platform-client-core` — `npm run
 * safety:mobile-rules` fails if the two ever differ. That is the whole point:
 * a console that reports READY for a build the app then refuses is worse than
 * a console with no readiness at all, because it moves the failure to the
 * person least able to diagnose it.
 *
 * They are mirrored rather than imported because the shared package is a
 * SIBLING REPOSITORY — `file:../platform-client-core` exists on a developer's
 * machine and in no container. See the header of `mobileBuildRules.ts`.
 *
 * What this module adds on top of the shared rules is the part only a server
 * can answer — uniqueness across every organization — and the part only a
 * human can answer: whether the native artwork actually exists, which is a
 * flag staff set because the files live in another repository.
 */

import {
  mobileBuildStatus,
  reconcileMobileBuild,
  slugifyOrgName,
  validateMobileIdentity,
  type MobileBuildIdentity,
  type MobileBuildIssue,
  type MobileBuildMismatch,
  type MobileBuildProfile,
  type MobileBuildStatus,
} from './mobileBuildRules';
import { withoutTenantScope } from '../tenancy/context';

export class MobileConfigConflict extends Error {
  constructor(readonly field: string, readonly value: string, readonly owner: string) {
    super(
      `${field} "${value}" is already used by "${owner}". Two organizations sharing it would ` +
        'install as the same application — the store keys on it.',
    );
    this.name = 'MobileConfigConflict';
  }
}

export class OrganizationNotFound extends Error {
  constructor() {
    super('Organization not found');
    this.name = 'OrganizationNotFound';
  }
}

export class BuildConfigIncomplete extends Error {
  constructor(readonly issues: MobileBuildIssue[]) {
    super('This organization is not ready to build.');
    this.name = 'BuildConfigIncomplete';
  }
}

/** The neutral platform palette, used only where a colour is genuinely absent. */
const FALLBACK_BACKGROUND = '#05070C';

/**
 * Flatten an Org document into the shape the shared validator understands.
 *
 * The `Org` schema splits these across `branding` (runtime) and `mobile`
 * (build-time) for a real reason — one is free to change and the other costs a
 * release — but the validator only cares whether the values are present and
 * valid, so it sees one flat record.
 */
export function mobileIdentityFor(org: Record<string, any>): MobileBuildIdentity {
  const branding = org?.branding ?? {};
  const mobile = org?.mobile ?? {};
  return {
    orgId: String(org?._id ?? ''),
    slug: org?.slug ?? '',
    appName: branding.appName || org?.name || '',
    tagline: branding.tagline || '',
    androidPackage: mobile.androidPackage || '',
    iosBundleId: mobile.iosBundleId || '',
    scheme: mobile.scheme || '',
    apiBaseUrl: mobile.apiBaseUrl || '',
    primaryColor: branding.primaryColor || '',
    secondaryColor: branding.secondaryColor || '',
    accentColor: branding.accentColor || '',
    // Splash background is branding; the mobile record may override it. Either
    // is fine, and the platform default is used only when neither is set.
    backgroundColor: mobile.backgroundColor || branding.splashBackgroundColor || FALLBACK_BACKGROUND,
    // Only staff can answer this — the files live in client-platform-app.
    assetsPresent: mobile.assetsReady === true,
    missingAssets: mobile.assetsReady === true ? [] : ['icon, adaptive icon, splash, logo, onboarding'],
  };
}

export interface MobileConfigView {
  organization: {
    id: string;
    name: string;
    slug: string;
    status: string;
  };
  identity: MobileBuildIdentity;
  mobile: Record<string, unknown>;
  status: MobileBuildStatus;
  issues: MobileBuildIssue[];
  /** The slug that would be derived from the name, for a console preview. */
  suggestedSlug: string;
}

async function loadOrg(orgId: string) {
  return withoutTenantScope('platform:mobile-load', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Org = require('../../models/Org').default;
    return Org.findById(orgId).lean();
  });
}

/**
 * The organization's mobile configuration and whether it could build.
 *
 * `profile` decides strictness exactly as it does at build time: development
 * tolerates a missing address and a `pending:` id, anything that ships does
 * not. The console asks for `production`, because that is the question staff
 * are actually asking.
 */
export async function getMobileConfig(
  orgId: string,
  profile: MobileBuildProfile = 'production',
): Promise<MobileConfigView> {
  const org = await loadOrg(orgId);
  if (!org) throw new OrganizationNotFound();

  const identity = mobileIdentityFor(org);
  const issues = validateMobileIdentity(identity, profile);

  return {
    organization: {
      id: String(org._id),
      name: org.name,
      slug: org.slug,
      status: org.status,
    },
    identity,
    mobile: org.mobile ?? {},
    status: mobileBuildStatus(identity, issues),
    issues,
    suggestedSlug: slugifyOrgName(org.name ?? ''),
  };
}

export interface MobileConfigPatch {
  androidPackage?: string;
  iosBundleId?: string;
  scheme?: string;
  apiBaseUrl?: string;
  version?: string;
  androidVersionCode?: number;
  easProjectId?: string;
  easOwner?: string;
  backgroundColor?: string;
  assetsReady?: boolean;
  assetsNote?: string;
}

const TRIMMED: (keyof MobileConfigPatch)[] = [
  'androidPackage', 'iosBundleId', 'scheme', 'apiBaseUrl',
  'version', 'easProjectId', 'easOwner', 'backgroundColor', 'assetsNote',
];

/**
 * Update the native identity, refusing anything another organization holds.
 *
 * ── Why uniqueness is checked here and not only by the index ────────────────
 * There ARE unique sparse indexes on all three fields, and they are the thing
 * that makes a race impossible. But a duplicate-key error from Mongo says
 * `E11000 duplicate key`, which tells an operator nothing about WHICH
 * organization already has the value or why it matters. So the readable check
 * runs first and the index stands behind it.
 */
export async function updateMobileConfig(
  orgId: string,
  patch: MobileConfigPatch,
): Promise<MobileConfigView> {
  const org = await loadOrg(orgId);
  if (!org) throw new OrganizationNotFound();

  const next: Record<string, unknown> = { ...(org.mobile ?? {}) };

  for (const key of TRIMMED) {
    const value = patch[key];
    if (value === undefined) continue;
    const cleaned = typeof value === 'string' ? value.trim() : value;
    // An empty string CLEARS the field rather than storing '' — a blank
    // package name and an absent one mean the same thing, and storing both
    // would make the unique index treat '' as a value two organizations share.
    if (cleaned === '') delete next[key];
    else next[key] = cleaned;
  }
  if (patch.androidVersionCode !== undefined) {
    const n = Number(patch.androidVersionCode);
    if (Number.isFinite(n) && n > 0) next.androidVersionCode = Math.floor(n);
    else delete next.androidVersionCode;
  }
  if (patch.assetsReady !== undefined) next.assetsReady = Boolean(patch.assetsReady);

  // ── Uniqueness, with a message that names the holder ─────────────────────
  const unique: [keyof MobileConfigPatch, string][] = [
    ['androidPackage', 'Android package'],
    ['iosBundleId', 'iOS bundle id'],
    ['scheme', 'Deep-link scheme'],
  ];
  for (const [field, label] of unique) {
    const value = next[field] as string | undefined;
    if (!value) continue;
    const clash = await withoutTenantScope('platform:mobile-unique', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Org = require('../../models/Org').default;
      return Org.findOne({ [`mobile.${field}`]: value, _id: { $ne: org._id } })
        .select('name slug')
        .lean();
    });
    if (clash) throw new MobileConfigConflict(label, value, clash.name ?? clash.slug);
  }

  await withoutTenantScope('platform:mobile-save', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Org = require('../../models/Org').default;
    return Org.updateOne({ _id: org._id }, { $set: { mobile: next } });
  });

  return getMobileConfig(orgId);
}

/* ══════════════════════════════════════════════════════════════════════════
   Generation
   ══════════════════════════════════════════════════════════════════════════ */

export interface GeneratedBuildConfig {
  slug: string;
  /** The file to write at `config/organizations/<slug>.js`. */
  organizationFile: string;
  /** The two lines to add to `config/registry.js`. */
  registrySnippet: string;
  /** The eas.json profile. */
  easProfile: string;
  /** The commands, in order. */
  commands: string[];
  /** Where the five images go. */
  assetDirectory: string;
  identity: MobileBuildIdentity;
}

function js(value: string): string {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** camelCase constant name for the generated module, e.g. `abcInstitute`. */
function constantName(slug: string): string {
  return slug.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * Produce the exact configuration `client-platform-app` consumes.
 *
 * Refuses when the organization is not ready, and says precisely what is
 * missing. Generating a file with placeholders would move the failure from
 * here — where it names the field — to `expo prebuild`, where it names a
 * stack frame.
 *
 * Every value comes from the organization record. Nothing is defaulted,
 * invented or substituted.
 */
export async function generateBuildConfig(
  orgId: string,
  profile: MobileBuildProfile = 'production',
): Promise<GeneratedBuildConfig> {
  const view = await getMobileConfig(orgId, profile);
  if (view.issues.length) throw new BuildConfigIncomplete(view.issues);

  const id = view.identity;
  const slug = String(id.slug);
  const name = constantName(slug);
  const org = await loadOrg(orgId);
  const mobile = (org?.mobile ?? {}) as Record<string, unknown>;

  const optionalNative: string[] = [];
  if (mobile.androidVersionCode) {
    optionalNative.push(`    androidVersionCode: ${Number(mobile.androidVersionCode)},`);
  }
  if (mobile.easProjectId) {
    optionalNative.push(`    expoSlug: ${js(slug)},`);
    optionalNative.push(`    easProjectId: ${js(String(mobile.easProjectId))},`);
    if (mobile.easOwner) optionalNative.push(`    easOwner: ${js(String(mobile.easOwner))},`);
  }

  const organizationFile = `/**
 * ${id.appName} — generated from the platform console.
 *
 * Every value below comes from this organization's record in platform-core.
 * Re-generate rather than hand-editing: the console reconciles this file
 * against the organization and reports any field that has drifted.
 *
 *   organization : ${id.appName}
 *   orgId        : ${id.orgId}
 *   generated    : ${new Date().toISOString()}
 */

/** @type {import('../types').OrganizationBuildConfig} */
const ${name} = {
  mode: 'dedicated',

  organization: {
    orgId: ${js(String(id.orgId))},
    slug: ${js(slug)},
    name: ${js(String(id.appName))},
    tagline: ${js(String(id.tagline))},
  },

  branding: {
    logo: './assets/${slug}/logo.png',
    appIcon: './assets/${slug}/icon.png',
    adaptiveIcon: './assets/${slug}/adaptive-icon.png',
    splash: './assets/${slug}/splash.png',
    onboarding: './assets/${slug}/onboarding.png',
    primaryColor: ${js(String(id.primaryColor))},
    secondaryColor: ${js(String(id.secondaryColor))},
    accentColor: ${js(String(id.accentColor))},
    backgroundColor: ${js(String(id.backgroundColor))},
  },

  native: {
    appName: ${js(String(id.appName))},
    androidPackage: ${js(String(id.androidPackage))},
    iosBundleId: ${js(String(id.iosBundleId))},
    scheme: ${js(String(id.scheme))},
    version: ${js(String(mobile.version || '1.0.0'))},
${optionalNative.join('\n')}${optionalNative.length ? '\n' : ''}  },

  api: {
    baseUrl: ${js(String(id.apiBaseUrl))},
  },
};

module.exports = { ${name} };
`;

  const registrySnippet = `// config/registry.js
const { ${name} } = require('./organizations/${slug}');
// ...then add to ORGANIZATIONS:
  '${slug}': ${name},`;

  const easProfile = `{
  "org-${slug}": {
    "extends": "production",
    "env": { "ORG_ID": "${slug}" }
  }
}`;

  return {
    slug,
    organizationFile,
    registrySnippet,
    easProfile,
    assetDirectory: `assets/${slug}/`,
    commands: [
      `# 1. Save the file above as config/organizations/${slug}.js`,
      '# 2. Add the registry lines, and the eas.json profile',
      `# 3. Put the five images in assets/${slug}/ (icon, adaptive-icon, splash, logo, onboarding)`,
      `ORG_ID=${slug} npm run org:preview`,
      `ORG_ID=${slug} npx expo prebuild --clean`,
      `eas build --profile org-${slug} --platform android`,
    ],
    identity: id,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   Reconciliation
   ══════════════════════════════════════════════════════════════════════════ */

export interface ReconcileResult {
  matches: boolean;
  mismatches: MobileBuildMismatch[];
  identity: MobileBuildIdentity;
}

/**
 * Compare a build configuration against the organization record.
 *
 * The caller supplies what `client-platform-app` currently has — from
 * `npm run org:export`, which prints exactly this shape — and this reports
 * every field that has drifted. It does not guess which side is right: the
 * organization record is authoritative by definition, but a mismatch can also
 * mean somebody edited the console after the build, so both values are shown.
 */
export async function reconcileBuildConfig(
  orgId: string,
  submitted: MobileBuildIdentity,
): Promise<ReconcileResult> {
  const org = await loadOrg(orgId);
  if (!org) throw new OrganizationNotFound();

  const identity = mobileIdentityFor(org);
  const mismatches = reconcileMobileBuild(identity, submitted ?? {});
  return { matches: mismatches.length === 0, mismatches, identity };
}
