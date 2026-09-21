/**
 * Giving an organization its own EAS project, without anybody typing a command.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `eas build` needs a project to build INTO. Each build runs in a fresh
 * workspace with no `.expo` link, so the project has to be named by the
 * configuration — and until it exists, the CLI refuses in non-interactive mode
 * with "EAS project not configured. This command cannot configure it in
 * non-interactive mode." That message is correct and useless to an
 * administrator, whose entire involvement is meant to be choosing APK or AAB.
 *
 * So the first build of an organization creates the project and remembers it.
 *
 * ── Idempotency, in three layers ────────────────────────────────────────────
 * 1. The stored id. An organization that has one never provisions again — this
 *    module returns early, before any process is spawned.
 * 2. The EAS CLI itself. `eas init --account <a> --non-interactive` is
 *    documented as "create or LINK @a/<slug>", so two workers racing on the
 *    same organization converge on one project rather than making two. That is
 *    the layer that actually holds under concurrency, because it is enforced
 *    by the service that owns the resource.
 * 3. A conditional write. The id is stored with a filter that only matches an
 *    organization which still has none, so the first writer wins and the
 *    second reads back what the first stored instead of overwriting it.
 *
 * Together these cover the cases the brief lists: a double click, a browser
 * retry, a worker retry, a server restart mid-build, and reconciliation
 * re-queueing an orphan.
 *
 * ── What is NOT done here ───────────────────────────────────────────────────
 * Nothing is submitted to any store, and no project is created by looking at
 * an organization. Provisioning happens when a build is actually requested and
 * at no other time — opening the organization page must not spend anything on
 * somebody's Expo account.
 */

import { initEasProject, expoAccount, type EasProject } from './easClient';
import { withoutTenantScope } from '../tenancy/context';

export class ProjectIdentityMismatch extends Error {
  readonly code = 'PROJECT_IDENTITY_MISMATCH';
  constructor(message: string, readonly detail: string) {
    super(message);
    this.name = 'ProjectIdentityMismatch';
  }
}

function orgModel() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../models/Org').default;
}

export interface ProvisionResult {
  projectId: string;
  account: string;
  slug: string;
  /** False when the organization already had one and nothing was run. */
  provisioned: boolean;
}

/** What an organization already has, if anything. */
export async function storedEasProject(orgId: string): Promise<ProvisionResult | null> {
  const org = await withoutTenantScope('eas-provision:read', async () =>
    orgModel().findById(orgId).select('slug mobile').lean(),
  );
  const mobile = (org as { mobile?: Record<string, unknown> } | null)?.mobile ?? {};
  const projectId = String(mobile.easProjectId ?? '').trim();
  if (!projectId) return null;
  return {
    projectId,
    account: String(mobile.easOwner ?? ''),
    slug: String(mobile.easProjectSlug ?? (org as { slug?: string }).slug ?? ''),
    provisioned: false,
  };
}

/**
 * Ensure this organization has an EAS project, creating one if it does not.
 *
 * `workspaceRoot` must already contain the generated app configuration: the
 * CLI reads the slug from it, and that slug is what decides whether the
 * project is this institute's or somebody else's.
 */
export async function ensureEasProject(input: {
  orgId: string;
  organizationSlug: string;
  workspaceRoot: string;
}): Promise<ProvisionResult> {
  const existing = await storedEasProject(input.orgId);
  if (existing) return existing;

  const account = expoAccount();
  const project: EasProject = await initEasProject(input.workspaceRoot, input.organizationSlug);

  // ── Before it is stored, prove it is the right project ────────────────────
  // A project whose slug is not this organization's slug is somebody else's —
  // most likely the shared default, which would mean every institute building
  // into one project and sharing one set of Android credentials.
  const problems: string[] = [];
  if (project.slug && project.slug !== input.organizationSlug) {
    problems.push(`project slug "${project.slug}" is not this organization's slug "${input.organizationSlug}"`);
  }
  if (project.account && account && project.account !== account) {
    problems.push(`project belongs to account "${project.account}", not "${account}"`);
  }
  if (problems.length) {
    throw new ProjectIdentityMismatch(
      'Expo returned a project that does not belong to this organization, so it was not used.',
      problems.join('; '),
    );
  }

  // ── Store it, but only if nobody beat us to it ────────────────────────────
  const now = new Date();
  const updated = await withoutTenantScope('eas-provision:claim', async () =>
    orgModel().findOneAndUpdate(
      {
        _id: input.orgId,
        $or: [
          { 'mobile.easProjectId': { $exists: false } },
          { 'mobile.easProjectId': null },
          { 'mobile.easProjectId': '' },
        ],
      },
      {
        $set: {
          'mobile.easProjectId': project.id,
          'mobile.easOwner': project.account || account,
          'mobile.easProjectSlug': project.slug || input.organizationSlug,
          'mobile.easProvisionedAt': now,
        },
      },
      { new: true },
    ),
  );

  if (updated) {
    console.log(
      `[easProvisioning] org ${input.orgId} → EAS project ${project.id} ` +
        `(@${project.account || account}/${project.slug || input.organizationSlug})`,
    );
    return {
      projectId: project.id,
      account: project.account || account,
      slug: project.slug || input.organizationSlug,
      provisioned: true,
    };
  }

  // Somebody wrote one between the read above and here. Theirs is the record,
  // and because the CLI links rather than duplicates it is the same project.
  const winner = await storedEasProject(input.orgId);
  if (winner) return winner;

  // Only reachable if the organization vanished mid-build.
  throw new ProjectIdentityMismatch(
    'The organization could not be updated with its Expo project.',
    `orgId ${input.orgId}`,
  );
}
