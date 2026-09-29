/**
 * The EAS CLI, as a small set of functions the build worker can call.
 *
 * ── Why a CLI and not the API ───────────────────────────────────────────────
 * Expo's build API is not public or stable; the CLI is the supported surface
 * and is what `eas build` means everywhere else. It also owns the parts nobody
 * should reimplement: archiving the project, uploading it, resolving the
 * project id, and applying whatever credentials the Expo account holds.
 *
 * ── Why every call is `--non-interactive --json` ────────────────────────────
 * A worker has no terminal. Without `--non-interactive` the CLI will stop and
 * ask — for a project to link, for credentials to generate — and a job that
 * blocks on a prompt nobody can see looks exactly like a hung build. `--json`
 * is what makes the reply parseable rather than scraped; combined with
 * `--no-wait` the worker gets a build id in seconds and polls for the rest,
 * which is what keeps a forty-minute Android build out of a Node process.
 *
 * ── The token ───────────────────────────────────────────────────────────────
 * `EXPO_TOKEN` is read here and passed to the child process environment. It is
 * never logged, never returned, and never reaches a response body — see
 * `redactEnv` below and `publicBuildView` in `appBuilds.ts`. This module is
 * the only place in the codebase that reads it.
 *
 * ── The seam ────────────────────────────────────────────────────────────────
 * Everything below goes through `runEas`, which is replaceable with
 * `__setEasRunner` in tests. That is deliberate: a real Android build costs
 * real minutes on Expo's infrastructure, so the pipeline's LOGIC is tested
 * against a scripted CLI, and the CLI itself is exercised by a separate smoke
 * test that a human runs on purpose (`npm run smoke:eas-build`). Faking a
 * successful build and calling that end-to-end would prove nothing.
 */

import { spawn } from 'child_process';

export class EasNotConfigured extends Error {
  readonly code = 'EAS_NOT_CONFIGURED';
  constructor(message: string) {
    super(message);
    this.name = 'EasNotConfigured';
  }
}

export class EasCommandFailed extends Error {
  readonly code = 'EAS_COMMAND_FAILED';
  constructor(
    message: string,
    /** Kept server-side for debugging; never returned to a browser. */
    readonly detail: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'EasCommandFailed';
  }
}

export interface EasRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type EasRunner = (
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string> },
) => Promise<EasRunResult>;

/**
 * How the CLI is invoked.
 *
 * `EAS_CLI_COMMAND` exists because there is no single right answer: a
 * container may have `eas` on the PATH, a developer machine usually does not
 * and wants `npx eas-cli`. The default is the one that works without a global
 * install; pinning a version in the env is recommended for a build host, so a
 * CLI release never changes what a build does without anyone deciding to.
 */
function easCommand(): string[] {
  const configured = String(process.env.EAS_CLI_COMMAND || '').trim();
  if (configured) return configured.split(/\s+/);
  return ['npx', '--yes', 'eas-cli@latest'];
}

/** The token, or a refusal that names the variable rather than a stack frame. */
export function requireExpoToken(): string {
  const token = String(process.env.EXPO_TOKEN || '').trim();
  if (!token) {
    throw new EasNotConfigured(
      'This server has no Expo access token, so it cannot start a cloud build. ' +
        'Set EXPO_TOKEN on the build host to a token from expo.dev → Account settings → Access tokens.',
    );
  }
  return token;
}

export function isEasConfigured(): boolean {
  return Boolean(String(process.env.EXPO_TOKEN || '').trim());
}

/**
 * Strip anything secret from text that may be stored or shown.
 *
 * The CLI echoes its own environment in some failure modes, and a build log is
 * the single most likely place for a token to escape. Cheap, and the cost of
 * being wrong is an Expo account.
 */
export function redactSecrets(text: string): string {
  const token = String(process.env.EXPO_TOKEN || '').trim();
  let out = String(text ?? '');
  if (token) out = out.split(token).join('«EXPO_TOKEN»');
  return out.replace(/\b[A-Za-z0-9_-]{2,}\.(?:[A-Za-z0-9_-]{20,})\b/g, '«redacted»');
}

let runner: EasRunner | null = null;

/** Test seam. Pass null to restore the real CLI. */
export function __setEasRunner(fn: EasRunner | null): void {
  runner = fn;
}

const defaultRunner: EasRunner = (args, { cwd, timeoutMs, env: extraEnv }) =>
  new Promise((resolve, reject) => {
    const [command, ...base] = easCommand();
    const child = spawn(command, [...base, ...args], {
      cwd,
      env: {
        ...process.env,
        EXPO_TOKEN: requireExpoToken(),
        // The CLI refuses to build from a dirty or missing working copy unless
        // told the caller is not using version control for this. The worker
        // builds from a generated workspace on purpose — see
        // appBuildWorkspace.ts — and this system performs no git operations.
        EAS_NO_VCS: '1',
        // Without this the CLI tries `git rev-parse --show-toplevel`, fails
        // (the workspace is not a repository, deliberately), and falls back to
        // the current working directory with a warning. Naming the root makes
        // that explicit instead of accidental.
        EAS_PROJECT_ROOT: cwd,
        CI: '1',
        ...(extraEnv ?? {}),
      },
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new EasCommandFailed('The EAS CLI did not respond in time.', redactSecrets(stderr || stdout), null));
    }, timeoutMs);

    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new EasNotConfigured(
          `The EAS CLI could not be started (${err.message}). Install it on the build host, ` +
            'or set EAS_CLI_COMMAND to how it should be invoked.',
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });

async function runEas(
  args: string[],
  cwd: string,
  timeoutMs = 15 * 60 * 1000,
  env?: Record<string, string>,
): Promise<EasRunResult> {
  const run = runner ?? defaultRunner;
  return run(args, { cwd, timeoutMs, env });
}

/** The CLI prints progress before its JSON; take the last JSON value present. */
function parseJson(stdout: string): unknown {
  const text = String(stdout ?? '').trim();
  if (!text) throw new Error('empty output');
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to scanning.
  }
  const start = Math.max(text.lastIndexOf('\n['), text.lastIndexOf('\n{'));
  const candidate = start >= 0 ? text.slice(start + 1) : text;
  return JSON.parse(candidate);
}

export interface EasBuild {
  id: string;
  /** EAS's own vocabulary: NEW, IN_QUEUE, IN_PROGRESS, FINISHED, ERRORED, CANCELED. */
  status: string;
  buildUrl?: string;
  artifactUrl?: string;
  /** Present on a failure, e.g. `EAS_BUILD_GRADLE_BUILD_FAILED`. */
  errorCode?: string;
  errorMessage?: string;
  platform?: string;
  /**
   * Queue and timing, straight from `build:view --json`. The CLI's
   * BuildFragment has carried these all along; they were simply not read.
   */
  queuePosition?: number;
  initialQueuePosition?: number;
  estimatedWaitTimeLeftSeconds?: number;
  /** Unit undocumented — see normaliseEasDuration before using it. */
  buildDuration?: number;
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeBuild(raw: Record<string, any>): EasBuild {
  const artifacts = raw.artifacts ?? {};
  return {
    id: String(raw.id ?? ''),
    status: String(raw.status ?? '').toUpperCase(),
    buildUrl: raw.buildUrl ?? raw.url ?? undefined,
    artifactUrl: artifacts.buildUrl ?? artifacts.applicationArchiveUrl ?? raw.artifactUrl ?? undefined,
    errorCode: raw.error?.errorCode ?? undefined,
    errorMessage: raw.error?.message ?? undefined,
    platform: raw.platform ? String(raw.platform).toLowerCase() : undefined,
    queuePosition: numberOrUndefined(raw.queuePosition),
    initialQueuePosition: numberOrUndefined(raw.initialQueuePosition),
    estimatedWaitTimeLeftSeconds: numberOrUndefined(raw.estimatedWaitTimeLeftSeconds),
    buildDuration: numberOrUndefined(raw.metrics?.buildDuration),
  };
}

/**
 * Start a cloud build and return as soon as EAS has accepted it.
 *
 * `--no-wait` is the whole point: the worker records the build id and releases
 * the job, and a separate poll follows the build to completion. Waiting here
 * would tie up a worker slot for the length of an Android compile and lose the
 * build entirely if the process restarted.
 */
export async function startEasBuild(input: {
  cwd: string;
  profile: string;
  platform: BuildPlatformArg;
}): Promise<EasBuild> {
  requireExpoToken();
  const args = [
    'build',
    '--platform',
    input.platform,
    '--profile',
    input.profile,
    '--non-interactive',
    '--no-wait',
    '--json',
  ];
  const { stdout, stderr, exitCode } = await runEas(args, input.cwd);
  if (exitCode !== 0) {
    throw new EasCommandFailed(
      'EAS refused to start the build.',
      redactSecrets(stderr || stdout),
      exitCode,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseJson(stdout);
  } catch {
    throw new EasCommandFailed(
      'EAS started the build but its reply could not be read.',
      redactSecrets(stdout || stderr),
      exitCode,
    );
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const build = normalizeBuild((first ?? {}) as Record<string, any>);
  if (!build.id) {
    throw new EasCommandFailed('EAS did not return a build id.', redactSecrets(stdout), exitCode);
  }
  return build;
}

export type BuildPlatformArg = 'android' | 'ios';

/** The Expo account every organization's project is created under. */
export function expoAccount(): string {
  const account = String(process.env.EXPO_ACCOUNT || '').trim();
  if (!account) {
    throw new EasNotConfigured(
      'No Expo account is configured, so a project cannot be created for this organization. ' +
        'Set EXPO_ACCOUNT on the build host to the account name that owns the apps ' +
        '(the EAS CLI lists the ones the token may use).',
    );
  }
  return account;
}

/** A project id out of the CLI's prose, for the dynamic-config path above. */
function projectIdFromText(text: string): string | null {
  const quoted = text.match(/"projectId"\s*:\s*"([0-9a-f-]{36})"/i);
  if (quoted) return quoted[1];
  const bare = text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return bare ? bare[1] : null;
}

/** `Created @account/slug` or `Linked @account/slug`. */
function slugFromText(text: string): string | null {
  const m = text.match(/@[A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+)/);
  return m ? m[1] : null;
}

export interface EasProject {
  id: string;
  /** The project slug, which is the organization slug for a dedicated build. */
  slug: string;
  /** The owning Expo account. */
  account: string;
  fullName: string;
}

/**
 * Create the organization's EAS project, or link the one already there.
 *
 * ── Why this command and not a create-then-catch ────────────────────────────
 * `eas init --account <a> --non-interactive` is documented as "create or link
 * @a/<slug> without prompts", and that is the whole idempotency story: run it
 * twice for one organization and the second run links what the first created.
 * The slug comes from the app config in `cwd`, which the build workspace has
 * already written from the organization record — so "which project" is decided
 * by the organization, not by whatever happens to be linked on a machine.
 *
 * `--json` implies `--non-interactive` and puts the result on stdout, which is
 * what lets the id be captured rather than scraped out of prose.
 */
export async function initEasProject(cwd: string, organizationSlug: string): Promise<EasProject> {
  requireExpoToken();
  const account = expoAccount();

  const { stdout, stderr, exitCode } = await runEas(
    ['init', '--account', account, '--json', '--non-interactive'],
    cwd,
    10 * 60 * 1000,
    // WITHOUT this the project is created under the wrong name.
    //
    // `eas init` evaluates the app config to learn the slug, and unlike
    // `eas build` it applies no build profile — so the ORG_ID that eas.json
    // sets for the build is absent here, `app.config.ts` falls back to the
    // generic build, and the CLI cheerfully creates `@account/client-platform-app`
    // for every institute in turn. Observed, not theorised.
    { ORG_ID: organizationSlug },
  );

  const combined = `${stdout}
${stderr}`;

  if (exitCode !== 0) {
    // ── The one failure that is not a failure ─────────────────────────────
    // This project uses a dynamic `app.config.ts`, which the CLI cannot write
    // to, so it creates the project, prints the id, tells you to add it
    // yourself, and exits non-zero. Adding it ourselves is precisely what
    // this system does — the id is stored on the organization and written
    // into the generated config on the next pass — so the project existing is
    // the outcome that matters, and the exit code is about a file we do not
    // want it to touch.
    const rescued = projectIdFromText(combined);
    if (rescued) {
      return {
        id: rescued,
        slug: slugFromText(combined) || organizationSlug,
        account,
        fullName: `@${account}/${slugFromText(combined) || organizationSlug}`,
      };
    }
    throw new EasCommandFailed(
      'The Expo project for this organization could not be created.',
      redactSecrets(stderr || stdout),
      exitCode,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseJson(stdout);
  } catch {
    throw new EasCommandFailed(
      'Expo created the project but its reply could not be read.',
      redactSecrets(stdout || stderr),
      exitCode,
    );
  }

  const raw = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, any>;
  // The CLI has used more than one key for this over its life; take whichever
  // is present rather than depending on one release's spelling.
  const id = String(raw?.id ?? raw?.projectId ?? raw?.project?.id ?? '').trim();
  const slug = String(raw?.slug ?? raw?.project?.slug ?? '').trim();
  const ownerAccount = String(raw?.ownerAccount?.name ?? raw?.owner ?? raw?.account ?? account).trim();
  const fullName = String(raw?.fullName ?? `@${ownerAccount}/${slug}`).trim();

  if (!id) {
    throw new EasCommandFailed(
      'Expo did not return a project id.',
      redactSecrets(stdout),
      exitCode,
    );
  }
  return { id, slug, account: ownerAccount, fullName };
}

/** One build's current state. Used by the poller. */
export async function getEasBuild(buildId: string, cwd: string): Promise<EasBuild> {
  requireExpoToken();
  // `--json` ONLY. `build:view` does not accept `--non-interactive` and exits
  // with "Nonexistent flag" if given it — which surfaced as "Could not read
  // the build status from EAS" on a build that was running perfectly well.
  // `--json` already implies non-interactive, per the CLI's own help.
  const { stdout, stderr, exitCode } = await runEas(
    ['build:view', buildId, '--json'],
    cwd,
    2 * 60 * 1000,
  );
  if (exitCode !== 0) {
    throw new EasCommandFailed('Could not read the build status from EAS.', redactSecrets(stderr || stdout), exitCode);
  }
  const parsed = parseJson(stdout);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return normalizeBuild((first ?? {}) as Record<string, any>);
}

export type EasProjectDeletion =
  | { deleted: true; alreadyGone: boolean }
  | { deleted: false; reason: string };

/**
 * Permanently delete an organization's EAS project — its builds, artifacts
 * and environment variables go with it.
 *
 * `--dangerously-confirm-deletion` carries the full name the caller EXPECTS
 * (`@owner/<organization slug>`), and the CLI refuses unless the project with
 * this id really has that name. That is the safety net against deleting a
 * project that merely happens to be referenced — for instance one created under
 * the generic app's name before `initEasProject` set ORG_ID.
 *
 * A project that no longer exists counts as deleted, but only when Expo's
 * answer names THIS id: "not found" alone could be the CLI itself missing.
 *
 * Expo may demand "sudo mode" (the owner re-entering a password) for this,
 * which a server token cannot give. That is reported, never papered over —
 * the caller keeps the organization's deletion incomplete.
 */
export async function deleteEasProject(input: { id: string; fullName: string; cwd: string }): Promise<EasProjectDeletion> {
  requireExpoToken();
  const { stdout, stderr, exitCode } = await runEas(
    ['project:delete', input.id, '--dangerously-confirm-deletion', input.fullName, '--non-interactive', '--json'],
    input.cwd,
    5 * 60 * 1000,
  );
  if (exitCode === 0) return { deleted: true, alreadyGone: false };

  const text = redactSecrets(`${stderr}\n${stdout}`);
  const escapedId = input.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`${escapedId}[^\\n]*(does not exist|not found|could not be found)`, 'i').test(text)) {
    return { deleted: true, alreadyGone: true };
  }
  if (/sudo mode/i.test(text)) {
    return {
      deleted: false,
      reason:
        'Expo only deletes a project after its owner re-enters their password ("sudo mode"), which a server token cannot do.',
    };
  }
  if (/did not match the project's full name/i.test(text)) {
    return {
      deleted: false,
      reason: `The Expo project with this id is not named ${input.fullName}, so it may not belong to this organization alone. It was not deleted.`,
    };
  }
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return { deleted: false, reason: `Expo did not delete the project${firstLine ? `: ${firstLine.slice(0, 200)}` : '.'}` };
}

/**
 * Ask EAS to stop a build.
 *
 * Returns whether EAS accepted it. The caller must not mark a job cancelled on
 * a `false` — a database row saying "cancelled" while Expo keeps compiling and
 * later publishes an artifact is two systems disagreeing about what happened,
 * which is worse than a build that finishes after someone asked it not to.
 */
export async function cancelEasBuild(buildId: string, cwd: string): Promise<boolean> {
  requireExpoToken();
  const { exitCode } = await runEas(
    ['build:cancel', buildId, '--non-interactive'],
    cwd,
    2 * 60 * 1000,
  );
  return exitCode === 0;
}
