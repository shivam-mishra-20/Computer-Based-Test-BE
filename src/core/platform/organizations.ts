/**
 * Organization lifecycle and configuration, from the platform side.
 *
 * ── Reuse, not reimplementation ─────────────────────────────────────────────
 * Everything here composes services that already exist and are already tested:
 * `provisionSystemRoles` and `createCustomRole` (P2), `resolveEntitlement`
 * (P3), `getOrgConfiguration` and `getOrgPolicy` (P4). This module adds
 * orchestration and platform-side reads — it does not re-derive entitlements or
 * re-implement configuration resolution, because two implementations of a rule
 * eventually disagree and the one nobody is looking at is the one that is wrong.
 *
 * ── Writes run inside the target tenant's context ───────────────────────────
 * Creating a class level for Org 002 opens a context for Org 002 and lets the
 * global plugin stamp it, rather than setting `orgId` by hand. Hand-stamping is
 * how a typo puts one customer's data in another's account, and it bypasses the
 * exact mechanism built to prevent that.
 */

import { runWithTenant, withoutTenantScope } from '../tenancy/context';
import { resolveEntitlement, getEntitlement } from '../entitlements/resolve';
import { getOrgConfiguration } from '../config/orgConfig';
import { getOrgPolicy } from '../config/policy';
import { provisionSystemRoles, createCustomRole } from '../rbac/provisionRoles';
import { MODULES, expandDependencies } from '../entitlements/moduleRegistry';

export interface CreateOrgInput {
  name: string;
  slug: string;
  status?: string;
  branding?: Record<string, unknown>;
  locale?: Record<string, unknown>;
  notes?: string;
}

export class OrgSlugTaken extends Error {
  readonly code = 'ORG_SLUG_TAKEN';
  constructor(slug: string) {
    super(`An organization with slug "${slug}" already exists.`);
    this.name = 'OrgSlugTaken';
  }
}

/**
 * Create an organization and provision its system roles.
 *
 * Roles are provisioned immediately rather than lazily: a tenant admin logging
 * in on day one needs something to assign, and "no roles exist yet" is a
 * confusing empty state for a product that has just been sold.
 */
export async function createOrganization(input: CreateOrgInput) {
  return withoutTenantScope('platform:create-org', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Org = require('../../models/Org').default;

    const existing = await Org.findOne({ slug: input.slug.toLowerCase() });
    if (existing) throw new OrgSlugTaken(input.slug);

    const org = await Org.create({
      name: input.name,
      slug: input.slug.toLowerCase(),
      status: input.status ?? 'trialing',
      branding: input.branding ?? {},
      locale: input.locale ?? {},
      notes: input.notes,
    });

    const orgId = String(org._id);
    await provisionSystemRoles(orgId);
    // Resolve immediately so the org has an entitlement snapshot from the
    // moment it exists, rather than one materialized by whoever reads first.
    await resolveEntitlement(orgId, 'org-created');

    return org;
  });
}

export interface ListOrgsQuery {
  search?: string;
  status?: string;
  limit?: number;
  skip?: number;
}

export async function listOrganizations(query: ListOrgsQuery) {
  return withoutTenantScope('platform:list-orgs', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Org = require('../../models/Org').default;

    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.search) {
      const needle = String(query.search).trim();
      // Escaped: an unescaped search term containing regex metacharacters would
      // either throw or match far more than intended.
      const safe = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: new RegExp(safe, 'i') },
        { slug: new RegExp(safe, 'i') },
      ];
    }

    const limit = Math.min(query.limit ?? 50, 200);
    const [items, total] = await Promise.all([
      Org.find(filter).sort({ createdAt: -1 }).skip(query.skip ?? 0).limit(limit).lean(),
      Org.countDocuments(filter),
    ]);

    return { items, total, limit, skip: query.skip ?? 0 };
  });
}

/**
 * The full platform view of one organization.
 *
 * Assembled in parallel because a console detail page needs all of it at once,
 * and six sequential round-trips is the difference between a page that feels
 * instant and one that does not.
 */
export async function getOrganizationDetail(orgId: string) {
  const org = await withoutTenantScope('platform:read-org', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Org = require('../../models/Org').default;
    return Org.findById(orgId).lean();
  });

  if (!org) return null;

  const [entitlement, configuration, policy, counts, subscription, roles] = await Promise.all([
    getEntitlement(orgId),
    getOrgConfiguration(orgId),
    getOrgPolicy(orgId),
    getOrganizationCounts(orgId),
    getSubscription(orgId),
    listOrgRoles(orgId),
  ]);

  return { organization: org, entitlement, configuration, policy, counts, subscription, roles };
}

/** Headline numbers for the console. */
export async function getOrganizationCounts(orgId: string) {
  return withoutTenantScope('platform:org-counts', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const User = require('../../models/User').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Exam = require('../../models/Exam').default;

    const [users, students, teachers, admins, exams] = await Promise.all([
      User.countDocuments({ orgId }),
      User.countDocuments({ orgId, role: 'student' }),
      User.countDocuments({ orgId, role: 'teacher' }),
      User.countDocuments({ orgId, role: 'admin' }),
      Exam.countDocuments({ orgId }),
    ]);

    return { users, students, teachers, admins, exams };
  });
}

export async function listOrgUsers(orgId: string, limit = 50, skip = 0) {
  return withoutTenantScope('platform:list-org-users', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const User = require('../../models/User').default;
    const [items, total] = await Promise.all([
      User.find({ orgId })
        .select('name email role status roleIds createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Math.min(limit, 200))
        .lean(),
      User.countDocuments({ orgId }),
    ]);
    return { items, total };
  });
}

export async function listOrgRoles(orgId: string) {
  return withoutTenantScope('platform:list-org-roles', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Role = require('../../models/Role').default;
    return Role.find({ orgId }).select('key name description permissions isSystem isActive').lean();
  });
}

/**
 * Change an organization's status.
 *
 * Status drives entitlement `writable`, so the snapshot is re-resolved
 * immediately — otherwise a suspension would not take effect until the cache
 * expired, and "I suspended them and they kept writing" is not a defensible
 * position during a payment dispute.
 */
export async function setOrganizationStatus(orgId: string, status: string) {
  const updated = await withoutTenantScope('platform:set-org-status', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Org = require('../../models/Org').default;
    return Org.findByIdAndUpdate(orgId, { $set: { status } }, { new: true }).lean();
  });

  await resolveEntitlement(orgId, `status-changed:${status}`);
  return updated;
}

export async function updateOrganization(orgId: string, patch: Record<string, unknown>) {
  // Whitelisted: an unfiltered $set would let a console bug or a crafted request
  // rewrite `_id`, `createdAt`, or a field a future migration depends on.
  const allowed = ['name', 'branding', 'locale', 'notes', 'domains', 'isPlatformOwned'];
  const update: Record<string, unknown> = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) update[key] = patch[key];
  }

  return withoutTenantScope('platform:update-org', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Org = require('../../models/Org').default;
    return Org.findByIdAndUpdate(orgId, { $set: update }, { new: true }).lean();
  });
}

// ── Configuration ──────────────────────────────────────────────────────────

export interface ConfigInput {
  classLevels?: { key: string; label: string; aliases?: string[]; order?: number }[];
  subjects?: { name: string; code?: string; order?: number }[];
  rooms?: { name: string; capacity?: number; order?: number }[];
  batches?: { name: string; classLevels?: string[] }[];
}

/**
 * Replace an organization's configuration.
 *
 * Replace rather than merge: the console edits these as lists, and a merge
 * would make deleting a room impossible through the UI. Existing rows are
 * removed only for the sections actually supplied, so sending only `subjects`
 * leaves rooms alone.
 */
export async function setOrganizationConfig(orgId: string, input: ConfigInput) {
  return runWithTenant({ orgId, source: 'script' }, async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ClassLevel = require('../../models/ClassLevel').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Subject = require('../../models/Subject').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OrgRoom = require('../../models/OrgRoom').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Batch = require('../../models/Batch').default;

    const result: Record<string, number> = {};

    if (input.classLevels) {
      await ClassLevel.deleteMany({ orgId });
      await ClassLevel.insertMany(
        input.classLevels.map((c, i) => ({
          orgId,
          key: c.key.toLowerCase(),
          label: c.label,
          aliases: c.aliases ?? [c.key, c.label],
          order: c.order ?? i,
          isActive: true,
        })),
      );
      result.classLevels = input.classLevels.length;
    }

    if (input.subjects) {
      await Subject.deleteMany({ orgId });
      await Subject.insertMany(
        input.subjects.map((s, i) => ({ orgId, name: s.name, code: s.code, order: s.order ?? i, isActive: true })),
      );
      result.subjects = input.subjects.length;
    }

    if (input.rooms) {
      await OrgRoom.deleteMany({ orgId });
      await OrgRoom.insertMany(
        input.rooms.map((r, i) => ({
          orgId,
          name: r.name,
          capacity: r.capacity ?? 20,
          order: r.order ?? i,
          isActive: true,
        })),
      );
      result.rooms = input.rooms.length;
    }

    if (input.batches) {
      await Batch.deleteMany({ orgId });
      for (const b of input.batches) {
        // Batch predates tenancy and has a globally unique `name` index, so
        // insertMany would collide across organizations. Created one at a time
        // through the model so the plugin stamps orgId and a duplicate is
        // reported rather than aborting the whole set.
        try {
          await Batch.create({ name: b.name, classLevels: b.classLevels ?? [] });
        } catch (error) {
          console.warn(`[platform] batch "${b.name}" not created: ${(error as Error).message}`);
        }
      }
      result.batches = input.batches.length;
    }

    return result;
  });
}

export async function setOrganizationPolicy(orgId: string, policy: Record<string, unknown>) {
  return runWithTenant({ orgId, source: 'script' }, async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OrgPolicy = require('../../models/OrgPolicy').default;
    // orgId is deliberately NOT in $set. The tenant plugin adds
    // `$setOnInsert: { orgId }` to every upsert, and MongoDB rejects an update
    // that touches the same path in both operators —
    // "Updating the path 'orgId' would create a conflict at 'orgId'".
    // The filter already scopes the document; the plugin owns the stamping.
    return OrgPolicy.findOneAndUpdate(
      { orgId },
      { $set: { ...policy } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
  });
}

// ── Subscriptions ──────────────────────────────────────────────────────────

export async function getSubscription(orgId: string) {
  return withoutTenantScope('platform:read-subscription', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Subscription = require('../../models/Subscription').default;
    return Subscription.findOne({ orgId }).lean();
  });
}

export interface SubscriptionInput {
  planId?: string | null;
  addOns?: string[];
  removals?: string[];
  overrides?: { modules?: string[]; limits?: Record<string, number> };
  status?: string;
  isPlatformOwned?: boolean;
}

/**
 * Create or replace an organization's subscription, then re-resolve.
 *
 * Re-resolution is not optional. The entitlement snapshot is what every request
 * reads, so a subscription change that did not re-resolve would be a change
 * nobody could observe — the most confusing possible failure for whoever made
 * it.
 */
export async function setSubscription(orgId: string, input: SubscriptionInput) {
  await withoutTenantScope('platform:set-subscription', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Subscription = require('../../models/Subscription').default;

    const update: Record<string, unknown> = { orgId };
    if (input.planId !== undefined) update.planId = input.planId || null;
    if (input.addOns) update.addOns = input.addOns;
    if (input.removals) update.removals = input.removals;
    if (input.overrides) update.overrides = input.overrides;
    if (input.status) update.status = input.status;
    if (input.isPlatformOwned !== undefined) update.isPlatformOwned = input.isPlatformOwned;

    await Subscription.findOneAndUpdate(
      { orgId },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  });

  return resolveEntitlement(orgId, 'subscription-changed');
}

// ── Catalogue ──────────────────────────────────────────────────────────────

/** The module catalogue, with dependencies expanded for display. */
export function listModules() {
  return MODULES.map((m) => ({
    ...m,
    // What enabling this module actually turns on, so the console can show the
    // real consequence rather than the literal selection.
    effective: expandDependencies([m.key]),
  }));
}

export async function listPlans() {
  return withoutTenantScope('platform:list-plans', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Plan = require('../../models/Plan').default;
    return Plan.find({}).sort({ sortOrder: 1, name: 1 }).lean();
  });
}

export async function upsertPlan(input: {
  key: string;
  name: string;
  description?: string;
  modules: string[];
  limits?: Record<string, number>;
  price?: Record<string, unknown>;
  isPublic?: boolean;
  sortOrder?: number;
}) {
  return withoutTenantScope('platform:upsert-plan', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Plan = require('../../models/Plan').default;
    return Plan.findOneAndUpdate(
      { key: input.key.toLowerCase() },
      {
        $set: {
          key: input.key.toLowerCase(),
          name: input.name,
          description: input.description,
          modules: input.modules,
          limits: input.limits ?? {},
          price: input.price ?? {},
          isPublic: input.isPublic ?? true,
          sortOrder: input.sortOrder ?? 0,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
  });
}

export { createCustomRole };
