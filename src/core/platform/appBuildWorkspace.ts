/**
 * A disposable, single-organization copy of the mobile app project.
 *
 * ── Why a workspace and not the checkout ────────────────────────────────────
 * The obvious implementation writes `config/organizations/<slug>.js` into
 * `client-platform-app`, patches `config/registry.js`, appends a profile to
 * `eas.json` and runs the build there. It is also the implementation that
 * makes two builds at once corrupt each other, leaves a developer's working
 * tree dirty after every console click, and — worst — leaves every other
 * organization's configuration sitting in the directory being uploaded.
 *
 * So each build gets its own directory, assembled from scratch, containing
 * exactly one institute's identity. Organization isolation stops being a rule
 * somebody has to follow and becomes a property of what is on disk: there is
 * no file in the workspace describing Organization B, so a build of
 * Organization A cannot pick one up. Section 10 asks for explicit verification
 * as well, and `verifyWorkspaceIdentity` provides it — but the structure is
 * what makes the verification almost always redundant, which is the point.
 *
 * ── node_modules is linked, not copied ──────────────────────────────────────
 * The EAS CLI evaluates `app.config.ts` locally before it uploads anything,
 * which needs the project's dependencies present. Copying several hundred
 * megabytes per build to achieve that would be absurd, so the workspace gets a
 * link to the source project's `node_modules`. Nothing writes through it, and
 * it is excluded from the upload by the project's own ignore rules.
 *
 * ── No git, ever ────────────────────────────────────────────────────────────
 * Nothing here clones, checks out, commits, pushes or fetches. The workspace is
 * a file copy of a directory that already exists on the build host, and the CLI
 * is told so with `EAS_NO_VCS=1`. A build system that pushes to a repository to
 * trigger itself is a build system that can rewrite history by accident.
 */

import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import { generateBuildConfig, type GeneratedBuildConfig } from './mobileBuild';
import { materializeNativeAssets, appProjectPath } from './mobileAssets';
import type { BuildArtifactType } from '../../models/AppBuildJob';
import type { SelectableBuildProfile } from './mobileBuildRules';

export class WorkspaceUnavailable extends Error {
  readonly code = 'WORKSPACE_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceUnavailable';
  }
}

export class IdentityMismatch extends Error {
  readonly code = 'IDENTITY_MISMATCH';
  constructor(message: string, readonly detail: string) {
    super(message);
    this.name = 'IdentityMismatch';
  }
}

/**
 * What is copied from the source project.
 *
 * An allow-list, not a deny-list. A deny-list means the day somebody adds a
 * directory to the app repository, it silently starts being copied into every
 * build — and the one directory that must never be copied wholesale is
 * `config/organizations`, which holds every other institute.
 */
const COPIED_ENTRIES = [
  'app',
  'components',
  'lib',
  'vendor',
  'scripts',
  'app.config.ts',
  'babel.config.js',
  'tsconfig.json',
  'package.json',
  'package-lock.json',
];

/** Copied from `config/` — everything EXCEPT other organizations. */
const COPIED_CONFIG_ENTRIES = [
  'registry.d.ts',
  'resolve.js',
  'resolve.d.ts',
  'types.d.ts',
  // A config plugin app.config.ts names by path. Left out, `expo prebuild`
  // fails to resolve './config/withCleartextTraffic' and the whole build dies
  // in the config phase — this list is not a convenience, it is the file set.
  'withCleartextTraffic.js',
];

/**
 * The generic build's own config, which the registry's default key needs.
 *
 * It carries no orgId by construction — `assertRegistryIsSound` refuses a
 * generic entry that has one — so including it cannot leak another institute.
 */
const GENERIC_ORG_FILE = 'platform.js';

async function copyEntry(from: string, to: string): Promise<void> {
  const stat = await fs.stat(from).catch(() => null);
  if (!stat) return;
  if (stat.isDirectory()) {
    await fs.cp(from, to, { recursive: true });
    return;
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

export interface PreparedWorkspace {
  root: string;
  slug: string;
  profileName: string;
  appProfile: SelectableBuildProfile;
  generated: GeneratedBuildConfig;
  configHash: string;
  assets: { kind: string; source: string; bytes: number }[];
}

/** `org-abc-institute-apk`. The artifact type is in the name because the two
 *  are different EAS configurations, not one profile with a flag. */
export function profileNameFor(slug: string, artifactType: BuildArtifactType): string {
  return `org-${slug}-${artifactType}`;
}

/**
 * The eas.json this build runs under.
 *
 * Generated whole rather than appended to, because the workspace has no
 * eas.json until this writes one — which also means a profile cannot be
 * inherited by accident from a file somebody edited months ago.
 *
 * APK and AAB differ in exactly one place, and it is the place EAS documents:
 * `android.buildType`. `apk` produces an installable *.apk; `app-bundle`
 * produces the *.aab Play accepts and a device will not install. Renaming one
 * to the other produces a file that fails at the moment it matters.
 */
export function easJsonFor(input: {
  profileName: string;
  slug: string;
  artifactType: BuildArtifactType;
  apiBaseUrl: string;
  appProfile: SelectableBuildProfile;
}): string {
  const androidBuildType = input.artifactType === 'apk' ? 'apk' : 'app-bundle';
  const config = {
    cli: { version: '>= 5.0.0', appVersionSource: 'remote' },
    build: {
      [input.profileName]: {
        // `internal` so an APK can be downloaded and sideloaded for testing.
        // An AAB is not installable either way; the distribution only decides
        // whether EAS hands back a link, and for both artifacts we want one.
        distribution: 'internal',
        autoIncrement: true,
        android: { buildType: androidBuildType },
        env: {
          ORG_ID: input.slug,
          EXPO_PUBLIC_API_BASE_URL: input.apiBaseUrl,
          // -- Why this is set explicitly ---------------------------------
          // config/resolve.js in the app reads APP_PROFILE, then falls back
          // to EAS_BUILD_PROFILE, then to 'development'. EAS sets
          // EAS_BUILD_PROFILE to the profile NAME — `org-test-apk` — which is
          // not one of the three it accepts, so without this line every cloud
          // build silently validated itself as 'development' while the console
          // had gated it on 'production'. Two validators, two answers, and the
          // console's was the one nobody could act on.
          APP_PROFILE: input.appProfile,
        },
      },
    },
    submit: {},
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** A registry naming exactly two builds: the generic one, and this institute. */
export function registryFor(slug: string, constantName: string): string {
  return `/**
 * Generated for a single build. Do not edit.
 *
 * This registry contains ONE organization plus the generic build. Every other
 * institute is absent from this workspace entirely, which is what makes it
 * impossible for this build to compile in the wrong identity.
 */

const { platform } = require('./organizations/platform');
const { ${constantName} } = require('./organizations/${slug}');

const ORGANIZATIONS = {
  platform,
  '${slug}': ${constantName},
};

const DEFAULT_ORG_KEY = 'platform';

function organizationKeys() {
  return Object.keys(ORGANIZATIONS);
}

function assertRegistryIsSound() {
  const problems = [];
  const seen = { androidPackage: {}, iosBundleId: {}, scheme: {}, slug: {} };

  for (const [key, config] of Object.entries(ORGANIZATIONS)) {
    const fields = [
      ['androidPackage', config.native.androidPackage],
      ['iosBundleId', config.native.iosBundleId],
      ['scheme', config.native.scheme],
    ];
    if (config.organization.slug) fields.push(['slug', config.organization.slug]);

    for (const [field, value] of fields) {
      if (!value) {
        problems.push(key + ': native.' + field + ' is empty');
        continue;
      }
      const owner = seen[field][value];
      if (owner) {
        problems.push(
          field + ' "' + value + '" is claimed by both "' + owner + '" and "' + key + '"',
        );
      } else {
        seen[field][value] = key;
      }
    }

    if (config.mode === 'dedicated' && config.organization.slug !== key) {
      problems.push(key + ': registry key and organization.slug must match');
    }
    if (config.mode === 'generic' && config.organization.orgId) {
      problems.push(key + ': a generic build must not compile in an orgId');
    }
  }

  if (problems.length) {
    throw new Error('Organization registry is not sound:\\n  - ' + problems.join('\\n  - '));
  }
}

module.exports = { ORGANIZATIONS, DEFAULT_ORG_KEY, organizationKeys, assertRegistryIsSound };
`;
}

/**
 * What is kept out of the upload.
 *
 * ── Every directory pattern is ROOT-ANCHORED, and that is the whole point ───
 * These follow .gitignore matching, where a pattern without a leading slash
 * matches a directory of that name at ANY depth. An unanchored `dist/` was
 * meant to drop the app's own web export; what it actually dropped was
 * `vendor/client-core/dist/` as well — the compiled output of the local
 * `file:` dependency that `app.config.ts` transitively imports.
 *
 * The workspace on disk was correct and the archive was not, so the build died
 * on EAS with `Cannot find module .../@platform/client-core/dist/index.js`
 * after a clean install — about as far from the cause as a message can get.
 * Anchoring says "the one at the top", which is what was always meant.
 *
 * `node_modules/` stays unanchored on purpose: a nested one is never wanted
 * either, and EAS installs dependencies itself.
 */
export function easIgnoreFor(): string {
  return ['node_modules/', '/android/', '/ios/', '/dist/', '/.expo/', '*.log'].join('\n') + '\n';
}

/**
 * Would this workspace-relative path be excluded from the upload?
 *
 * Only the pattern forms this file emits are handled — anchored directories,
 * bare directories, and a `*.ext` leaf. Deliberately: this exists to check OUR
 * ignore file against OUR entry points, not to reimplement gitignore.
 */
export function isIgnoredByEasignore(relPath: string, patterns: string[]): boolean {
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  const file = parts[parts.length - 1] ?? '';

  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern || pattern.startsWith('#')) continue;

    if (pattern.startsWith('*.')) {
      if (file.endsWith(pattern.slice(1))) return true;
      continue;
    }

    const anchored = pattern.startsWith('/');
    const name = pattern.replace(/^\//, '').replace(/\/$/, '');
    if (!name) continue;

    if (anchored) {
      if (parts[0] === name) return true;
      continue;
    }
    // Unanchored: matches that name at any depth — the bug this guards.
    if (parts.includes(name)) return true;
  }
  return false;
}

/** camelCase constant name, matching what `generateBuildConfig` emits. */
function constantNameFor(slug: string): string {
  return slug.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function workspaceRootFor(buildId: string): string {
  return path.join(os.tmpdir(), 'central-be-app-builds', String(buildId));
}

/**
 * Assemble everything this build needs, and nothing belonging to anyone else.
 */
export async function prepareWorkspace(input: {
  orgId: string;
  buildId: string;
  artifactType: BuildArtifactType;
  /** What the job recorded. Defaults to the strict profile. */
  appProfile?: SelectableBuildProfile;
  onProgress?: (message: string) => Promise<void> | void;
}): Promise<PreparedWorkspace> {
  const appProfile = input.appProfile ?? 'production';
  const source = appProjectPath();
  if (!source) {
    throw new WorkspaceUnavailable(
      'This server does not know where the mobile app project is. Set CLIENT_APP_PATH on the build host to the client-platform-app directory.',
    );
  }
  const sourceStat = await fs.stat(path.join(source, 'app.config.ts')).catch(() => null);
  if (!sourceStat) {
    throw new WorkspaceUnavailable(
      `CLIENT_APP_PATH does not look like the mobile app project — no app.config.ts under ${source}.`,
    );
  }

  await input.onProgress?.('Generating configuration');
  // Throws BuildConfigIncomplete, naming the field, when the organization is
  // not ready. Deliberately before any file is written.
  const generated = await generateBuildConfig(input.orgId, appProfile);
  const slug = generated.slug;
  const profileName = profileNameFor(slug, input.artifactType);

  const root = workspaceRootFor(input.buildId);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });

  await input.onProgress?.('Preparing build workspace');
  for (const entry of COPIED_ENTRIES) {
    await copyEntry(path.join(source, entry), path.join(root, entry));
  }
  for (const entry of COPIED_CONFIG_ENTRIES) {
    await copyEntry(path.join(source, 'config', entry), path.join(root, 'config', entry));
  }
  await copyEntry(
    path.join(source, 'config', 'organizations', GENERIC_ORG_FILE),
    path.join(root, 'config', 'organizations', GENERIC_ORG_FILE),
  );
  // The generic build's own five images, which platform.js references.
  await copyEntry(path.join(source, 'assets', 'platform'), path.join(root, 'assets', 'platform'));

  // Dependencies are shared, not duplicated. A junction on Windows and a
  // directory symlink elsewhere; a copy only if the platform refuses both.
  const modulesTarget = path.join(root, 'node_modules');
  const modulesSource = path.join(source, 'node_modules');
  if (await fs.stat(modulesSource).then(() => true).catch(() => false)) {
    try {
      await fs.symlink(modulesSource, modulesTarget, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      throw new WorkspaceUnavailable(
        'The build workspace could not link the app project dependencies. Run npm install in CLIENT_APP_PATH, ' +
          'and make sure this process may create symbolic links.',
      );
    }
  } else {
    throw new WorkspaceUnavailable(
      `The mobile app project has no node_modules. Run npm install in ${source} once, on the build host.`,
    );
  }

  await input.onProgress?.('Writing organization configuration');
  await fs.mkdir(path.join(root, 'config', 'organizations'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'config', 'organizations', `${slug}.js`),
    generated.organizationFile,
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'config', 'registry.js'),
    registryFor(slug, constantNameFor(slug)),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'eas.json'),
    easJsonFor({
      profileName,
      slug,
      artifactType: input.artifactType,
      apiBaseUrl: String(generated.identity.apiBaseUrl ?? ''),
      appProfile,
    }),
    'utf8',
  );
  await fs.writeFile(path.join(root, '.easignore'), easIgnoreFor(), 'utf8');

  await input.onProgress?.('Resolving native assets');
  const assets = await materializeNativeAssets(input.orgId, slug, root);

  const configHash = crypto
    .createHash('sha256')
    .update(generated.organizationFile)
    .digest('hex')
    .slice(0, 16);

  return { root, slug, profileName, appProfile, generated, configHash, assets };
}

/**
 * Rewrite the organization's config file in a prepared workspace.
 *
 * Used after an EAS project has just been created: the file written during
 * preparation predates the project, so it does not name it, and `app.config.ts`
 * reads `native.easProjectId` to populate `extra.eas.projectId`. Regenerating
 * with the same function keeps one description of what the file looks like —
 * patching a line into it would be a second.
 */
export async function rewriteOrganizationConfig(
  workspace: PreparedWorkspace,
  orgId: string,
): Promise<void> {
  // The SAME profile the workspace was prepared under. Hardcoding 'production'
  // here meant an internal-testing build passed preparation and then threw
  // BuildConfigIncomplete the moment its EAS project was created — a build that
  // failed halfway for a rule it had already been judged against.
  const regenerated = await generateBuildConfig(orgId, workspace.appProfile);
  await fs.writeFile(
    path.join(workspace.root, 'config', 'organizations', `${workspace.slug}.js`),
    regenerated.organizationFile,
    'utf8',
  );
}

export class WorkspaceDependencyMissing extends Error {
  readonly code = 'WORKSPACE_DEPENDENCY_MISSING';
  constructor(message: string, readonly detail: string) {
    super(message);
    this.name = 'WorkspaceDependencyMissing';
  }
}

/** Entry points a package declares, as workspace-relative paths. */
function declaredEntryPoints(pkg: Record<string, any>): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) out.push(value.trim());
  };

  // `main`, `module` and `types` are ALWAYS paths, and are conventionally
  // written without a leading `./` — `"main": "dist/index.js"`. Requiring the
  // dot here is how the first version of this check missed the very entry
  // point it was written for.
  add(pkg.main);
  add(pkg.module);
  add(pkg.types ?? pkg.typings);

  // `exports` can be a string, a map of conditions, or a map of subpaths to
  // either. Walked rather than special-cased, because a package that declares
  // one entry point this system cannot see is a package that fails on EAS.
  // An `exports` target must start with `./` per the specification, which is
  // what separates a file from a condition name like "import" or "default".
  const walk = (node: unknown) => {
    if (typeof node === 'string') {
      if (node.startsWith('./')) add(node);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const value of Object.values(node as Record<string, unknown>)) walk(value);
  };
  walk(pkg.exports);

  return [...new Set(out)];
}

/**
 * Prove every local dependency will still be a working package after upload.
 *
 * ── The failure this replaces ───────────────────────────────────────────────
 * `@platform/client-core` is a `file:` dependency whose `main` is
 * `dist/index.js` — compiled output that lives beside its source. The
 * workspace had it, the ARCHIVE did not, and the first thing that noticed was
 * EAS, twelve seconds into a clean install, with:
 *
 *   Cannot find module '/home/expo/workingdir/build/node_modules/@platform/client-core/dist/index.js'
 *
 * That message is true and useless: it names a path inside a container, on a
 * machine nobody has, for a file that was present on the machine that built
 * the workspace. So the check runs here instead, where it can name the package,
 * the entry point and the reason.
 *
 * ── Two things are checked, not one ─────────────────────────────────────────
 * That the file EXISTS, and that nothing in `.easignore` would strip it on the
 * way up. The second is what actually went wrong, and a check for existence
 * alone would have passed happily while the build kept failing.
 */
export async function verifyWorkspaceDependencies(workspace: PreparedWorkspace): Promise<void> {
  const problems: string[] = [];

  const rootPkgRaw = await fs.readFile(path.join(workspace.root, 'package.json'), 'utf8');
  const rootPkg = JSON.parse(rootPkgRaw) as { dependencies?: Record<string, string> };

  const ignoreRaw = await fs
    .readFile(path.join(workspace.root, '.easignore'), 'utf8')
    .catch(() => '');
  const ignorePatterns = ignoreRaw.split(/\r?\n/);

  for (const [name, spec] of Object.entries(rootPkg.dependencies ?? {})) {
    if (!String(spec).startsWith('file:')) continue;

    const relDir = String(spec).slice('file:'.length).replace(/^\.\//, '');
    const pkgDir = path.join(workspace.root, relDir);

    let localPkg: Record<string, any>;
    try {
      localPkg = JSON.parse(await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8'));
    } catch {
      problems.push(`${name}: no package.json at ${relDir}/`);
      continue;
    }

    const entries = declaredEntryPoints(localPkg);
    if (entries.length === 0) {
      // No declared entry point means Node falls back to index.js.
      entries.push('./index.js');
    }

    for (const entry of entries) {
      const relFromRoot = path.posix.join(relDir.replace(/\\/g, '/'), entry.replace(/^\.\//, ''));
      const onDisk = path.join(workspace.root, relFromRoot);

      const exists = await fs.stat(onDisk).then((st) => st.isFile()).catch(() => false);
      if (!exists) {
        problems.push(
          `${name}: its package.json points "${entry}" at ${relFromRoot}, which does not exist in the build. ` +
            `Build the package so its output is present before a build runs.`,
        );
        continue;
      }

      if (isIgnoredByEasignore(relFromRoot, ignorePatterns)) {
        problems.push(
          `${name}: ${relFromRoot} exists but .easignore would strip it from the upload, ` +
            `so the build would install a package whose "${entry}" is missing.`,
        );
      }
    }
  }

  if (problems.length) {
    throw new WorkspaceDependencyMissing(
      `The build is missing part of ${problems.length === 1 ? 'a dependency' : 'its dependencies'}: ${problems[0]}`,
      problems.join('\n'),
    );
  }
}

/**
 * Prove the workspace describes the organization this build is for.
 *
 * Section 10 asks for this explicitly, and it is worth having even though the
 * structure already guarantees it: the check is cheap, it runs before a single
 * EAS minute is spent, and it turns "we are confident this cannot happen" into
 * a line in the build record. It reads the file back off disk rather than
 * trusting the value it just wrote, because the only version that matters is
 * the one that will be uploaded.
 */
export async function verifyWorkspaceIdentity(
  workspace: PreparedWorkspace,
  expected: { orgId: string; androidPackage: string; scheme: string; appName: string },
): Promise<void> {
  const file = await fs.readFile(
    path.join(workspace.root, 'config', 'organizations', `${workspace.slug}.js`),
    'utf8',
  );

  const problems: string[] = [];
  const mustContain: [string, string][] = [
    ['orgId', expected.orgId],
    ['androidPackage', expected.androidPackage],
    ['scheme', expected.scheme],
  ];
  for (const [field, value] of mustContain) {
    if (!value) continue;
    if (!file.includes(`'${value}'`)) problems.push(`${field} "${value}" is not in the generated config`);
  }

  // Nothing describing another institute may be present at all.
  const orgDir = path.join(workspace.root, 'config', 'organizations');
  const present = await fs.readdir(orgDir);
  const allowed = new Set([GENERIC_ORG_FILE, `${workspace.slug}.js`]);
  for (const entry of present) {
    if (!allowed.has(entry)) problems.push(`another organization's config is in the workspace: ${entry}`);
  }

  const assetDirs = await fs.readdir(path.join(workspace.root, 'assets')).catch(() => []);
  for (const entry of assetDirs) {
    if (entry !== 'platform' && entry !== workspace.slug) {
      problems.push(`another organization's assets are in the workspace: assets/${entry}`);
    }
  }

  if (problems.length) {
    throw new IdentityMismatch(
      'The prepared build did not match this organization, so it was not sent to EAS.',
      problems.join('; '),
    );
  }
}

/**
 * A minimal directory that names ONE EAS project, for status queries.
 *
 * ── Why polling needs its own context ───────────────────────────────────────
 * `eas build:view <id>` resolves the project from the app config in its
 * working directory before it looks anything up. The build workspace is gone
 * by then — deliberately, it is a copy of the whole app project — and the real
 * checkout is the wrong answer: it has no ORG_ID, so its config resolves to
 * the generic build and the CLI looks for the build in a project that does not
 * contain it. Observed as "Could not read the build status from EAS" on a
 * build that was running perfectly well.
 *
 * So a poll gets four lines of `app.json` naming the project it is asking
 * about. Static JSON on purpose: the CLI reads it without evaluating anything,
 * and there is no registry, no organization file and no way for it to resolve
 * to somebody else's project.
 */
export async function pollContextRoot(projectId: string, slug: string): Promise<string> {
  const root = path.join(os.tmpdir(), 'central-be-app-builds', `poll-${projectId}`);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, 'app.json'),
    `${JSON.stringify(
      { expo: { name: slug, slug, extra: { eas: { projectId } } } },
      null,
      2,
    )}
`,
    'utf8',
  );
  // A `package.json` too: without one the CLI refuses with "Run this command
  // inside a project directory" before it looks at the app config at all.
  await fs.writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'eas-poll-context', version: '1.0.0', private: true }, null, 2)}
`,
    'utf8',
  );
  return root;
}

/** Remove a finished build's workspace. Failure to clean is never fatal. */
export async function discardWorkspace(buildId: string): Promise<void> {
  const root = workspaceRootFor(buildId);
  try {
    // The linked node_modules must go first, or a recursive remove would
    // follow the junction and delete the source project's dependencies.
    await fs.rm(path.join(root, 'node_modules'), { recursive: false, force: true }).catch(() => {});
    await fs.unlink(path.join(root, 'node_modules')).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  } catch {
    // A workspace left behind costs disk, not correctness.
  }
}
