/**
 * Seed an organization's system roles, and create custom ones.
 *
 * Every organization gets the system templates so a tenant admin has something
 * to assign on day one. Custom roles — Centre Manager, Counsellor — are created
 * on top with any name the customer likes, but only ever from the closed
 * permission vocabulary.
 */

import { runWithTenant, withoutTenantScope } from '../tenancy/context';
import { SYSTEM_ROLE_TEMPLATES, sanitizePermissions } from './permissions';

export interface ProvisionResult {
  created: string[];
  existing: string[];
}

/** Idempotent: existing roles are left exactly as they are. */
export async function provisionSystemRoles(orgId: string): Promise<ProvisionResult> {
  const created: string[] = [];
  const existing: string[] = [];

  await runWithTenant({ orgId, source: 'script' }, async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Role = require('../../models/Role').default;

    for (const template of SYSTEM_ROLE_TEMPLATES) {
      const found = await Role.findOne({ orgId, key: template.key });
      if (found) {
        existing.push(template.key);
        continue;
      }
      await Role.create({
        key: template.key,
        name: template.name,
        description: template.description,
        permissions: sanitizePermissions([...template.permissions]),
        isSystem: true,
        templateKey: template.key,
        isActive: true,
      });
      created.push(template.key);
    }
  });

  return { created, existing };
}

/**
 * Create a custom, tenant-defined role.
 *
 * Permissions are sanitized against the closed vocabulary, so an invented
 * string is dropped rather than stored. Storing it would produce a role that
 * reads impressively and grants nothing — and the resulting support ticket
 * would look like a platform bug rather than a typo.
 */
export async function createCustomRole(
  orgId: string,
  input: { key: string; name: string; description?: string; permissions: string[] },
): Promise<{ id: string; granted: string[]; rejected: string[] }> {
  const granted = sanitizePermissions(input.permissions);
  const rejected = input.permissions.filter((p) => !granted.includes(p as never));

  const id = await runWithTenant({ orgId, source: 'script' }, async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Role = require('../../models/Role').default;

    const existing = await Role.findOne({ orgId, key: input.key.toLowerCase() });
    if (existing) {
      existing.name = input.name;
      existing.description = input.description;
      existing.permissions = granted;
      await existing.save();
      return String(existing._id);
    }

    const role = await Role.create({
      key: input.key.toLowerCase(),
      name: input.name,
      description: input.description,
      permissions: granted,
      // Custom roles are never system roles: the customer owns them and may
      // edit or delete them freely.
      isSystem: false,
      isActive: true,
    });
    return String(role._id);
  });

  return { id: id as string, granted: granted as string[], rejected };
}

/** Assign roles to a user, replacing any current assignment. */
export async function assignRoles(userId: string, roleIds: string[]): Promise<void> {
  await withoutTenantScope('rbac:assign-roles', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const User = require('../../models/User').default;
    await User.updateOne({ _id: userId }, { $set: { roleIds } });
  });
}
