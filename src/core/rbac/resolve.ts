/**
 * Resolve the permissions a user actually holds.
 *
 * ── Two sources, one answer ─────────────────────────────────────────────────
 *   1. Assigned Role documents — the new model, used by Org 002's Centre
 *      Manager and Counsellor.
 *   2. The legacy `role` string — used by every one of Abhigyan's 158 users,
 *      none of which has a role document.
 *
 * A user with roles gets the union of their permissions. A user WITHOUT roles
 * falls back to the legacy mapping, which is why converting a route from
 * requireRole() to requirePermission() changes nothing for Org 001.
 *
 * The fallback is only used when there are NO assigned roles at all. A user
 * given a deliberately narrow custom role must not silently keep their old
 * blanket permissions — that would make "Counsellor" a lie.
 */

import { withoutTenantScope } from '../tenancy/context';
import { permissionsForLegacyRole, type Permission } from './permissions';

export interface ResolvedAccess {
  permissions: Set<string>;
  /** Where they came from — invaluable when an authorization surprises someone. */
  source: 'roles' | 'legacy-role' | 'none';
  roleNames: string[];
}

export async function resolveUserPermissions(user: {
  _id?: unknown;
  id?: unknown;
  role?: string | null;
  roleIds?: unknown[] | null;
  orgId?: string | null;
}): Promise<ResolvedAccess> {
  const roleIds = (user.roleIds ?? []).filter(Boolean);

  if (roleIds.length > 0) {
    const roles = (await withoutTenantScope('rbac:resolve-roles', async () => {
      // Required lazily so this module loads before models compile.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Role = require('../../models/Role').default;
      return Role.find({ _id: { $in: roleIds }, isActive: true }).lean();
    })) as { name: string; permissions: string[]; orgId?: string }[];

    // Belt and braces: a role from another organization must never apply, even
    // if a stale assignment somehow references one. The plugin already scopes
    // reads, but this is the check that matters if the lookup was unscoped.
    const own = user.orgId ? roles.filter((r) => !r.orgId || String(r.orgId) === String(user.orgId)) : roles;

    const permissions = new Set<string>();
    for (const role of own) for (const p of role.permissions ?? []) permissions.add(p);

    return { permissions, source: 'roles', roleNames: own.map((r) => r.name) };
  }

  const legacy = permissionsForLegacyRole(user.role);
  if (legacy.length > 0) {
    return {
      permissions: new Set<string>(legacy as string[]),
      source: 'legacy-role',
      roleNames: [String(user.role)],
    };
  }

  return { permissions: new Set<string>(), source: 'none', roleNames: [] };
}

export function hasPermission(access: ResolvedAccess, permission: Permission | string): boolean {
  return access.permissions.has(permission);
}
