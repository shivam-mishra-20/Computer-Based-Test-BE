/**
 * An organization's app experience — read, validated and written in ONE place.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * Two routes write `Org.appExperience`: provisioning a new institute from its
 * onboarding application, and a platform operator changing an existing one in
 * the console. Before this module, the first route mapped the section and then
 * DROPPED it — `onboardOrganization` never persisted it — so everything an
 * institute chose on the App Experience step silently vanished at approval. One
 * write path means one place that can be wrong, and one place to test.
 *
 * ── What it accepts ─────────────────────────────────────────────────────────
 * Only the keys `Org.appExperience` declares. The onboarding application stores
 * this section as Mixed — whatever a browser sent — and copying it wholesale
 * would let an applicant write arbitrary keys into a tenant record. Two shapes
 * are accepted because two clients send them: the onboarding form keeps copy
 * and colours FLAT, the console sends them NESTED as the organization stores
 * them. Both produce the same stored shape.
 *
 * What it never accepts is the registration STORE. That is `Org.registrationStore`,
 * assigned by the server; there is no key here that reaches it.
 *
 * ── Opening registration provisions its storage ─────────────────────────────
 * Setting the policy to `open` or `approval` means registrations will be written
 * somewhere, so the organization's collection is provisioned in the same step —
 * BEFORE the policy is saved, in the console's case, so a failure leaves the app
 * closed rather than open with nowhere to write.
 */

import Org from '../../models/Org';
import { withoutTenantScope } from '../tenancy/context';
import { provisionRegistrationStore } from '../registration/registrationStore';

const COPY_KEYS = [
  'welcomeTitle',
  'welcomeSubtitle',
  'loginMessage',
  'registerMessage',
  'supportEmail',
  'supportPhone',
] as const;
const PALETTE_KEYS = [
  'splashBackgroundColor',
  'successColor',
  'warningColor',
  'dangerColor',
] as const;
const ROLE_KEYS = ['student', 'teacher', 'parent'] as const;
const POLICIES = ['open', 'approval', 'invite'] as const;

export type RegistrationPolicyValue = (typeof POLICIES)[number];

export interface StoredAppExperience {
  shortName?: string;
  registrationPolicy?: RegistrationPolicyValue;
  roles?: Partial<Record<(typeof ROLE_KEYS)[number], boolean>>;
  palette?: Partial<Record<(typeof PALETTE_KEYS)[number], string>>;
  authCopy?: Partial<Record<(typeof COPY_KEYS)[number], string>>;
}

const trimmed = (v: unknown, max = 200): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

/**
 * Whatever arrived, reduced to what `Org.appExperience` declares.
 *
 * Returns null when nothing usable is present, so a caller can tell "the
 * applicant set nothing" from "the applicant set something".
 */
export function normalizeAppExperience(
  value: unknown,
): StoredAppExperience | null {
  if (!value || typeof value !== 'object') return null;
  const src = value as Record<string, unknown>;
  const nested = (key: string) =>
    src[key] && typeof src[key] === 'object'
      ? (src[key] as Record<string, unknown>)
      : {};
  const out: StoredAppExperience = {};

  const shortName = trimmed(src.shortName, 40);
  if (shortName) out.shortName = shortName;

  if (
    (POLICIES as readonly string[]).includes(String(src.registrationPolicy))
  ) {
    out.registrationPolicy = src.registrationPolicy as RegistrationPolicyValue;
  }

  const roles: StoredAppExperience['roles'] = {};
  for (const k of ROLE_KEYS) {
    const v = nested('roles')[k];
    if (typeof v === 'boolean') roles[k] = v;
  }
  if (Object.keys(roles).length) out.roles = roles;

  const palette: StoredAppExperience['palette'] = {};
  for (const k of PALETTE_KEYS) {
    const v = trimmed(nested('palette')[k] ?? src[k], 9);
    if (v) palette[k] = v;
  }
  if (Object.keys(palette).length) out.palette = palette;

  const authCopy: StoredAppExperience['authCopy'] = {};
  for (const k of COPY_KEYS) {
    const v = trimmed(nested('authCopy')[k] ?? src[k], 200);
    if (v) authCopy[k] = v;
  }
  if (Object.keys(authCopy).length) out.authCopy = authCopy;

  return Object.keys(out).length ? out : null;
}

/** Nested merge of two stored shapes; `patch` wins, key by key. */
export function mergeAppExperience(
  current: StoredAppExperience | null | undefined,
  patch: StoredAppExperience,
): StoredAppExperience {
  const base = current ?? {};
  return {
    ...base,
    ...patch,
    roles: { ...(base.roles ?? {}), ...(patch.roles ?? {}) },
    palette: { ...(base.palette ?? {}), ...(patch.palette ?? {}) },
    authCopy: { ...(base.authCopy ?? {}), ...(patch.authCopy ?? {}) },
  };
}

export class RegistrationStorageFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationStorageFailed';
  }
}

/**
 * Change an organization's app experience.
 *
 * When the result opens registration, the organization's registration
 * collection is provisioned FIRST; if that fails, nothing is saved and the
 * caller gets the reason. Closing registration never deletes the collection —
 * its records are the history of who registered, and an institute that reopens
 * registration next term continues the same ledger.
 */
export async function setAppExperience(
  orgId: string,
  patch: unknown,
): Promise<{
  appExperience: StoredAppExperience;
  registrationCollection: string | null;
}> {
  const normalized = normalizeAppExperience(patch) ?? {};
  const org = await withoutTenantScope('app-experience:load', async () =>
    Org.findById(orgId).select('appExperience registrationStore').lean(),
  );
  if (!org)
    throw new RegistrationStorageFailed('That organization does not exist.');

  const merged = mergeAppExperience(
    org.appExperience as StoredAppExperience,
    normalized,
  );
  const opening =
    merged.registrationPolicy === 'open' ||
    merged.registrationPolicy === 'approval';

  let registrationCollection: string | null =
    org.registrationStore?.collection ?? null;
  if (opening) {
    try {
      registrationCollection = (await provisionRegistrationStore(orgId))
        .collection;
    } catch (err) {
      throw new RegistrationStorageFailed((err as Error).message);
    }
  }

  await withoutTenantScope('app-experience:save', async () =>
    Org.updateOne({ _id: orgId }, { $set: { appExperience: merged } }),
  );

  return { appExperience: merged, registrationCollection };
}
