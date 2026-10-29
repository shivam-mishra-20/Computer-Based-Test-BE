/**
 * Organization registrations — the pre-provisioning half of onboarding.
 *
 * ── Where this sits ─────────────────────────────────────────────────────────
 *
 *   public web form  ──►  submitRegistration()      status: PENDING
 *                                  │
 *                         platform staff review
 *                                  │
 *                    ┌─────────────┴─────────────┐
 *              rejectRegistration()        approveRegistration()
 *                 REJECTED                        │
 *                                        onboardOrganization()   ◄── EXISTING
 *                                                 │
 *                                          Org + orgId linked
 *                                              APPROVED
 *
 * ── What this file deliberately does NOT do ─────────────────────────────────
 * It does not create organizations, roles, entitlements, subscriptions or
 * users. Every one of those already has an implementation in
 * `onboarding.ts`, and a second one here would be a second set of rules to
 * keep in step. `approveRegistration()` gathers a payload and calls that
 * orchestrator; the provisioning sequence is entirely its.
 */

import { withoutTenantScope } from '../tenancy/context';
import { onboardOrganization, type OnboardingInput, type OnboardingResult } from './onboarding';
import { applicationToOnboardingInput } from './applicationProvisioning';
import {
  ORGANIZATION_TYPES,
  type IOrganizationRegistration,
  type OrganizationType,
} from '../../models/OrganizationRegistration';

/* ══════════════════════════════════════════════════════════════════════════
   Validation
   ══════════════════════════════════════════════════════════════════════════ */

export class RegistrationValidationError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super('Registration is not valid');
    this.name = 'RegistrationValidationError';
  }
}

export class RegistrationNotFound extends Error {
  constructor() {
    super('Registration not found');
    this.name = 'RegistrationNotFound';
  }
}

export class RegistrationNotActionable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationNotActionable';
  }
}

/**
 * Deliberately permissive: it rejects what is definitely not an address rather
 * than trying to decide what is. Address validity is only ever proven by
 * delivering to it, and a stricter pattern's failures are all false negatives
 * on real customers.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Digits, with the punctuation people actually type. Length checked after. */
const PHONE_ALLOWED_RE = /^[\d\s()+.-]+$/;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalCount(value: unknown, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) return undefined;
  return Math.floor(n);
}

/** Digits only, so `+91 98765 43210` and `09876543210` compare equal. */
export function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '');
}

export interface RegistrationInput {
  organizationName?: unknown;
  organizationType?: unknown;
  contactName?: unknown;
  designation?: unknown;
  email?: unknown;
  phone?: unknown;
  city?: unknown;
  state?: unknown;
  country?: unknown;
  estimatedStudents?: unknown;
  estimatedTeachers?: unknown;
  message?: unknown;
}

export interface CleanRegistration {
  organizationName: string;
  organizationType: OrganizationType;
  contactName: string;
  designation?: string;
  email: string;
  phone: string;
  city: string;
  state?: string;
  country?: string;
  estimatedStudents?: number;
  estimatedTeachers?: number;
  message?: string;
  dedupeKey: string;
}

/**
 * Validate and normalize one submission.
 *
 * Returns EVERY problem rather than the first: a public form should show all
 * six mistakes at once, not reveal them one submit at a time.
 */
export function validateRegistration(input: RegistrationInput): CleanRegistration {
  const fields: Record<string, string> = {};

  const organizationName = text(input.organizationName);
  if (organizationName.length < 2) fields.organizationName = 'Institute name is required.';
  else if (organizationName.length > 160) fields.organizationName = 'Institute name is too long.';

  const typeRaw = text(input.organizationType).toUpperCase();
  const organizationType = (ORGANIZATION_TYPES as string[]).includes(typeRaw)
    ? (typeRaw as OrganizationType)
    : undefined;
  if (!organizationType) fields.organizationType = 'Choose an organization type.';

  const contactName = text(input.contactName);
  if (contactName.length < 2) fields.contactName = 'Your name is required.';
  else if (contactName.length > 120) fields.contactName = 'Name is too long.';

  const designation = text(input.designation) || undefined;
  if (designation && designation.length > 120) fields.designation = 'Designation is too long.';

  const email = text(input.email).toLowerCase();
  if (!email) fields.email = 'Email is required.';
  else if (email.length > 254 || !EMAIL_RE.test(email)) fields.email = 'Enter a valid email address.';

  const phoneRaw = text(input.phone);
  const phoneDigits = normalizePhone(phoneRaw);
  if (!phoneRaw) fields.phone = 'Mobile number is required.';
  else if (!PHONE_ALLOWED_RE.test(phoneRaw) || phoneDigits.length < 7 || phoneDigits.length > 15) {
    fields.phone = 'Enter a valid mobile number.';
  }

  const city = text(input.city);
  if (city.length < 2) fields.city = 'City is required.';
  else if (city.length > 120) fields.city = 'City is too long.';

  const state = text(input.state) || undefined;
  if (state && state.length > 120) fields.state = 'State is too long.';

  const country = text(input.country) || 'India';
  if (country.length > 120) fields.country = 'Country is too long.';

  const message = text(input.message) || undefined;
  if (message && message.length > 2000) fields.message = 'Message is too long (2000 characters max).';

  if (Object.keys(fields).length) throw new RegistrationValidationError(fields);

  return {
    organizationName,
    organizationType: organizationType as OrganizationType,
    contactName,
    designation,
    email,
    // Stored as typed, so staff can read it back the way the applicant wrote
    // it. Only the dedupe key uses the digits-only form.
    phone: phoneRaw.slice(0, 32),
    city,
    state,
    country,
    estimatedStudents: optionalCount(input.estimatedStudents, 1_000_000),
    estimatedTeachers: optionalCount(input.estimatedTeachers, 100_000),
    message,
    dedupeKey: `${email}|${organizationName.toLowerCase().replace(/\s+/g, ' ')}`,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   Submission
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * How long two identical submissions are treated as the same one.
 *
 * Long enough to absorb a double-click, a refresh, a back-button resubmit and
 * a mobile network retry; short enough that an institute genuinely following
 * up next week gets a new row rather than silence.
 */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SubmitResult {
  registration: IOrganizationRegistration;
  /** True when an existing row was returned instead of a new one. */
  duplicate: boolean;
}

/**
 * Record a public submission.
 *
 * ── Why a duplicate is a success, not an error ──────────────────────────────
 * The failure modes here are a double-click, a refresh and a retry after a
 * timeout the client could not distinguish from a failure. Answering 409 to
 * any of those tells a person who did nothing wrong that something went wrong,
 * and the natural response — submitting again — makes it worse. So a repeat
 * inside the window returns the ORIGINAL registration and the same
 * confirmation. The applicant sees one clean outcome; staff see one row.
 */
export async function submitRegistration(
  input: RegistrationInput,
  meta: { ip?: string },
): Promise<SubmitResult> {
  const clean = validateRegistration(input);

  return withoutTenantScope('registration:submit', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OrganizationRegistration = require('../../models/OrganizationRegistration').default;

    const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
    const existing = await OrganizationRegistration.findOne({
      dedupeKey: clean.dedupeKey,
      createdAt: { $gte: since },
    }).sort({ createdAt: -1 });

    if (existing) return { registration: existing, duplicate: true };

    const created = await OrganizationRegistration.create({
      ...clean,
      source: 'WEB',
      // Truncated because a forwarded-for chain can be long, and this is for
      // triage rather than forensics.
      submittedIp: meta.ip ? String(meta.ip).slice(0, 64) : undefined,
      status: 'PENDING',
    });

    return { registration: created, duplicate: false };
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   Staff-facing reads
   ══════════════════════════════════════════════════════════════════════════ */

export interface ListRegistrationsQuery {
  status?: string;
  search?: string;
  limit?: number;
  skip?: number;
}

export async function listRegistrations(query: ListRegistrationsQuery) {
  return withoutTenantScope('registration:list', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OrganizationRegistration = require('../../models/OrganizationRegistration').default;

    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.search) {
      // Escaped: a search box is user input, and an unescaped `(` here is a
      // 500 rather than an empty result.
      const safe = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(safe, 'i');
      filter.$or = [{ organizationName: rx }, { contactName: rx }, { email: rx }, { city: rx }];
    }

    const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
    const skip = Math.max(query.skip ?? 0, 0);

    const [items, total] = await Promise.all([
      OrganizationRegistration.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        // The applicant's IP is abuse-triage data, not queue data.
        .select('-submittedIp -provisioningSteps')
        .lean(),
      OrganizationRegistration.countDocuments(filter),
    ]);

    // What each applicant paid online, one line per row (core/billing/registrationPayments).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { paymentSummariesFor } = require('../billing/registrationPayments');
    const summaries = await paymentSummariesFor((items as { _id: unknown }[]).map((r) => r._id));
    const withPayments = (items as Record<string, unknown>[]).map((r) => ({
      ...r,
      payment: summaries.get(String(r._id)) ?? { state: 'none', count: 0 },
    }));

    return { items: withPayments, total };
  });
}

export async function getRegistration(id: string) {
  return withoutTenantScope('registration:get', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OrganizationRegistration = require('../../models/OrganizationRegistration').default;
    return OrganizationRegistration.findById(id).lean();
  });
}

/**
 * The reviewing staff member's email, read from the record.
 *
 * The platform token deliberately carries only id, role and capabilities — see
 * `PlatformRequestUser` — so the email is looked up rather than trusted from a
 * claim. It is stored alongside the id because a review record should still
 * name its reviewer years later, when the account may have been deactivated or
 * the id may mean nothing to whoever is reading.
 */
async function staffEmail(id?: string): Promise<string | undefined> {
  if (!id) return undefined;
  return withoutTenantScope('registration:staff-email', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const PlatformUser = require('../../models/PlatformUser').default;
    const found = await PlatformUser.findById(id).select('email').lean();
    return found?.email as string | undefined;
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   Approval — which is entirely a call to the existing orchestrator
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * A URL-safe slug from an institute's name.
 *
 * Derived once and then STORED on the registration, because a slug is the key
 * `onboardOrganization()` is idempotent on. Re-deriving it on every approval
 * would be fine while the name is unchanged and would silently create a second
 * organization the moment staff corrected a typo in it.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export interface ApprovalInput {
  /** Staff may correct the derived slug before the first provisioning run. */
  slug?: string;
  status?: string;
  notes?: string;
  branding?: Record<string, unknown>;
  locale?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  subscription?: {
    planKey?: string;
    addOns?: string[];
    removals?: string[];
    overrides?: { modules?: string[]; limits?: Record<string, number> };
    status?: string;
  };
  customRoles?: { key: string; name: string; description?: string; permissions: string[] }[];
  /**
   * The initial administrator. Optional: staff may provision the organization
   * first and add the administrator later from the organization screen.
   *
   * Normally no password travels here: the applicant chose one on the public
   * form, stored only as a hash on the registration, and approval creates the
   * account with it. Without one (an older application, or staff naming a
   * different person) the account gets a one-time invitation link instead. A
   * hash is never accepted from this input — only from the registration.
   */
  admin?: { name: string; email: string; password?: string };
}

export interface ApprovalResult {
  registration: IOrganizationRegistration;
  onboarding: OnboardingResult;
  /** True when this call created the organization rather than resuming one. */
  created: boolean;
  /**
   * Modules the application asked for that the registry does not define.
   * Dropped rather than passed through — the entitlement resolver would ignore
   * them anyway, and reporting them is how a typo gets noticed.
   */
  droppedModules: string[];
  /** What happened to the plan the applicant chose. */
  plan: PlanOutcome;
}

/**
 * Approve a registration and provision its organization.
 *
 * ── Repeated approval is safe, in three layers ──────────────────────────────
 *
 *   1. The slug is stored on the registration the first time and reused on
 *      every later run, so the identity being provisioned cannot drift.
 *   2. `onboardOrganization()` step 1 looks the slug up and RESUMES an existing
 *      organization rather than failing — that is its documented behaviour and
 *      the reason this function does not need a lock.
 *   3. `orgId` is written back, so the caller can tell a first approval from a
 *      retry, and a retry reports `created: false`.
 *
 * A partial run — the existing 207 case — is preserved rather than smoothed
 * over: `provisioningComplete` records it, the failed steps are stored, and
 * calling this again picks up where it stopped.
 */
export async function approveRegistration(
  id: string,
  input: ApprovalInput,
  staff: { id?: string },
): Promise<ApprovalResult> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const OrganizationRegistration = require('../../models/OrganizationRegistration').default;

  const registration = await withoutTenantScope('registration:approve-load', async () =>
    OrganizationRegistration.findById(id),
  );
  if (!registration) throw new RegistrationNotFound();

  if (registration.status === 'REJECTED') {
    throw new RegistrationNotActionable(
      'This registration was rejected. Reopen it before approving.',
    );
  }

  const alreadyProvisioned = Boolean(registration.orgId);

  // The stored slug wins on every run after the first — see the note above.
  const slug =
    registration.orgSlug ||
    slugify(String(input.slug || '') || registration.organizationName);

  if (!slug) {
    throw new RegistrationNotActionable(
      'Could not derive a slug from the institute name. Provide one explicitly.',
    );
  }

  // ── The application is the base; staff input overrides it ────────────────
  // This is what makes approval one click. Everything the institute supplied —
  // branding, class levels, subjects, rooms, batches, policy, modules — is
  // mapped onto the SAME `onboardOrganization()` input an admin would
  // otherwise have typed by hand. See applicationProvisioning.ts.
  //
  // Staff still win wherever they disagree: an override is a correction, and a
  // correction that the applicant's data could silently undo would make the
  // console's edit controls a lie.
  //
  // A registration with no `application` — every row from before the long form
  // existed — maps to an empty base, so this behaves exactly as it did.
  const mapped = applicationToOnboardingInput(registration, {
    slug,
    status: input.status,
    notes: input.notes,
  });
  const base = mapped.input;

  // ── The administrator, with the password they chose when applying ───────
  // Read on its own (select: false) so the hash never rides along on the
  // document this function returns. It is used only for the person the
  // applicant named: if staff changed the email to someone else, that person
  // did not choose this password, and gets an invitation instead.
  const staffAdmin = input.admin && input.admin.name && input.admin.email
    ? { name: String(input.admin.name), email: String(input.admin.email), password: input.admin.password || undefined }
    : undefined;
  const applicant = mapped.adminPrefill;
  const stored = await withoutTenantScope('registration:approve-admin-password', async () =>
    OrganizationRegistration.findById(id).select('+adminPasswordHash').lean(),
  );
  const chosenHash: string | undefined = (stored as { adminPasswordHash?: string } | null)?.adminPasswordHash || undefined;
  let admin: OnboardingInput['admin'] = staffAdmin;
  if (chosenHash && applicant?.email && !staffAdmin?.password) {
    const target = staffAdmin ?? { name: applicant.name, email: applicant.email };
    if (target.email.trim().toLowerCase() === applicant.email.trim().toLowerCase()) {
      admin = { name: target.name, email: target.email, passwordHash: chosenHash };
    }
  }

  // ── Paid online while applying? Then the plan is what was paid for ───────
  // The organization is created WITHOUT a subscription, and the payment is
  // recorded against it afterwards (applyRegistrationPayment) — which starts
  // the subscription ACTIVE on the paid plan for the paid interval. No trial,
  // and no staff payment entry. A different plan needs the payment refunded
  // first: approving onto other terms would keep money for something not sold.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const payments = require('../billing/registrationPayments');
  const paid: Record<string, any> | null = await payments.effectivePayment(registration._id);
  if (paid && input.subscription?.planKey && String(input.subscription.planKey).toLowerCase() !== paid.planKey) {
    throw new RegistrationNotActionable(
      `This application paid online for ${paid.planName} (${paid.billingInterval}). ` +
        'Refund that payment from the registration before approving it on another plan.',
    );
  }

  // ── The plan: staff decide; the applicant's preference is the default ────
  const plan = paid
    ? {
        subscription: undefined,
        outcome: {
          preference: mapped.planPreference,
          applied: true,
          note: `${paid.planName} (${paid.billingInterval}) was paid online — the subscription starts active on it, no trial.`,
        } as PlanOutcome,
      }
    : await planForApproval(registration, mapped.planPreference, input.subscription, base.subscription);
  const subscription = paid ? undefined : input.subscription ?? plan.subscription ?? base.subscription;

  const onboarding = await onboardOrganization({
    organization: base.organization,
    branding: { ...(base.branding ?? {}), ...(input.branding ?? {}) },
    // The third place the App Experience was dropped: this call re-lists the
    // mapped input field by field, and it was not in the list. From the
    // application only — there is no staff override for it at approval; an
    // operator changes it afterwards on the organization's Registration tab.
    appExperience: base.appExperience,
    locale: { ...(base.locale ?? {}), ...(input.locale ?? {}) },
    configuration: (input.configuration ?? base.configuration) as never,
    policy: { ...(base.policy ?? {}), ...(input.policy ?? {}) },
    subscription,
    customRoles: input.customRoles,
    // The applicant's administrator signs in with the password they chose
    // (above); without one, the account is created with an invitation link.
    admin,
  }, { actor: { kind: 'platform', id: staff.id } });

  // The paid checkout becomes the organization's payment, and starts its plan.
  if (paid && onboarding.orgId) {
    const step = await payments.applyRegistrationPayment(paid, String(onboarding.orgId), registration.toObject(), {
      kind: 'platform',
      id: staff.id,
    });
    onboarding.steps.push(step);
    if (!step.ok) onboarding.complete = false;
  }

  // The account exists with that password now; nothing needs the hash again.
  const adminCreated = onboarding.steps.some((s) => s.step === 'admin-user' && s.ok);
  if (chosenHash && admin?.passwordHash && adminCreated) {
    await withoutTenantScope('registration:approve-clear-password', async () =>
      OrganizationRegistration.updateOne({ _id: registration._id }, { $unset: { adminPasswordHash: 1 } }),
    );
  }

  registration.status = 'APPROVED';
  registration.orgId = onboarding.orgId as never;
  registration.orgSlug = onboarding.slug;
  registration.provisionedAt = new Date();
  registration.provisioningComplete = onboarding.complete;
  registration.provisioningSteps = onboarding.steps;
  registration.reviewedBy = (staff.id as never) ?? registration.reviewedBy;
  registration.reviewedByEmail = (await staffEmail(staff.id)) ?? registration.reviewedByEmail;
  registration.reviewedAt = new Date();
  if (input.notes) registration.reviewNote = input.notes;

  await withoutTenantScope('registration:approve-save', async () => registration.save());

  return {
    registration,
    onboarding,
    created: !alreadyProvisioned,
    droppedModules: mapped.droppedModules,
    plan: plan.outcome,
  };
}

/**
 * What the applicant's plan preference means at approval.
 *
 *   staff named a subscription   staff win; the preference is only reported
 *   a subscription exists        nothing — a retry must never move an
 *                                organization back to the plan it asked for
 *                                after staff changed it
 *   self-serve plan on sale      a dated trial on that plan (with the modules
 *                                the application asked for as add-ons)
 *   custom pricing (Enterprise), not self-serve, or no longer on sale
 *                                no trial is started on it: terms are agreed
 *                                first, and staff set them in the console
 *
 * The trial itself is idempotent: onboarding checks for an existing
 * subscription and the orgId index is unique.
 */
async function planForApproval(
  registration: IOrganizationRegistration,
  preference: string | null,
  staffSubscription: ApprovalInput['subscription'],
  baseSubscription: ApprovalInput['subscription'],
): Promise<{ subscription?: ApprovalInput['subscription']; outcome: PlanOutcome }> {
  if (!preference) return { outcome: { preference: null, applied: false, note: 'No plan was chosen on the application.' } };
  if (staffSubscription) {
    return { outcome: { preference, applied: false, note: 'The reviewer chose the subscription at approval.' } };
  }
  if (registration.orgId) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Subscription = require('../../models/Subscription').default;
    const exists = await withoutTenantScope('registration:approve-sub-exists', async () =>
      Subscription.exists({ orgId: registration.orgId }),
    );
    if (exists) return { outcome: { preference, applied: false, note: 'The organization already has a subscription.' } };
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { listPublicPlans } = require('../subscriptions/catalogue');
  const offered = ((await listPublicPlans()) as { key: string; name: string; selfServe: boolean; customPricing: boolean }[])
    .find((p) => p.key === preference);
  if (!offered) {
    return { outcome: { preference, applied: false, note: `"${preference}" is no longer offered; assign a plan in the console.` } };
  }
  if (offered.customPricing || !offered.selfServe) {
    return {
      outcome: {
        preference,
        applied: false,
        note: `${offered.name} is agreed with the platform team, so no trial was started on it. Set its terms in the console.`,
      },
    };
  }
  // The modules the application asked for (known ones, mapped) stay add-ons.
  const addOns = baseSubscription?.addOns ?? [];
  return {
    subscription: { planKey: offered.key, status: 'trialing', ...(addOns.length ? { addOns } : {}) },
    outcome: {
      preference,
      applied: true,
      note: `${offered.name} trial started${addOns.length ? ', with the modules the application asked for as add-ons' : ''}.`,
    },
  };
}

export interface PlanOutcome {
  preference: string | null;
  applied: boolean;
  note: string;
}

/**
 * Reject, or ask for more information.
 *
 * A registration that already produced an organization cannot be rejected —
 * the tenant exists, and pretending otherwise would leave the record
 * contradicting the database. Suspend the organization instead.
 */
export async function setRegistrationVerdict(
  id: string,
  verdict: 'REJECTED' | 'INFO_REQUESTED' | 'PENDING',
  note: string | undefined,
  staff: { id?: string },
): Promise<IOrganizationRegistration> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const OrganizationRegistration = require('../../models/OrganizationRegistration').default;

  const registration = await withoutTenantScope('registration:verdict-load', async () =>
    OrganizationRegistration.findById(id),
  );
  if (!registration) throw new RegistrationNotFound();

  if (verdict === 'REJECTED' && registration.orgId) {
    throw new RegistrationNotActionable(
      'This registration has already been provisioned into an organization. ' +
        'Suspend the organization instead of rejecting the registration.',
    );
  }

  registration.status = verdict;
  registration.reviewedBy = (staff.id as never) ?? registration.reviewedBy;
  registration.reviewedByEmail = (await staffEmail(staff.id)) ?? registration.reviewedByEmail;
  registration.reviewedAt = new Date();
  if (note !== undefined) registration.reviewNote = note;

  await withoutTenantScope('registration:verdict-save', async () => registration.save());
  return registration;
}

/**
 * What the PUBLIC endpoint is allowed to echo back.
 *
 * A confirmation needs to prove the submission landed and give the applicant a
 * reference to quote. It does not need — and must not carry — the internal id
 * shape, the IP, review notes, staff identities, or anything about the
 * organization that approval may later create.
 */
export function publicView(registration: IOrganizationRegistration) {
  return {
    reference: publicReference(registration),
    organizationName: registration.organizationName,
    contactName: registration.contactName,
    email: registration.email,
    status: registration.status,
    submittedAt: registration.createdAt,
  };
}

/**
 * A short quotable reference.
 *
 * The last eight characters of the ObjectId, prefixed. Enough for staff to
 * find the row, and not the id itself — a raw ObjectId invites someone to try
 * it against other endpoints, and its timestamp prefix leaks the collection's
 * insertion rate.
 */
export function publicReference(registration: IOrganizationRegistration): string {
  return `REG-${String(registration._id).slice(-8).toUpperCase()}`;
}
