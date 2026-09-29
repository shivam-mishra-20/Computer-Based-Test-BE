/**
 * An institute's administrators managing THEIR OWN organization.
 *
 * ── Which organization ──────────────────────────────────────────────────────
 * Always the authenticated principal's, from the tenant context authMiddleware
 * opened — never a parameter. There is no `:orgId` anywhere in this router, so
 * there is nothing to point at another organization. The platform console
 * manages ANY organization through /api/platform, with platform credentials;
 * this router manages ONE, with the institute's own.
 *
 * ── The same model, the same services ───────────────────────────────────────
 * Every write goes through the service the console uses — `updateOrganization`
 * (branding, profile, locale), `setAppExperience` (app experience and
 * registration), `setOrganizationConfig` (classes, subjects, rooms, batches),
 * `setOrganizationPolicy` (exam and grading policy). There is no second copy of
 * organization data and no second way to change it.
 *
 * ── What an institute cannot change here ────────────────────────────────────
 * Its plan and modules (read-only), its app's native identity (package name,
 * icons, builds) and custom roles, which remain platform operations. Changes
 * that only reach an INSTALLED app through a new build say so in the response
 * (`effects`), so nobody is told a setting "applies" when the binary on a
 * student's phone will not show it until the next release.
 *
 * ── State ───────────────────────────────────────────────────────────────────
 * authMiddleware refuses every request for an organization that is being
 * deleted, and every write for one that is suspended, before this router runs.
 */

import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { requireStaffAnyPermission, requireStaffPermission, holds } from '../../middlewares/requirePermission';
import { uploadBrandAsset } from '../../middlewares/uploadBrandAsset';
import { currentTenantOrgId, requireTenantScope, withoutTenantScope } from '../../core/tenancy';
import Org from '../../models/Org';
import User from '../../models/User';
import AuditLog from '../../models/AuditLog';
import PlatformAudit from '../../models/PlatformAudit';
import AppBuildJob from '../../models/AppBuildJob';
import { getEntitlement } from '../../core/entitlements/resolve';
import { MODULES } from '../../core/entitlements/moduleRegistry';
import { getOrgConfiguration } from '../../core/config/orgConfig';
import { getOrgPolicy } from '../../core/config/policy';
import {
  getSubscription,
  setOrganizationConfig,
  setOrganizationPolicy,
  updateOrganization,
  type ConfigInput,
} from '../../core/platform/organizations';
import { setAppExperience, RegistrationStorageFailed } from '../../core/platform/appExperience';
import {
  loadOrgForRegistration,
  registrationView,
  updateRegistrationSettings,
} from '../../core/platform/registrationSettings';
import { putPublicTenantAsset } from '../../core/storage/storageService';
import { issueInvite, issueResetLink, revokeSessions, unusablePassword } from '../../core/accounts/accountLinks';
import { mayActOn, resolveStudentClassAndBatch } from '../../controllers/userController';
import { logAudit } from '../../utils/logger';

const router = Router();
router.use(authMiddleware);

const read = requireStaffPermission('org.read');
const settings = requireStaffPermission('org.settings');
const branding = requireStaffPermission('org.branding');

type Req = Request & { user?: { id?: string; role?: string } };

/** The organization this request is scoped to. Never absent past authMiddleware. */
function orgOf(res: Response): string | null {
  const orgId = currentTenantOrgId();
  if (!orgId) {
    res.status(403).json({ message: 'This account is not attached to an organization.', code: 'TENANT_REQUIRED' });
    return null;
  }
  return orgId;
}

async function loadOrg(orgId: string) {
  return withoutTenantScope('org-admin:read-org', async () =>
    Org.findById(orgId).select('name slug status createdAt branding appExperience locale profile mobile').lean(),
  ) as Promise<Record<string, any> | null>;
}

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : undefined);
const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const colorOf = (value: unknown) => {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return '';
  if (!COLOR.test(v)) throw Object.assign(new Error(`"${v}" is not a colour like #1E40AF.`), { status: 400 });
  return v.toUpperCase();
};
const urlOf = (value: unknown) => {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return '';
  const secure = /^https:\/\//i.test(v) || (process.env.NODE_ENV !== 'production' && /^http:\/\//i.test(v));
  if (!secure) throw Object.assign(new Error('Links must start with https://'), { status: 400 });
  return v.slice(0, 500);
};

function fail(res: Response, err: unknown) {
  const status = (err as { status?: number })?.status;
  if (status && status >= 400 && status < 500) return res.status(status).json({ message: (err as Error).message });
  if (err instanceof RegistrationStorageFailed) {
    return res.status(503).json({ message: err.message, code: 'REGISTRATION_STORAGE_FAILED' });
  }
  console.error('[org-admin] failed:', (err as Error)?.message);
  return res.status(500).json({ message: 'Could not save. Please try again.' });
}

/* ══ Overview ═════════════════════════════════════════════════════════════ */

router.get('/overview', read, async (_req, res) => {
  const orgId = orgOf(res);
  if (!orgId) return;
  const org = await loadOrg(orgId);
  if (!org) return res.status(404).json({ message: 'Organization not found.' });
  const [users, pendingRegistrations] = await Promise.all([
    User.countDocuments({ ...requireTenantScope('org-admin:overview') }),
    User.countDocuments({ ...requireTenantScope('org-admin:overview'), status: 'pending', role: { $ne: 'parent' } }),
  ]);
  return res.json({
    organization: { id: String(org._id), name: org.name, slug: org.slug, status: org.status, createdAt: org.createdAt },
    counts: { users, pendingRegistrations },
  });
});

/* ══ Institute profile ════════════════════════════════════════════════════ */

const PROFILE_FIELDS: [string, number][] = [
  ['contactName', 80], ['contactEmail', 120], ['contactPhone', 40], ['website', 200],
  ['address', 300], ['city', 80], ['state', 80], ['country', 80],
];

router.get('/profile', read, async (_req, res) => {
  const orgId = orgOf(res);
  if (!orgId) return;
  const org = await loadOrg(orgId);
  if (!org) return res.status(404).json({ message: 'Organization not found.' });
  return res.json({ name: org.name, slug: org.slug, profile: org.profile ?? {}, locale: org.locale ?? {} });
});

router.put('/profile', settings, async (req: Req, res) => {
  const orgId = orgOf(res);
  if (!orgId) return;
  try {
    const body = (req.body ?? {}) as Record<string, any>;
    const current = await loadOrg(orgId);
    if (!current) return res.status(404).json({ message: 'Organization not found.' });
    const profile: Record<string, string> = { ...(current.profile ?? {}) };
    for (const [key, max] of PROFILE_FIELDS) {
      if (body.profile && key in body.profile) profile[key] = text(body.profile[key], max) ?? '';
    }
    if (profile.website) profile.website = urlOf(profile.website);
    const patch: Record<string, unknown> = { profile };
    const name = text(body.name, 120);
    if (name) patch.name = name;
    if (body.locale && typeof body.locale === 'object') {
      patch.locale = {
        ...(current.locale ?? {}),
        ...(text(body.locale.timezone, 60) ? { timezone: text(body.locale.timezone, 60) } : {}),
        ...(text(body.locale.currency, 8) ? { currency: text(body.locale.currency, 8) } : {}),
        ...(text(body.locale.language, 40) ? { language: text(body.locale.language, 40) } : {}),
      };
    }
    await updateOrganization(orgId, patch);
    await logAudit(req.user?.id, 'org.profile.update', orgId, { fields: Object.keys(patch) });
    const org = await loadOrg(orgId);
    return res.json({ name: org?.name, slug: org?.slug, profile: org?.profile ?? {}, locale: org?.locale ?? {} });
  } catch (err) {
    return fail(res, err);
  }
});

/* ══ Branding & app experience ════════════════════════════════════════════ */

/**
 * Where each setting shows up, and when. The server is the source of truth for
 * this so the screen can never claim a change reached a binary it cannot.
 */
const EFFECTS: Record<string, { web: string; app: string }> = {
  appName: { web: 'immediately', app: 'after sign-in; the launch and sign-in screens change with the next app build' },
  tagline: { web: 'immediately', app: 'after sign-in; the launch screens change with the next app build' },
  primaryColor: { web: 'immediately', app: 'after sign-in; the launch and sign-in screens change with the next app build' },
  secondaryColor: { web: 'immediately', app: 'after sign-in; the launch and sign-in screens change with the next app build' },
  accentColor: { web: 'immediately', app: 'after sign-in' },
  logoUrl: { web: 'immediately', app: 'after sign-in; the app icon and launch logo change only with the next app build' },
  faviconUrl: { web: 'immediately', app: 'not used' },
  splashBackgroundColor: { web: 'not used', app: 'next app build' },
  splashImageUrl: { web: 'not used', app: 'next app build' },
  documentHeader: { web: 'immediately, on exported papers', app: 'not used' },
  documentAddress: { web: 'immediately, on exported papers', app: 'not used' },
  welcomeTitle: { web: 'not used', app: 'next app build' },
  welcomeSubtitle: { web: 'not used', app: 'next app build' },
  loginMessage: { web: 'not used', app: 'next app build' },
  shortName: { web: 'not used', app: 'next app build' },
};

const BRAND_TEXT: [string, number][] = [
  ['appName', 40], ['tagline', 80], ['documentHeader', 120], ['documentAddress', 200], ['emailFromName', 60],
];
const BRAND_COLORS = ['primaryColor', 'secondaryColor', 'accentColor', 'splashBackgroundColor'];
const BRAND_URLS = ['logoUrl', 'faviconUrl', 'splashImageUrl'];

async function brandingPayload(orgId: string) {
  const org = await loadOrg(orgId);
  const lastBuild = (await withoutTenantScope('org-admin:last-build', async () =>
    AppBuildJob.findOne({ orgId: new mongoose.Types.ObjectId(orgId), status: 'completed' })
      .sort({ completedAt: -1 })
      .select('completedAt appProfile buildNumber')
      .lean(),
  )) as { completedAt?: Date; appProfile?: string; buildNumber?: number } | null;
  const experience = (org?.appExperience ?? {}) as Record<string, any>;
  return {
    branding: org?.branding ?? {},
    appExperience: {
      shortName: experience.shortName ?? '',
      authCopy: {
        welcomeTitle: experience.authCopy?.welcomeTitle ?? '',
        welcomeSubtitle: experience.authCopy?.welcomeSubtitle ?? '',
        loginMessage: experience.authCopy?.loginMessage ?? '',
      },
      palette: experience.palette ?? {},
    },
    effects: EFFECTS,
    lastAppBuild: lastBuild
      ? { number: lastBuild.buildNumber, at: lastBuild.completedAt, audience: lastBuild.appProfile }
      : null,
    buildsBy: 'platform',
  };
}

router.get('/branding', read, async (_req, res) => {
  const orgId = orgOf(res);
  if (!orgId) return;
  return res.json(await brandingPayload(orgId));
});

router.put('/branding', branding, async (req: Req, res) => {
  const orgId = orgOf(res);
  if (!orgId) return;
  try {
    const body = (req.body ?? {}) as Record<string, any>;
    const org = await loadOrg(orgId);
    if (!org) return res.status(404).json({ message: 'Organization not found.' });
    const next: Record<string, string> = { ...(org.branding ?? {}) };
    const input = (body.branding ?? {}) as Record<string, unknown>;
    for (const [key, max] of BRAND_TEXT) if (key in input) next[key] = text(input[key], max) ?? '';
    for (const key of BRAND_COLORS) if (key in input) next[key] = colorOf(input[key]);
    for (const key of BRAND_URLS) if (key in input) next[key] = urlOf(input[key]);
    for (const key of Object.keys(next)) if (next[key] === '') delete next[key];
    await updateOrganization(orgId, { branding: next });

    const experience = (body.appExperience ?? null) as Record<string, any> | null;
    if (experience) {
      await setAppExperience(orgId, {
        shortName: text(experience.shortName, 24),
        authCopy: {
          welcomeTitle: text(experience.authCopy?.welcomeTitle, 70),
          welcomeSubtitle: text(experience.authCopy?.welcomeSubtitle, 140),
          loginMessage: text(experience.authCopy?.loginMessage, 140),
        },
        palette: experience.palette
          ? {
              splashBackgroundColor: colorOf(experience.palette.splashBackgroundColor) || undefined,
              successColor: colorOf(experience.palette.successColor) || undefined,
              warningColor: colorOf(experience.palette.warningColor) || undefined,
              dangerColor: colorOf(experience.palette.dangerColor) || undefined,
            }
          : undefined,
      } as never);
    }
    await logAudit(req.user?.id, 'org.branding.update', orgId, {
      fields: [...Object.keys(input), ...(experience ? ['appExperience'] : [])],
    });
    return res.json(await brandingPayload(orgId));
  } catch (err) {
    return fail(res, err);
  }
});

/** Upload a logo or splash image; returns its public URL for the branding form. */
router.post('/branding/asset', branding, uploadBrandAsset.single('file'), async (req: Req, res) => {
  const orgId = orgOf(res);
  if (!orgId) return;
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) return res.status(400).json({ message: 'Choose an image to upload.' });
  try {
    const stored = await putPublicTenantAsset({
      buffer: file.buffer,
      fileName: file.originalname,
      contentType: file.mimetype,
      module: 'branding',
      orgId,
      requireOrg: true,
    });
    await logAudit(req.user?.id, 'org.branding.asset', orgId, { file: file.originalname, bytes: file.size });
    return res.status(201).json({ url: stored.url });
  } catch (err) {
    return fail(res, err);
  }
});

/* ══ Registration ═════════════════════════════════════════════════════════ */

router.get('/registration', read, async (_req, res) => {
  const orgId = orgOf(res);
  if (!orgId) return;
  const org = await loadOrgForRegistration(orgId);
  if (!org) return res.status(404).json({ message: 'Organization not found.' });
  // The storage collection is platform detail; an institute is not shown it.
  return res.json(registrationView(org, { includeStore: false }));
});

router.put('/registration', settings, async (req: Req, res) => {
  const orgId = orgOf(res);
  if (!orgId) return;
  try {
    await updateRegistrationSettings(orgId, (req.body ?? {}) as Record<string, unknown>);
    await logAudit(req.user?.id, 'org.registration.update', orgId, {
      policy: req.body?.policy,
      roles: req.body?.roles,
    });
    return res.json(registrationView(await loadOrgForRegistration(orgId), { includeStore: false }));
  } catch (err) {
    return fail(res, err);
  }
});

/* ══ Academic configuration ═══════════════════════════════════════════════ */

router.get('/configuration', read, async (_req, res) => {
  const orgId = orgOf(res);
  if (!orgId) return;
  const [configuration, policy] = await Promise.all([getOrgConfiguration(orgId), getOrgPolicy(orgId)]);
  return res.json({ configuration, policy });
});

router.put('/configuration', settings, async (req: Req, res) => {
  const orgId = orgOf(res);
  if (!orgId) return;
  try {
    const body = (req.body ?? {}) as Record<string, any>;
    const input: ConfigInput = {};
    const list = (value: unknown) => (Array.isArray(value) ? value.slice(0, 200) : undefined);
    const classLevels = list(body.classLevels);
    if (classLevels) {
      input.classLevels = classLevels
        .map((c: any, i: number) => ({
          key: text(c?.key, 40) || text(c?.label, 40) || '',
          label: text(c?.label, 60) || text(c?.key, 60) || '',
          aliases: Array.isArray(c?.aliases) ? c.aliases.map((a: unknown) => text(a, 40)).filter(Boolean).slice(0, 10) : [],
          order: Number.isFinite(c?.order) ? Number(c.order) : i,
        }))
        .filter((c) => c.key && c.label);
    }
    const subjects = list(body.subjects);
    if (subjects) {
      input.subjects = subjects
        .map((s: any, i: number) => ({ name: text(s?.name, 60) || '', code: text(s?.code, 20), order: i }))
        .filter((s) => s.name);
    }
    const rooms = list(body.rooms);
    if (rooms) {
      input.rooms = rooms
        .map((r: any, i: number) => ({
          name: text(r?.name, 60) || '',
          capacity: Math.max(0, Math.min(10000, Number(r?.capacity) || 0)),
          order: i,
        }))
        .filter((r) => r.name);
    }
    const applied = await setOrganizationConfig(orgId, input);
    await logAudit(req.user?.id, 'org.config.update', orgId, applied);
    return res.json({ applied, configuration: await getOrgConfiguration(orgId) });
  } catch (err) {
    return fail(res, err);
  }
});

const POLICY_KEYS = ['exam', 'grading', 'attendance', 'leave'];

router.put('/policy', settings, async (req: Req, res) => {
  const orgId = orgOf(res);
  if (!orgId) return;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Only the policy sections the model defines; nothing else reaches $set.
    const policy: Record<string, unknown> = {};
    for (const key of POLICY_KEYS) {
      if (body[key] && typeof body[key] === 'object' && !Array.isArray(body[key])) policy[key] = body[key];
    }
    await setOrganizationPolicy(orgId, policy);
    await logAudit(req.user?.id, 'org.policy.update', orgId, { sections: Object.keys(policy) });
    return res.json({ policy: await getOrgPolicy(orgId) });
  } catch (err) {
    return fail(res, err);
  }
});

/* ══ Plan & modules (read-only) ═══════════════════════════════════════════ */

router.get('/plan', read, async (_req, res) => {
  const orgId = orgOf(res);
  if (!orgId) return;
  const [entitlement, subscription] = await Promise.all([getEntitlement(orgId), getSubscription(orgId)]);
  const sub = subscription as Record<string, any> | null;
  const enabled = new Set(entitlement.modules);
  return res.json({
    status: entitlement.status,
    writable: entitlement.writable,
    limits: entitlement.limits,
    modules: MODULES.map((m) => ({
      key: m.key,
      name: m.name,
      tier: m.tier,
      description: m.description,
      enabled: enabled.has(m.key),
    })),
    subscription: sub
      ? {
          plan: sub.planKey ?? sub.planName ?? null,
          status: sub.status ?? null,
          currentPeriodEnd: sub.currentPeriodEnd ?? null,
          trialEndsAt: sub.trialEndsAt ?? null,
        }
      : null,
    // Usage metering is not recorded yet; said plainly rather than shown as zero.
    usage: { tracked: false },
    managedBy: 'platform',
  });
});

/* ══ Audit ════════════════════════════════════════════════════════════════ */

router.get('/audit', requireStaffPermission('audit.read'), async (req, res) => {
  const orgId = orgOf(res);
  if (!orgId) return;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const skip = Math.max(0, Number(req.query.skip) || 0);

  if (req.query.source === 'platform') {
    // What platform staff did to THIS organization. Staff identities are the
    // platform's, not the institute's, so they are shown as a role only.
    const items = (await withoutTenantScope('org-admin:platform-audit', async () =>
      PlatformAudit.find({ orgId }).sort({ createdAt: -1 }).skip(skip).limit(limit).select('action entity createdAt').lean(),
    )) as { action: string; entity?: string; createdAt: Date }[];
    return res.json({
      items: items.map((i) => ({ action: i.action, entity: i.entity, at: i.createdAt, actor: 'Platform staff' })),
    });
  }

  const scope = requireTenantScope('org-admin:audit');
  const rows = (await AuditLog.find(scope).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()) as Record<string, any>[];
  const people = await User.find({ ...scope, _id: { $in: rows.map((r) => r.userId).filter(Boolean) } })
    .select('name email role')
    .lean();
  const byId = new Map(people.map((p) => [String(p._id), p]));
  const total = await AuditLog.countDocuments(scope);
  return res.json({
    total,
    items: rows.map((r) => {
      const who = byId.get(String(r.userId));
      return {
        id: String(r._id),
        action: r.action,
        entityId: r.entityId ?? null,
        details: r.metadata ?? null,
        at: r.createdAt,
        actor: who ? { name: who.name, email: who.email, role: who.role } : null,
      };
    }),
  });
});

/* ══ People: invitations, reset links, sessions ═══════════════════════════ */

/**
 * Invite someone: the account is created without a usable password, and the
 * response carries a one-time link for them to set one. See
 * core/accounts/accountLinks for why a link and not a password.
 */
router.post(
  '/invitations',
  requireStaffAnyPermission('users.create', 'students.create', 'teachers.create'),
  async (req: Req, res) => {
    const orgId = orgOf(res);
    if (!orgId) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = text(body.name, 80);
      const email = text(body.email, 120)?.toLowerCase();
      const role = String(body.role ?? '');
      const empCode = text(body.empCode, 40);
      if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.status(400).json({ message: 'A name and a valid email are required.' });
      }
      if (!['admin', 'teacher', 'student'].includes(role)) {
        return res.status(400).json({ message: 'Role must be admin, teacher or student.' });
      }
      if (!(await mayActOn(req, role, 'create'))) {
        return res.status(403).json({ message: 'You do not have permission to invite this kind of account.', code: 'PERMISSION_DENIED' });
      }
      if (role !== 'admin' && !empCode) {
        return res.status(400).json({ message: 'A student or employee code is required.' });
      }
      const taken = await withoutTenantScope('org-admin:invite-unique', async () =>
        User.exists({ $or: [{ email }, ...(empCode ? [{ empCode }] : [])] }),
      );
      if (taken) return res.status(409).json({ message: 'That email or code is already in use.' });

      let classLevel: string | undefined;
      let batch: string | undefined;
      if (role === 'student') {
        const resolved = await resolveStudentClassAndBatch(String(body.classLevel ?? ''), String(body.batch ?? ''));
        classLevel = resolved.classLevel;
        batch = resolved.batch;
      }
      const user = await User.create({
        name,
        email,
        password: unusablePassword(),
        role,
        status: 'approved',
        empCode,
        classLevel,
        batch,
        registrationSource: 'admin',
      });
      const invite = await issueInvite(user._id, String(req.user?.id ?? ''));
      await logAudit(req.user?.id, 'org.user.invite', String(user._id), { role, email });
      return res.status(201).json({
        user: { id: String(user._id), name: user.name, email: user.email, role: user.role },
        invite: { link: invite.link, token: invite.token, expiresAt: invite.expiresAt, delivery: invite.delivery },
      });
    } catch (err) {
      const message = (err as Error)?.message || '';
      if (/class|batch/i.test(message)) return res.status(400).json({ message });
      return fail(res, err);
    }
  },
);

async function targetUser(req: Request, res: Response, action: 'update') {
  const user = await User.findOne({ _id: req.params.id, ...requireTenantScope('org-admin:target') })
    .select('name email role status inviteTokenHash')
    .lean();
  if (!user) {
    res.status(404).json({ message: 'User not found' });
    return null;
  }
  if (!(await mayActOn(req, (user as { role?: string }).role, action))) {
    res.status(403).json({ message: 'You do not have permission to manage this account.', code: 'PERMISSION_DENIED' });
    return null;
  }
  return user as { _id: unknown; email: string; role: string; inviteTokenHash?: string };
}

router.post(
  '/users/:id/invite',
  requireStaffAnyPermission('users.update', 'students.update', 'teachers.update'),
  async (req: Req, res) => {
    const target = await targetUser(req, res, 'update');
    if (!target) return;
    if (!target.inviteTokenHash) {
      return res.status(409).json({ message: 'This person has already set a password. Send a reset link instead.' });
    }
    const invite = await issueInvite(target._id, String(req.user?.id ?? ''));
    await logAudit(req.user?.id, 'org.user.reinvite', String(target._id), {});
    return res.json({ invite: { link: invite.link, token: invite.token, expiresAt: invite.expiresAt, delivery: invite.delivery } });
  },
);

router.post(
  '/users/:id/reset-link',
  requireStaffAnyPermission('users.update', 'students.update', 'teachers.update'),
  async (req: Req, res) => {
    const target = await targetUser(req, res, 'update');
    if (!target) return;
    const link = await issueResetLink(target._id);
    await logAudit(req.user?.id, 'org.user.reset-link', String(target._id), {});
    return res.json({ reset: { link: link.link, token: link.token, expiresAt: link.expiresAt, delivery: link.delivery } });
  },
);

router.post(
  '/users/:id/sign-out',
  requireStaffAnyPermission('users.update', 'students.update', 'teachers.update'),
  async (req: Req, res) => {
    const target = await targetUser(req, res, 'update');
    if (!target) return;
    await revokeSessions(target._id);
    await logAudit(req.user?.id, 'org.user.sign-out', String(target._id), {});
    return res.json({ message: 'Signed out of every device.' });
  },
);

/** What this administrator may do here, so the panel shows only real actions. */
router.get('/capabilities', read, async (req, res) => {
  const can = async (...p: string[]) => holds(req, ...p);
  return res.json({
    profile: await can('org.settings'),
    branding: await can('org.branding'),
    registration: await can('org.settings'),
    configuration: await can('org.settings'),
    guardians: await can('guardians.manage'),
    audit: await can('audit.read'),
    settings: await can('org.settings'),
    invite: (await can('users.create')) || (await can('students.create')) || (await can('teachers.create')),
  });
});

export default router;
