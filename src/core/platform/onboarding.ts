/**
 * Organization onboarding — the whole journey, as one orchestrated operation.
 *
 *   create org -> configure -> brand -> assign plan -> set entitlements
 *   -> custom roles -> initial admin -> ready
 *
 * ── Why one orchestrator rather than "call these eight endpoints in order" ──
 * Onboarding is the step that decides whether a customer takes a day or a
 * month, and an ordering that lives only in someone's head gets done wrong the
 * first time it is done under pressure. Encoding it means the console has a
 * single call to make and the sequence cannot be performed out of order.
 *
 * ── Not a transaction, and honest about it ──────────────────────────────────
 * MongoDB multi-document transactions need a replica set and would wrap writes
 * across six collections. Instead each step is INDIVIDUALLY IDEMPOTENT and the
 * result reports exactly which steps completed. A failure halfway leaves a
 * partially configured organization that re-running the same request completes
 * — rather than a rolled-back one that hides what went wrong.
 *
 * That trade is deliberate: for onboarding, "resumable and visible" beats
 * "atomic and opaque", because a half-configured org is recoverable and a
 * silent rollback during a customer demo is not.
 */

import { runWithTenant, withoutTenantScope } from '../tenancy/context';
import {
  createOrganization,
  setOrganizationConfig,
  setOrganizationPolicy,
  setSubscription,
  updateOrganization,
  type ConfigInput,
} from './organizations';
import { createCustomRole, provisionSystemRoles } from '../rbac/provisionRoles';
import { sanitizePermissions } from '../rbac/permissions';

export interface OnboardingInput {
  organization: {
    name: string;
    slug: string;
    status?: string;
    notes?: string;
  };
  branding?: Record<string, unknown>;
  locale?: Record<string, unknown>;
  configuration?: ConfigInput;
  policy?: Record<string, unknown>;
  subscription?: {
    planKey?: string;
    addOns?: string[];
    removals?: string[];
    overrides?: { modules?: string[]; limits?: Record<string, number> };
    status?: string;
  };
  customRoles?: { key: string; name: string; description?: string; permissions: string[] }[];
  admin?: {
    name: string;
    email: string;
    password: string;
  };
}

export interface OnboardingStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface OnboardingResult {
  orgId: string;
  slug: string;
  steps: OnboardingStep[];
  adminUserId?: string;
  roleIds: Record<string, string>;
  complete: boolean;
}

export async function onboardOrganization(input: OnboardingInput): Promise<OnboardingResult> {
  const steps: OnboardingStep[] = [];
  const roleIds: Record<string, string> = {};
  let adminUserId: string | undefined;

  const record = (step: string, ok: boolean, detail?: string) => {
    steps.push({ step, ok, detail });
    if (!ok) console.error(`[onboarding] ${step} FAILED: ${detail}`);
  };

  // ── 1. Organization ──────────────────────────────────────────────────────
  // Idempotent: an existing slug is reused rather than rejected, so re-running
  // a partially failed onboarding continues instead of dead-ending.
  const existing = await withoutTenantScope('onboard:find-org', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Org = require('../../models/Org').default;
    return Org.findOne({ slug: input.organization.slug.toLowerCase() });
  });

  let orgId: string;
  if (existing) {
    orgId = String(existing._id);
    record('organization', true, 'already existed — resuming');
  } else {
    const org = await createOrganization({
      name: input.organization.name,
      slug: input.organization.slug,
      status: input.organization.status ?? 'trialing',
      branding: input.branding,
      locale: input.locale,
      notes: input.organization.notes,
    });
    orgId = String(org._id);
    record('organization', true, `created ${orgId}`);
  }

  // ── 2. Branding and locale ───────────────────────────────────────────────
  if (input.branding || input.locale) {
    try {
      await updateOrganization(orgId, {
        ...(input.branding ? { branding: input.branding } : {}),
        ...(input.locale ? { locale: input.locale } : {}),
      });
      record('branding', true);
    } catch (error) {
      record('branding', false, (error as Error).message);
    }
  }

  // ── 3. System roles ──────────────────────────────────────────────────────
  try {
    const provisioned = await provisionSystemRoles(orgId);
    record('system-roles', true, `${provisioned.created.length} created, ${provisioned.existing.length} existing`);
  } catch (error) {
    record('system-roles', false, (error as Error).message);
  }

  // ── 4. Configuration ─────────────────────────────────────────────────────
  if (input.configuration) {
    try {
      const counts = await setOrganizationConfig(orgId, input.configuration);
      record('configuration', true, JSON.stringify(counts));
    } catch (error) {
      record('configuration', false, (error as Error).message);
    }
  }

  // ── 5. Policy ────────────────────────────────────────────────────────────
  if (input.policy) {
    try {
      await setOrganizationPolicy(orgId, input.policy);
      record('policy', true);
    } catch (error) {
      record('policy', false, (error as Error).message);
    }
  }

  // ── 6. Custom roles ──────────────────────────────────────────────────────
  if (input.customRoles?.length) {
    for (const role of input.customRoles) {
      try {
        const created = await createCustomRole(orgId, {
          key: role.key,
          name: role.name,
          description: role.description,
          permissions: role.permissions,
        });
        roleIds[role.key] = created.id;
        record(
          `role:${role.key}`,
          true,
          created.rejected.length
            ? `${created.granted.length} granted, ${created.rejected.length} rejected as unknown`
            : `${created.granted.length} permissions`,
        );
      } catch (error) {
        record(`role:${role.key}`, false, (error as Error).message);
      }
    }
  }

  // ── 7. Subscription and entitlements ─────────────────────────────────────
  if (input.subscription) {
    try {
      let planId: string | null = null;
      if (input.subscription.planKey) {
        const plan = await withoutTenantScope('onboard:find-plan', async () => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const Plan = require('../../models/Plan').default;
          return Plan.findOne({ key: input.subscription!.planKey!.toLowerCase() }).lean();
        });
        if (!plan) throw new Error(`Plan "${input.subscription.planKey}" not found`);
        planId = String((plan as { _id: unknown })._id);
      }

      const entitlement = await setSubscription(orgId, {
        planId,
        addOns: input.subscription.addOns,
        removals: input.subscription.removals,
        overrides: input.subscription.overrides,
        status: input.subscription.status ?? 'trialing',
      });
      record('subscription', true, `${entitlement.modules.length} modules enabled`);
    } catch (error) {
      record('subscription', false, (error as Error).message);
    }
  }

  // ── 8. Initial admin ─────────────────────────────────────────────────────
  if (input.admin) {
    try {
      adminUserId = await runWithTenant({ orgId, source: 'script' }, async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const User = require('../../models/User').default;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Role = require('../../models/Role').default;

        const found = await User.findOne({ orgId, email: input.admin!.email.toLowerCase() });
        if (found) return String(found._id);

        const adminRole = await Role.findOne({ orgId, key: 'admin' });

        const user = await User.create({
          name: input.admin!.name,
          email: input.admin!.email.toLowerCase(),
          password: input.admin!.password,
          role: 'admin',
          status: 'approved',
          // Assigned explicitly rather than relying on the legacy-role
          // fallback, so this account works identically once the legacy bridge
          // is eventually retired.
          roleIds: adminRole ? [adminRole._id] : [],
        });
        return String(user._id);
      });
      record('admin-user', true, adminUserId);
    } catch (error) {
      record('admin-user', false, (error as Error).message);
    }
  }

  const complete = steps.every((s) => s.ok);
  return { orgId, slug: input.organization.slug.toLowerCase(), steps, adminUserId, roleIds, complete };
}

export { sanitizePermissions };
