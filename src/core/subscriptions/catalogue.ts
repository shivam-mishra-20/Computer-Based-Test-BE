/**
 * The plan catalogue: what can be sold, on what terms, and how terms change.
 *
 * ── Terms are versioned ─────────────────────────────────────────────────────
 * A plan's TERMS are its modules, limits, price, custom-pricing flag and trial
 * length. Changing any of them writes a new immutable PlanVersion and moves the
 * plan's `currentVersion`; subscribers stay on the version they were sold (see
 * models/PlanVersion.ts). Name, description, ordering and whether the plan is
 * on sale are presentation, and change in place.
 *
 * ── The default catalogue is DATA, and a draft ──────────────────────────────
 * DEFAULT_PLANS holds the agreed prices and student limits. The module matrix
 * is a proposal awaiting commercial review: it uses only modules that exist and
 * are enforced today, and leaves out the registry entries no feature backs yet
 * (whiteLabel, customDomain, apiAccess, advancedAnalytics, aiAnalysis),
 * `integrations`, whose only route is Abhigyan's own Firestore bridge, and
 * `attendance`: every way to RECORD attendance (upload, biometric sync) is
 * restricted to the legacy data owner, so for any other organization the
 * module would be empty screens. Seeding
 * creates missing plans and never overwrites one; after that the console owns
 * them.
 */

import { withoutTenantScope } from '../tenancy/context';
import { getModule, isCoreModule } from '../entitlements/moduleRegistry';

export class CatalogueError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogueError';
  }
}

/**
 * Limits a plan may set. Anything else is refused: a limit the platform does
 * not know is a limit nobody enforces, and staff would believe it was.
 *
 * `enforced` says whether a growth point refuses at this limit today; the
 * console shows the others as recorded but not yet enforced.
 */
export const LIMIT_KEYS: Record<string, { label: string; unit: string; enforced: boolean }> = {
  // Enforced in core/subscriptions/usage.ts — see its header for what counts.
  students: { label: 'Active students', unit: 'students', enforced: true },
  teachers: { label: 'Teachers', unit: 'accounts', enforced: true },
  admins: { label: 'Administrators', unit: 'accounts', enforced: true },
  aiGenerationsMonthly: { label: 'AI generations per month', unit: 'generations', enforced: true },
  appBuildsMonthly: { label: 'App builds per month', unit: 'builds', enforced: true },
  // Recorded on plans, NOT enforced: no authoritative per-organization byte
  // count exists, and signed-URL uploads go straight to the bucket.
  storageGb: { label: 'File storage', unit: 'GB', enforced: false },
  // Recorded, not enforced: no plan sets it and the limit is undecided.
  examsMonthly: { label: 'Exams per month', unit: 'exams', enforced: false },
};

export interface PlanTerms {
  modules: string[];
  limits: Record<string, number>;
  price: { monthly?: number; annual?: number; setupFee?: number; currency: string };
  customPricing: boolean;
  trialDays: number;
}

export interface PlanInput extends Partial<PlanTerms> {
  key: string;
  name: string;
  description?: string;
  isPublic?: boolean;
  isActive?: boolean;
  selfServe?: boolean;
  sortOrder?: number;
  changeNote?: string;
}

export interface CatalogueActor {
  id?: string;
  email?: string;
}

// ── The default catalogue ──────────────────────────────────────────────────

const STARTER_MODULES = [
  'students', 'teachers', 'classes', 'subjects',
  'exams', 'cbt', 'results', 'questionBank',
  'homework', 'materials', 'scheduling', 'doubts',
];
const GROWTH_MODULES = [
  ...STARTER_MODULES,
  'offlineTests', 'evaluation', 'rankings', 'analytics', 'courses', 'questionImport',
];
const PROFESSIONAL_MODULES = [...GROWTH_MODULES, 'ai'];

/**
 * The recommended catalogue (October 2026). Every ENFORCED limit is set, so a
 * plan says what it sells instead of "no limit" for everything but students:
 *
 *                       Starter   Growth   Professional   Enterprise
 *   Active students         100      500          1,500   5,000 (base, raised by agreement)
 *   Teachers                 10       40            120   unlimited
 *   Administrators            2        5             15   unlimited
 *   AI generations / month    0        0            500   2,000
 *   App builds / month        1        2              4   10
 *   Monthly price (₹)       999    2,999          7,999   custom
 *   Yearly price (₹)      9,990   29,990         79,990   custom   (two months free)
 *
 * Plans without the AI module carry AI generations 0 — "not included" — rather
 * than no limit, so the plan card and usage read honestly. Storage and exams
 * per month are not set: neither is measured yet (see LIMIT_KEYS).
 *
 * Existing plans are NOT changed by editing this list. `applyRecommendedCatalogue`
 * writes these terms as a new version of each plan (subscribers stay on the
 * version they were sold until staff move them), and `seedDefaultCatalogue`
 * creates only the plans that do not exist yet.
 */
export const RECOMMENDED_TERMS_NOTE = 'Recommended terms (October 2026): every enforced limit set; yearly price = 10 months.';

export const DEFAULT_PLANS: PlanInput[] = [
  {
    key: 'starter',
    name: 'Starter',
    description: 'For a single centre getting started: 100 students, 10 teachers, exams, homework and the question bank.',
    modules: STARTER_MODULES,
    limits: { students: 100, teachers: 10, admins: 2, aiGenerationsMonthly: 0, appBuildsMonthly: 1 },
    price: { monthly: 999, annual: 9990, currency: 'INR' },
    customPricing: false,
    trialDays: 14,
    selfServe: true,
    sortOrder: 10,
  },
  {
    key: 'growth',
    name: 'Growth',
    description: 'For growing institutes: 500 students and 40 teachers, with offline tests, evaluation, rankings and analytics.',
    modules: GROWTH_MODULES,
    limits: { students: 500, teachers: 40, admins: 5, aiGenerationsMonthly: 0, appBuildsMonthly: 2 },
    price: { monthly: 2999, annual: 29990, currency: 'INR' },
    customPricing: false,
    trialDays: 14,
    selfServe: true,
    sortOrder: 20,
  },
  {
    key: 'professional',
    name: 'Professional',
    description: 'For established institutes: 1,500 students and 120 teachers, with AI question and content generation (500 a month).',
    modules: PROFESSIONAL_MODULES,
    limits: { students: 1500, teachers: 120, admins: 15, aiGenerationsMonthly: 500, appBuildsMonthly: 4 },
    price: { monthly: 7999, annual: 79990, currency: 'INR' },
    customPricing: false,
    trialDays: 14,
    selfServe: true,
    sortOrder: 30,
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    description: 'For chains and large campuses: every feature, unlimited staff, 5,000+ students and higher AI and build allowances — priced and sized with the platform team.',
    modules: PROFESSIONAL_MODULES,
    // A sensible base for every Enterprise customer; each contract raises what
    // it needs through Subscription.overrides.limits.
    limits: { students: 5000, teachers: -1, admins: -1, aiGenerationsMonthly: 2000, appBuildsMonthly: 10 },
    price: { currency: 'INR' },
    customPricing: true,
    trialDays: 14,
    selfServe: false,
    sortOrder: 40,
  },
];

// ── Validation ─────────────────────────────────────────────────────────────

const KEY = /^[a-z][a-z0-9-]{1,39}$/;

/** Normalize and validate terms. Throws CatalogueError(400, 'PLAN_INVALID'). */
export function normalizeTerms(input: Partial<PlanTerms>): PlanTerms {
  const invalid = (message: string) => new CatalogueError(400, 'PLAN_INVALID', message);

  const modules = [...new Set((input.modules ?? []).map((m) => String(m).trim()).filter(Boolean))];
  const unknown = modules.filter((m) => !getModule(m));
  if (unknown.length) throw invalid(`Unknown module(s): ${unknown.join(', ')}.`);

  const limits: Record<string, number> = {};
  for (const [key, raw] of Object.entries(input.limits ?? {})) {
    if (raw === undefined || raw === null || (raw as unknown) === '') continue;
    if (!LIMIT_KEYS[key]) throw invalid(`Unknown limit "${key}". Known limits: ${Object.keys(LIMIT_KEYS).join(', ')}.`);
    const value = Number(raw);
    if (!Number.isInteger(value) || value < -1) throw invalid(`Limit "${key}" must be a whole number, or -1 for unlimited.`);
    limits[key] = value;
  }

  const customPricing = Boolean(input.customPricing);
  const price: PlanTerms['price'] = { currency: String(input.price?.currency || 'INR').toUpperCase() };
  for (const field of ['monthly', 'annual', 'setupFee'] as const) {
    const raw = input.price?.[field];
    if (raw === undefined || raw === null || (raw as unknown) === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw invalid(`The ${field === 'setupFee' ? 'setup fee' : `${field} price`} must be zero or more.`);
    price[field] = Math.round(value * 100) / 100;
  }
  if (!customPricing && price.monthly === undefined && price.annual === undefined) {
    throw invalid('A plan needs a monthly or annual price, or custom pricing.');
  }

  const trialDays = input.trialDays === undefined ? 14 : Number(input.trialDays);
  if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) throw invalid('Trial length is 0 to 365 days.');

  return {
    // Core modules are always on; listing them is harmless but is not a term.
    modules: modules.filter((m) => !isCoreModule(m)).sort(),
    limits: Object.fromEntries(Object.entries(limits).sort(([a], [b]) => a.localeCompare(b))),
    price,
    customPricing,
    trialDays,
  };
}

export function sameTerms(a: PlanTerms, b: PlanTerms): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(t: PlanTerms) {
  return {
    modules: [...t.modules].sort(),
    limits: Object.fromEntries(Object.entries(t.limits ?? {}).sort(([a], [b]) => a.localeCompare(b))),
    price: {
      monthly: t.price?.monthly ?? null,
      annual: t.price?.annual ?? null,
      setupFee: t.price?.setupFee ?? null,
      currency: t.price?.currency ?? 'INR',
    },
    customPricing: Boolean(t.customPricing),
    trialDays: t.trialDays ?? 14,
  };
}

function termsOfDoc(doc: Record<string, any>): PlanTerms {
  return {
    modules: [...(doc.modules ?? [])].filter((m: string) => !isCoreModule(m)).sort(),
    limits: { ...(doc.limits ?? {}) },
    price: {
      ...(doc.price?.monthly !== undefined && doc.price?.monthly !== null ? { monthly: doc.price.monthly } : {}),
      ...(doc.price?.annual !== undefined && doc.price?.annual !== null ? { annual: doc.price.annual } : {}),
      ...(doc.price?.setupFee !== undefined && doc.price?.setupFee !== null ? { setupFee: doc.price.setupFee } : {}),
      currency: doc.price?.currency ?? 'INR',
    },
    customPricing: Boolean(doc.customPricing),
    trialDays: doc.trialDays ?? 14,
  };
}

// ── Models (required lazily so this module loads before models compile) ────

const models = () => ({
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Plan: require('../../models/Plan').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  PlanVersion: require('../../models/PlanVersion').default,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Subscription: require('../../models/Subscription').default,
});

const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

/**
 * Give a plan created before versioning its first version, and pin the
 * subscriptions already on it to that version.
 *
 * Without this, the first edit of a legacy plan would change the terms of
 * every subscription that references it by `planId` — the exact silent change
 * versioning exists to prevent.
 */
export async function ensureVersioned(planKey: string): Promise<number> {
  return withoutTenantScope('catalogue:ensure-versioned', async () => {
    const { Plan, PlanVersion, Subscription } = models();
    const plan = await Plan.findOne({ key: planKey }).lean();
    if (!plan) throw new CatalogueError(404, 'PLAN_NOT_FOUND', `Plan "${planKey}" was not found.`);
    if (plan.currentVersion) return plan.currentVersion as number;

    try {
      await PlanVersion.create({
        planKey: plan.key,
        version: 1,
        name: plan.name,
        ...termsOfDoc(plan),
        changeNote: 'Terms in force when versioning was introduced.',
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
    await Plan.updateOne({ _id: plan._id, currentVersion: { $exists: false } }, { $set: { currentVersion: 1 } });
    await Subscription.updateMany(
      { planId: plan._id, planVersion: { $exists: false } },
      { $set: { planKey: plan.key, planVersion: 1 } },
    );
    return 1;
  }) as Promise<number>;
}

/**
 * Create a plan, or edit one. A change of TERMS writes a new version; a change
 * of presentation does not.
 */
export async function upsertPlanVersioned(
  input: PlanInput,
  actor: CatalogueActor = {},
): Promise<{ plan: Record<string, any>; version: number; newVersion: boolean }> {
  const key = String(input.key ?? '').trim().toLowerCase();
  if (!KEY.test(key)) throw new CatalogueError(400, 'PLAN_INVALID', 'A plan key is 2–40 lowercase letters, digits or hyphens.');
  const name = String(input.name ?? '').trim();
  if (!name) throw new CatalogueError(400, 'PLAN_INVALID', 'A plan needs a name.');

  return withoutTenantScope('catalogue:upsert', async () => {
    const { Plan, PlanVersion } = models();
    const existing = await Plan.findOne({ key }).lean();

    // Unspecified terms keep their current value, so a rename never resets limits.
    const base = existing ? termsOfDoc(existing) : undefined;
    const terms = normalizeTerms({
      modules: input.modules ?? base?.modules,
      limits: input.limits ?? base?.limits,
      price: input.price ?? base?.price,
      customPricing: input.customPricing ?? base?.customPricing,
      trialDays: input.trialDays ?? base?.trialDays,
    });
    // Custom pricing is never self-served: an institute cannot pick its own price.
    const selfServe = terms.customPricing ? false : input.selfServe ?? existing?.selfServe ?? false;

    const presentation = {
      name,
      description: input.description ?? existing?.description,
      isPublic: input.isPublic ?? existing?.isPublic ?? true,
      isActive: input.isActive ?? existing?.isActive ?? true,
      selfServe,
      sortOrder: input.sortOrder ?? existing?.sortOrder ?? 0,
    };
    const mirror = {
      modules: terms.modules,
      limits: terms.limits,
      price: terms.price,
      customPricing: terms.customPricing,
      trialDays: terms.trialDays,
    };

    let current = existing?.currentVersion as number | undefined;
    if (existing && !current) current = await ensureVersioned(key);

    if (existing && base && sameTerms(base, terms)) {
      const plan = await Plan.findOneAndUpdate({ key }, { $set: presentation }, { new: true }).lean();
      return { plan, version: current!, newVersion: false };
    }

    const version = (current ?? 0) + 1;
    try {
      await PlanVersion.create({
        planKey: key,
        version,
        name,
        ...terms,
        createdBy: actor.id || actor.email ? { id: actor.id, email: actor.email } : undefined,
        changeNote: input.changeNote,
      });
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new CatalogueError(409, 'PLAN_VERSION_CONFLICT', 'This plan was changed by someone else. Reload it and try again.');
      }
      throw error;
    }

    if (!existing) {
      try {
        const created = await Plan.create({ key, ...presentation, ...mirror, currentVersion: version });
        return { plan: created.toObject(), version, newVersion: true };
      } catch (error) {
        if (isDuplicateKey(error)) {
          throw new CatalogueError(409, 'PLAN_VERSION_CONFLICT', 'This plan was created by someone else. Reload and try again.');
        }
        throw error;
      }
    }

    const plan = await Plan.findOneAndUpdate(
      { key, currentVersion: current },
      { $set: { ...presentation, ...mirror, currentVersion: version } },
      { new: true },
    ).lean();
    if (!plan) throw new CatalogueError(409, 'PLAN_VERSION_CONFLICT', 'This plan was changed by someone else. Reload it and try again.');
    return { plan, version, newVersion: true };
  }) as Promise<{ plan: Record<string, any>; version: number; newVersion: boolean }>;
}

/** Put a plan on sale or take it off. Existing subscribers are unaffected either way. */
export async function setPlanActive(planKey: string, active: boolean) {
  return withoutTenantScope('catalogue:set-active', async () => {
    const { Plan } = models();
    const plan = await Plan.findOneAndUpdate({ key: planKey.toLowerCase() }, { $set: { isActive: active } }, { new: true }).lean();
    if (!plan) throw new CatalogueError(404, 'PLAN_NOT_FOUND', `Plan "${planKey}" was not found.`);
    return plan;
  });
}

/** Create the default plans that do not exist yet. Never overwrites one. */
export async function seedDefaultCatalogue(actor: CatalogueActor = {}) {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const plan of DEFAULT_PLANS) {
    const exists = await withoutTenantScope('catalogue:seed-check', async () => models().Plan.exists({ key: plan.key }));
    if (exists) {
      skipped.push(plan.key);
      continue;
    }
    try {
      await upsertPlanVersioned({ ...plan, changeNote: RECOMMENDED_TERMS_NOTE }, actor);
      created.push(plan.key);
    } catch (error) {
      // Seeded by someone else between the check and the write.
      if ((error as CatalogueError).code === 'PLAN_VERSION_CONFLICT') skipped.push(plan.key);
      else throw error;
    }
  }
  return { created, skipped };
}

/**
 * The recommended catalogue next to what each plan has now — what applying it
 * would change, and how many organizations sit on each version.
 */
export async function recommendedCatalogueDiff() {
  return withoutTenantScope('catalogue:recommended-diff', async () => {
    const { Plan, Subscription } = models();
    const out = [];
    for (const rec of DEFAULT_PLANS) {
      const existing = await Plan.findOne({ key: rec.key }).lean();
      const recommended = normalizeTerms(rec);
      const current = existing ? termsOfDoc(existing) : null;
      const subs = existing
        ? await Subscription.aggregate([{ $match: { planKey: rec.key } }, { $group: { _id: '$planVersion', n: { $sum: 1 } } }])
        : [];
      out.push({
        key: rec.key,
        name: rec.name,
        exists: Boolean(existing),
        currentVersion: (existing?.currentVersion as number | undefined) ?? null,
        changes: !current || !sameTerms(current, recommended),
        current: current ? { limits: current.limits, price: current.price, modules: current.modules, trialDays: current.trialDays } : null,
        recommended: { limits: recommended.limits, price: recommended.price, modules: recommended.modules, trialDays: recommended.trialDays },
        subscribers: Object.fromEntries((subs as { _id: number | null; n: number }[]).map((r) => [String(r._id ?? 'unversioned'), r.n])),
      });
    }
    return out;
  }) as Promise<Record<string, any>[]>;
}

/**
 * Adopt the recommended catalogue: a plan that is missing is created; a plan
 * whose terms differ gets them as a NEW VERSION (its subscribers keep theirs
 * until moved); a plan already on them only has its presentation refreshed.
 * Name, availability and listing are not touched for existing plans.
 */
export async function applyRecommendedCatalogue(actor: CatalogueActor = {}) {
  const results: { key: string; version: number; newVersion: boolean; created: boolean }[] = [];
  for (const rec of DEFAULT_PLANS) {
    const exists = await withoutTenantScope('catalogue:apply-check', async () => models().Plan.findOne({ key: rec.key }).select('name').lean());
    const input: PlanInput = exists
      ? { ...rec, name: (exists as { name: string }).name, changeNote: RECOMMENDED_TERMS_NOTE }
      : { ...rec, changeNote: RECOMMENDED_TERMS_NOTE };
    const r = await upsertPlanVersioned(input, actor);
    results.push({ key: rec.key, version: r.version, newVersion: r.newVersion, created: !exists });
  }
  return results;
}

export async function getPlanVersion(planKey: string, version: number) {
  return withoutTenantScope('catalogue:read-version', async () =>
    models().PlanVersion.findOne({ planKey: planKey.toLowerCase(), version }).lean(),
  ) as Promise<Record<string, any> | null>;
}

export async function listPlanVersions(planKey: string) {
  return withoutTenantScope('catalogue:list-versions', async () =>
    models().PlanVersion.find({ planKey: planKey.toLowerCase() }).sort({ version: -1 }).lean(),
  ) as Promise<Record<string, any>[]>;
}

/**
 * The catalogue as a customer sees it: plans on sale and listed publicly, in
 * order, with their current terms. Used by the registration form and by an
 * organization admin choosing an upgrade. A plan off sale or unlisted is not
 * offered, though existing subscribers keep it.
 */
export async function listPublicPlans() {
  const rows = (await withoutTenantScope('catalogue:public', async () =>
    models().Plan.find({ isActive: { $ne: false }, isPublic: { $ne: false } }).sort({ sortOrder: 1, name: 1 }).lean(),
  )) as Record<string, any>[];
  return rows.map((plan) => {
    const terms = termsOfDoc(plan);
    return {
      key: plan.key as string,
      name: plan.name as string,
      description: (plan.description as string | undefined) ?? null,
      selfServe: Boolean(plan.selfServe) && !terms.customPricing,
      customPricing: terms.customPricing,
      price: terms.customPricing ? { currency: terms.price.currency } : terms.price,
      trialDays: terms.trialDays,
      limits: terms.limits,
      modules: terms.modules.map((key) => ({ key, name: getModule(key)?.name ?? key })),
      version: (plan.currentVersion as number | undefined) ?? null,
    };
  });
}

export async function findPlan(planKey: string) {
  return withoutTenantScope('catalogue:find-plan', async () =>
    models().Plan.findOne({ key: String(planKey).toLowerCase() }).lean(),
  ) as Promise<Record<string, any> | null>;
}

/**
 * The terms a subscription is entitled to.
 *
 *   planKey + planVersion  the immutable version it was sold (the normal case)
 *   planId only            a subscription from before versioning: the plan's
 *                          current terms, as it always was
 *   neither                no plan — add-ons and overrides only
 */
export async function termsForSubscription(sub: {
  planKey?: string | null;
  planVersion?: number | null;
  planId?: unknown;
}): Promise<(PlanTerms & { planKey?: string; planVersion?: number; name?: string }) | null> {
  return withoutTenantScope('catalogue:terms', async () => {
    const { Plan, PlanVersion } = models();
    if (sub.planKey && sub.planVersion) {
      const version = await PlanVersion.findOne({ planKey: sub.planKey, version: sub.planVersion }).lean();
      if (version) return { ...termsOfDoc(version), planKey: version.planKey, planVersion: version.version, name: version.name };
      // A pinned version that does not exist is a data error. Falling back to
      // the plan's current terms keeps a paying customer working; resolving to
      // nothing would lock them out over a bug that is not theirs.
      console.error(`[catalogue] ${sub.planKey} v${sub.planVersion} is missing; using the plan's current terms.`);
      const plan = await Plan.findOne({ key: sub.planKey }).lean();
      return plan ? { ...termsOfDoc(plan), planKey: plan.key, planVersion: plan.currentVersion, name: plan.name } : null;
    }
    if (sub.planId) {
      const plan = await Plan.findById(sub.planId).lean();
      return plan ? { ...termsOfDoc(plan), planKey: plan.key, name: plan.name } : null;
    }
    return null;
  }) as Promise<(PlanTerms & { planKey?: string; planVersion?: number; name?: string }) | null>;
}
