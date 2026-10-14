/**
 * One organization's public-registration settings — ONE implementation, two
 * callers: the platform console (`/api/platform/orgs/:id/registration`) and the
 * institute's own administrators (`/api/org-admin/registration`).
 *
 * Both read the same view and write through `setAppExperience`, the single
 * write path for `Org.appExperience`. What differs between them is only WHO
 * decides which organization: the console's URL, checked by a platform
 * capability; or the authenticated administrator's own organization.
 *
 * The store (the `reg_<slug>` collection) is shown to platform staff for
 * tracing, never to the institute, and is never accepted as input by either.
 */

import Org from '../../models/Org';
import { withoutTenantScope } from '../tenancy/context';
import { resolveBrandConfig, SUPPORTED_AUTH_ROLES } from './mobileBuildRules';
import { setAppExperience } from './appExperience';
import { deploymentAllowsRegistration, registrationPolicyFor } from '../registration/publicRegistration';

interface RegistrationViewOrg {
  name?: string;
  branding?: { appName?: string; tagline?: string };
  appExperience?: {
    authCopy?: Record<string, string>;
    roles?: Partial<Record<'student' | 'teacher' | 'parent', boolean>>;
    registrationPolicy?: 'open' | 'approval' | 'invite';
  };
  registrationStore?: { collection?: string; accountStore?: string; provisionedAt?: Date };
}

export function registrationView(org: RegistrationViewOrg | null, options: { includeStore: boolean }) {
  const experience = org?.appExperience ?? {};
  const brand = resolveBrandConfig({
    appName: org?.branding?.appName || org?.name,
    tagline: org?.branding?.tagline,
    authCopy: experience.authCopy,
    roles: experience.roles,
    registrationPolicy: experience.registrationPolicy,
  });
  return {
    policy: brand.registrationPolicy,
    roles: brand.roles,
    unsupportedRoles: brand.unsupportedRoles,
    requestedRoles: experience.roles ?? {},
    supportedRoles: SUPPORTED_AUTH_ROLES,
    support: { email: brand.authCopy.supportEmail, phone: brand.authCopy.supportPhone },
    registerMessage: brand.authCopy.registerMessage,
    store:
      options.includeStore && org?.registrationStore?.collection
        ? {
            collection: org.registrationStore.collection,
            accountStore: org.registrationStore.accountStore,
            provisionedAt: org.registrationStore.provisionedAt,
          }
        : null,
    deploymentOpen: deploymentAllowsRegistration(),
  };
}

/**
 * The settings view plus what an installed app is told RIGHT NOW — computed by
 * `registrationPolicyFor`, the function the app's own request runs. The admin
 * screens show this, so "registration is on" here can never quietly disagree
 * with an app that shows no form: if anything else stops it (the server-wide
 * switch, storage not provisioned, the organization not live), it says so.
 */
export async function registrationViewFor(orgId: string, options: { includeStore: boolean }) {
  const org = await loadOrgForRegistration(orgId);
  if (!org) return null;
  const live = await registrationPolicyFor(orgId);
  return {
    ...registrationView(org, options),
    inApp: { open: live.open, reason: live.reason, roles: live.roles, studentApprovalRequired: live.studentApprovalRequired },
  };
}

export async function loadOrgForRegistration(orgId: string): Promise<RegistrationViewOrg | null> {
  return withoutTenantScope('registration-settings:read', async () =>
    Org.findById(orgId).select('name branding appExperience registrationStore').lean(),
  ) as Promise<RegistrationViewOrg | null>;
}

/**
 * The only fields a registration update may carry. `collection`, `store`,
 * `orgId` or anything else in a request body is never read.
 */
export function registrationPatchFrom(body: Record<string, unknown>) {
  const support = (body.support as Record<string, unknown> | undefined) ?? {};
  return {
    registrationPolicy: body.policy,
    roles: body.roles,
    authCopy: {
      supportEmail: support.email,
      supportPhone: support.phone,
      registerMessage: body.registerMessage,
    },
  };
}

export async function updateRegistrationSettings(orgId: string, body: Record<string, unknown>) {
  return setAppExperience(orgId, registrationPatchFrom(body) as never);
}
