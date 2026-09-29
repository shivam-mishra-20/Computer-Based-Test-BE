/**
 * Public registration, decided per application and written where that
 * application's configuration says.
 *
 * ── The decision ────────────────────────────────────────────────────────────
 *
 *     deployment gate          ALLOW_PUBLIC_REGISTER — can this server take
 *                              public sign-ups at all
 *   + application policy       this organization's registration policy, read
 *                              from ITS record: open, approval, or invite-only
 *   + supported role           enabled by the organization AND authenticatable
 *                              by the platform; never admin
 *   + tenant validation        the organization exists, is live, owns a
 *                              provisioned store, and matches the application
 *                              the request says it is
 *   ─────────────────────────
 *   = allow, or a specific refusal
 *
 * The deployment flag is a safety gate, not the answer. With it on, an
 * institute that has not switched registration on still refuses — the flag
 * only decides whether ANY institute can.
 *
 * ── What the request is allowed to influence ────────────────────────────────
 * Which organization it is FOR — as a routing hint, resolved by the tenancy
 * middleware into the request's context — and the person's own details. That
 * is all. The policy that authorises the write and the collection that
 * receives it are both read from the SAME organization record, so a client
 * cannot combine one organization's open policy with another's storage: change
 * the hint and you change both together.
 *
 * Fields a client might add to steer the write — `orgId`, `collection`,
 * `applicationId`, `status` — are never read from the body. A declared
 * application (the `X-App-Id` header) is checked AGAINST the organization; it
 * cannot select one.
 *
 * ── Why the account is created too ──────────────────────────────────────────
 * The registration record goes to the application's own collection. The account
 * — email, password hash, role, status — goes to the platform's tenant-
 * partitioned user store, stamped with the organization, pending or approved
 * exactly as before. Login, token verification and every approval screen read
 * that store; an account anywhere else is one nobody could ever approve or sign
 * into. The two are written in one transaction and point at each other.
 */

import mongoose from 'mongoose';
import Org from '../../models/Org';
import User from '../../models/User';
import {
  resolveBrandConfig,
  SUPPORTED_AUTH_ROLES,
  type BrandConfig,
  type BrandRole,
} from '../platform/mobileBuildRules';
import { withoutTenantScope } from '../tenancy/context';
import GuardianLink from '../../models/GuardianLink';
import { findWardByCredentials, requestLink } from '../guardians/guardians';
import {
  registrationModel,
  requestFingerprint,
  resolveRegistrationStore,
  RegistrationStoreMisconfigured,
} from './registrationStore';

/* ══════════════════════════════════════════════════════════════════════════
   Refusals
   ══════════════════════════════════════════════════════════════════════════ */

export type RegistrationRefusalCode =
  | 'REGISTRATION_DISABLED' // the deployment does not take public sign-ups
  | 'UNKNOWN_APPLICATION' // no live organization behind the request
  | 'APPLICATION_MISMATCH' // the declared app is not this organization's
  | 'REGISTRATION_CLOSED' // this organization has registration switched off
  | 'REGISTRATION_NOT_CONFIGURED' // switched on, but no storage provisioned
  | 'ROLE_NOT_ALLOWED' // admin, ever
  | 'ROLE_NOT_AVAILABLE' // not enabled here, or not supported by the platform
  | 'INVALID_DETAILS' // the person's own details failed validation
  | 'ALREADY_REGISTERED' // an account or registration exists for this email here
  | 'WARD_NOT_VERIFIED'; // a parent's ward details matched no student here

/**
 * A refusal, with the HTTP status it maps to and a sentence a person can read.
 *
 * The messages never name a collection, a database or another organization:
 * the only thing a refusal may reveal is what the caller can do next.
 */
export class RegistrationRefused extends Error {
  constructor(
    readonly code: RegistrationRefusalCode,
    readonly httpStatus: number,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'RegistrationRefused';
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   The policy, as the app should present it
   ══════════════════════════════════════════════════════════════════════════ */

export function deploymentAllowsRegistration(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ALLOW_PUBLIC_REGISTER === 'true';
}

/** Statuses in which an organization may take new registrations. */
const LIVE_STATUSES = new Set(['active', 'trialing']);

interface LoadedOrg {
  _id: unknown;
  name?: string;
  slug?: string;
  status?: string;
  branding?: { tagline?: string; appName?: string };
  appExperience?: Record<string, unknown>;
  mobile?: { androidPackage?: string; iosBundleId?: string };
  registrationStore?: { collection?: string };
}

async function loadOrg(orgId: string): Promise<LoadedOrg | null> {
  if (!mongoose.isValidObjectId(orgId)) return null;
  return withoutTenantScope('registration:load-org', async () =>
    Org.findById(orgId)
      .select(
        'name slug status branding appExperience mobile registrationStore',
      )
      .lean(),
  );
}

/** The organization's brand, completed — the same function the build uses. */
function brandOf(org: LoadedOrg): BrandConfig {
  const experience = (org.appExperience ?? {}) as Record<string, unknown>;
  return resolveBrandConfig({
    appName: org.branding?.appName || org.name,
    tagline: org.branding?.tagline,
    shortName: experience.shortName as string | undefined,
    authCopy: experience.authCopy as never,
    roles: experience.roles as never,
    registrationPolicy: experience.registrationPolicy as never,
  });
}

export interface RegistrationPolicyView {
  /** Whether this app will accept a registration right now. */
  open: boolean;
  /** Why not, in a word the app can switch on. */
  reason:
    | 'closed'
    | 'deployment'
    | 'not-configured'
    | 'unknown-application'
    | null;
  /** Roles this app may register, in order. Empty when closed. */
  roles: BrandRole[];
  /** Whether a student's account waits for an administrator. */
  studentApprovalRequired: boolean;
  /** Teachers always wait. Stated so the app does not have to know it. */
  teacherApprovalRequired: true;
  /** The organization's own words for the register screen. */
  message: string;
  support: { email: string; phone: string };
}

/**
 * What the register screen should offer, for the organization in context.
 *
 * Public, pre-authentication, and deliberately thin: it says whether the door is
 * open and which roles may use it — never where anything is stored.
 */
export async function registrationPolicyFor(
  orgId: string | null,
): Promise<RegistrationPolicyView> {
  const closed = (
    reason: RegistrationPolicyView['reason'],
    brand?: BrandConfig,
  ): RegistrationPolicyView => ({
    open: false,
    reason,
    roles: [],
    studentApprovalRequired: true,
    teacherApprovalRequired: true,
    message:
      brand?.authCopy.registerMessage ??
      'Accounts here are created by your institute.',
    support: {
      email: brand?.authCopy.supportEmail ?? '',
      phone: brand?.authCopy.supportPhone ?? '',
    },
  });

  if (!orgId) return closed('unknown-application');
  const org = await loadOrg(orgId);
  if (!org || !LIVE_STATUSES.has(String(org.status ?? '').toLowerCase())) {
    return closed('unknown-application');
  }
  const brand = brandOf(org);
  if (brand.registrationPolicy === 'invite') return closed('closed', brand);
  if (!deploymentAllowsRegistration()) return closed('deployment', brand);
  if (!org.registrationStore?.collection)
    return closed('not-configured', brand);

  return {
    open: true,
    reason: null,
    roles: brand.roles,
    studentApprovalRequired: brand.registrationPolicy !== 'open',
    teacherApprovalRequired: true,
    message: brand.authCopy.registerMessage,
    support: {
      email: brand.authCopy.supportEmail,
      phone: brand.authCopy.supportPhone,
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   Validation
   ══════════════════════════════════════════════════════════════════════════ */

export interface RegistrationDetails {
  name: string;
  email: string;
  phone: string;
  password: string;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * The person's details, validated and normalised — and nothing else.
 *
 * Built from named fields rather than spreading the body, so a key a client
 * adds (`role: 'admin'`, `orgId`, `status`, `collection`) has nowhere to go.
 */
export function validateDetails(
  body: Record<string, unknown>,
): RegistrationDetails {
  const name =
    typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  const email =
    typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const fields: Record<string, string> = {};
  if (!name) fields.name = 'Tell us your name.';
  else if (name.length > 120) fields.name = 'That name is too long.';
  if (!EMAIL.test(email) || email.length > 254)
    fields.email = 'That does not look like an email address.';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15)
    fields.phone = 'Enter a contact number.';
  if (password.length < 8) fields.password = 'Use at least 8 characters.';
  else if (password.length > 128)
    fields.password = 'That password is too long.';

  if (Object.keys(fields).length) {
    throw new RegistrationRefused(
      'INVALID_DETAILS',
      400,
      'Please correct the highlighted details.',
      fields,
    );
  }
  return { name, email, phone, password };
}

/**
 * The role asked for, or a refusal.
 *
 * An absent role means student, which is what every client that predates role
 * selection sends. An EXPLICIT role that is not available is refused rather
 * than downgraded: a teacher who is silently registered as a student has been
 * told nothing and given the wrong account.
 */
export function resolveRole(requested: unknown, brand: BrandConfig): BrandRole {
  const text =
    requested === undefined || requested === null || requested === ''
      ? 'student'
      : String(requested).trim().toLowerCase();

  if (text === 'admin' || text === 'owner' || text === 'superadmin') {
    throw new RegistrationRefused(
      'ROLE_NOT_ALLOWED',
      403,
      'That kind of account cannot be created here.',
    );
  }
  const role = text as BrandRole;
  if (
    !(SUPPORTED_AUTH_ROLES as readonly string[]).includes(role) ||
    !brand.roles.includes(role)
  ) {
    throw new RegistrationRefused(
      'ROLE_NOT_AVAILABLE',
      400,
      'That kind of account is not available in this app.',
    );
  }
  return role;
}

/**
 * Does the application the request declared belong to this organization?
 *
 * Only checked when declared. An undeclared application is not proof of
 * anything either way — see the report on attestation — but a DECLARED one that
 * names a different organization's app is a request trying to be two things at
 * once, and is refused.
 */
export function checkApplication(
  declared: string | null | undefined,
  org: LoadedOrg,
): string | null {
  const value = String(declared ?? '')
    .trim()
    .toLowerCase();
  if (!value) return null;
  const own = [org.mobile?.androidPackage, org.mobile?.iosBundleId]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim().toLowerCase());
  if (!own.includes(value)) {
    throw new RegistrationRefused(
      'APPLICATION_MISMATCH',
      400,
      'This app cannot register accounts for that institute.',
    );
  }
  return value;
}

/* ══════════════════════════════════════════════════════════════════════════
   The write
   ══════════════════════════════════════════════════════════════════════════ */

export interface RegistrationInput {
  /** From the tenancy middleware's context. Never from the body. */
  orgId: string | null;
  /** The `X-App-Id` header, if the client sent one. */
  declaredApplication?: string | null;
  body: Record<string, unknown>;
  source: 'app' | 'website' | 'unknown';
  ip?: string | null;
}

export interface RegistrationResult {
  status: 'pending' | 'approved';
  role: BrandRole;
  userId: string;
  registrationId: string;
  /** For the audit log and the response message, not for the client. */
  orgId: string;
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}

function transactionsUnsupported(err: unknown): boolean {
  const e = err as { code?: number; codeName?: string; message?: string };
  return (
    e?.code === 20 ||
    e?.codeName === 'IllegalOperation' ||
    /Transaction numbers are only allowed/i.test(String(e?.message ?? ''))
  );
}

/**
 * Register one person, or refuse with a reason.
 *
 * Every check happens BEFORE either write, and the writes happen together:
 * inside a transaction where the database supports one, otherwise with the
 * account removed again if its registration record cannot be written. Either
 * way there is never an account without the registration that explains it.
 */
export async function registerPublicly(
  input: RegistrationInput,
): Promise<RegistrationResult> {
  // 1. The deployment gate.
  if (!deploymentAllowsRegistration()) {
    throw new RegistrationRefused(
      'REGISTRATION_DISABLED',
      405,
      'Public registration is disabled. Ask an administrator to create your account.',
    );
  }

  // 2. The organization — from context, which the middleware resolved from the
  //    hint. Not live, or not there, is the same answer: unknown.
  const orgId = input.orgId;
  const org = orgId ? await loadOrg(orgId) : null;
  if (
    !orgId ||
    !org ||
    !LIVE_STATUSES.has(String(org.status ?? '').toLowerCase())
  ) {
    throw new RegistrationRefused(
      'UNKNOWN_APPLICATION',
      400,
      'This app is not set up for registration.',
    );
  }

  // 3. The application the request says it is, checked against the org.
  const applicationId = checkApplication(input.declaredApplication, org);

  // 4. The organization's own policy.
  const brand = brandOf(org);
  if (brand.registrationPolicy === 'invite') {
    throw new RegistrationRefused(
      'REGISTRATION_CLOSED',
      403,
      brand.authCopy.registerMessage,
    );
  }

  // 5. Where it goes. No store, no write — never a default.
  let collection: string;
  try {
    collection = await resolveRegistrationStore(orgId);
  } catch (err) {
    if (err instanceof RegistrationStoreMisconfigured) {
      throw new RegistrationRefused(
        'REGISTRATION_NOT_CONFIGURED',
        503,
        'Registration is not available in this app yet. Please contact your institute.',
      );
    }
    throw err;
  }

  // 6–7. Role and details.
  const role = resolveRole(input.body.role, brand);
  const details = validateDetails(input.body);

  // 7b. A parent names a ward — by the institute-issued student code AND the
  //     ward's registered phone, never by picking from a list. The match is
  //     made HERE, on the server, in THIS organization; nothing the client
  //     sends can name a student id. One message for every way of being wrong,
  //     so a failed attempt says nothing about which codes exist.
  let wardId: mongoose.Types.ObjectId | null = null;
  if (role === 'parent') {
    const ward = await findWardByCredentials(orgId, input.body.wardCode, input.body.wardPhone);
    if (!ward) {
      throw new RegistrationRefused(
        'WARD_NOT_VERIFIED',
        400,
        "We couldn't verify that student. Check the student code and the student's registered phone number with your institute.",
        { wardCode: 'Check the student code and phone number.' },
      );
    }
    wardId = ward._id;
  }

  // 8. Duplicates, inside THIS organization and THIS application.
  const Registration = registrationModel(collection);
  const [account, prior] = await withoutTenantScope(
    'registration:duplicate-check',
    async () =>
      Promise.all([
        User.findOne({ orgId, email: details.email }).select('_id').lean(),
        Registration.findOne({ email: details.email }).select('_id').lean(),
      ]),
  );
  if (account || prior) {
    throw new RegistrationRefused(
      'ALREADY_REGISTERED',
      409,
      'An account with this email already exists here. Try signing in instead.',
      { email: 'An account with this email already exists here.' },
    );
  }

  // 9. The status this role gets under this policy. A teacher always waits:
  //    self-registering into live teaching permissions would be a privilege
  //    escalation with a sign-up button on it.
  //    A parent always waits too: until an administrator verifies the link,
  //    a parent has nothing they are entitled to see.
  const status: 'pending' | 'approved' =
    role === 'teacher' || role === 'parent' || brand.registrationPolicy !== 'open'
      ? 'pending'
      : 'approved';
  const policy = brand.registrationPolicy === 'open' ? 'open' : 'approval';

  const userId = new mongoose.Types.ObjectId();
  const registrationId = new mongoose.Types.ObjectId();

  const accountDoc = {
    _id: userId,
    // Explicit, not stamped from context: this runs outside the tenant scope,
    // and the organization is the one resolved above — the same record the
    // policy and the store came from.
    orgId,
    name: details.name,
    email: details.email,
    password: details.password,
    phone: details.phone,
    role,
    status,
    registrationSource: input.source,
    registrationId,
  };
  const recordDoc = {
    _id: registrationId,
    orgId,
    applicationId,
    role,
    name: details.name,
    email: details.email,
    phone: details.phone,
    status,
    policy,
    userId,
    source: input.source,
    requestedAt: new Date(),
    requestFingerprint: requestFingerprint(input.ip),
  };

  const writeBoth = async (session?: mongoose.ClientSession) =>
    withoutTenantScope('registration:write', async () => {
      await User.create([accountDoc], session ? { session } : {});
      await Registration.create([recordDoc], session ? { session } : {});
      // In the same transaction: a parent account never exists without the
      // pending relationship that explains it.
      if (wardId) await requestLink({ orgId, parentId: userId, studentId: wardId }, session);
    });

  try {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() => writeBoth(session));
    } catch (err) {
      if (!transactionsUnsupported(err)) throw err;
      // A standalone server (a developer's local mongod) has no transactions.
      // Same writes, with the account removed if its record cannot be written.
      try {
        await writeBoth();
      } catch (inner) {
        await withoutTenantScope('registration:compensate', async () =>
          Promise.all([
            User.deleteOne({ _id: userId, orgId }),
            Registration.deleteOne({ _id: registrationId }),
            GuardianLink.deleteOne({ orgId, parentId: userId }),
          ]),
        ).catch(() => undefined);
        throw inner;
      }
    } finally {
      await session.endSession();
    }
  } catch (err) {
    if (isDuplicateKey(err)) {
      // A race with a concurrent registration, or the platform-wide email
      // index that predates tenant-local uniqueness. Same answer either way,
      // and deliberately the same words as the check above.
      throw new RegistrationRefused(
        'ALREADY_REGISTERED',
        409,
        'An account with this email already exists here. Try signing in instead.',
        { email: 'An account with this email already exists here.' },
      );
    }
    throw err;
  }

  return {
    status,
    role,
    userId: String(userId),
    registrationId: String(registrationId),
    orgId,
  };
}
