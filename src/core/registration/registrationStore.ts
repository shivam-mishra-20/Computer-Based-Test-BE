/**
 * Where an application's public registrations are stored, decided by the server.
 *
 * ── The rule this module exists to enforce ──────────────────────────────────
 *
 *     APP A → Organization A → reg_a
 *     APP B → Organization B → reg_b
 *
 * A registration for A must never be written to B's collection, and the CLIENT
 * must have no say in which collection receives anything. So:
 *
 *   · the collection name is ASSIGNED here, from the organization record, and
 *     stored on it (`Org.registrationStore`). No request, form or header can
 *     supply or change it — there is no parameter anywhere that accepts one;
 *   · the name is confined to the `reg_` namespace, so no value, however it got
 *     there, can point at `users`, `orgs` or any other platform collection;
 *   · a unique index on the Org means two organizations cannot hold the same
 *     collection, and `resolveRegistrationStore` re-checks that ownership on
 *     every call rather than trusting that the index was built;
 *   · every record written carries the owning `orgId`, so a record found in the
 *     wrong collection would be detectable, not merely unlikely.
 *
 * ── Never a fallback ────────────────────────────────────────────────────────
 * An organization with no provisioned store is REFUSED, not routed somewhere
 * else. "Registration is not set up for this app" is a correct answer; writing
 * into a shared default because the specific one was missing is exactly the
 * silent cross-tenant write this design prevents.
 *
 * ── The capacity this costs, stated ─────────────────────────────────────────
 * One MongoDB collection per application that enables registration. Shared
 * Atlas tiers cap a cluster at 500 collections, and at the time of writing this
 * cluster holds 489 — most of them in scratch copies of production. Provisioning
 * therefore fails LOUDLY when the cluster cannot create another collection
 * (`RegistrationStoreUnavailable`), and the console says so, rather than
 * degrading to a shared collection that would quietly break the rule above.
 */

import crypto from 'crypto';
import mongoose, { Schema, type Model } from 'mongoose';
import Org from '../../models/Org';
import { withoutTenantScope } from '../tenancy/context';

/** Every registration collection lives inside this namespace, and only these. */
export const REGISTRATION_COLLECTION_PATTERN = /^reg_[a-z0-9_]{2,60}$/;

/** Collections the platform owns that no registration store may ever be. */
const RESERVED = new Set([
  'users',
  'orgs',
  'platformusers',
  'auditlogs',
  'roles',
]);

export type RegistrationRecordStatus = 'pending' | 'approved';

/** One registration, as stored in its application's collection. */
export interface RegistrationRecord {
  _id: mongoose.Types.ObjectId;
  orgId: string;
  /** The application identity the request declared and the server verified. */
  applicationId: string | null;
  role: 'student' | 'teacher' | 'parent';
  name: string;
  email: string;
  phone: string;
  status: RegistrationRecordStatus;
  /** The organization's policy at the moment it authorised this write. */
  policy: 'approval' | 'open';
  /** The account created alongside it, in the platform account store. */
  userId: mongoose.Types.ObjectId;
  source: 'app' | 'website' | 'unknown';
  requestedAt: Date;
  /** A keyed hash, never the address itself. Enough to spot one source
   *  registering hundreds of accounts; not enough to locate anybody. */
  requestFingerprint: string | null;
}

export class RegistrationStoreUnavailable extends Error {
  readonly code = 'REGISTRATION_STORE_UNAVAILABLE';
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'RegistrationStoreUnavailable';
  }
}

export class RegistrationStoreMisconfigured extends Error {
  readonly code = 'REGISTRATION_STORE_MISCONFIGURED';
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationStoreMisconfigured';
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Naming
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The collection an organization's registrations go to, derived once.
 *
 * From the slug because a person reading the database should be able to tell
 * which institute a collection belongs to without a lookup. Derived ONCE, at
 * provisioning, and stored: a later slug change must not move where
 * registrations land, or half an institute's history ends up in a collection
 * nothing points at.
 */
export function registrationCollectionNameFor(slug: string): string {
  const cleaned = String(slug || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 56);
  return `reg_${cleaned || 'org'}`;
}

/** Whether a name is one this module would ever write to. */
export function isValidRegistrationCollection(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    REGISTRATION_COLLECTION_PATTERN.test(name) &&
    !RESERVED.has(name) &&
    !name.startsWith('system.')
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   The record model, one per collection
   ══════════════════════════════════════════════════════════════════════════ */

function recordSchema(): Schema {
  // A fresh schema per model rather than one shared instance: Mongoose compiles
  // plugins onto a schema, and the tenancy plugin marks a schema as done, so a
  // shared instance would be configured once and reused in ways that are hard
  // to reason about.
  return new Schema(
    {
      orgId: { type: String, required: true, index: true },
      applicationId: { type: String, default: null },
      role: { type: String, enum: ['student', 'teacher', 'parent'], required: true },
      name: { type: String, required: true, trim: true, maxlength: 120 },
      email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        maxlength: 254,
      },
      phone: { type: String, required: true, trim: true, maxlength: 32 },
      status: { type: String, enum: ['pending', 'approved'], required: true },
      policy: { type: String, enum: ['approval', 'open'], required: true },
      userId: { type: Schema.Types.ObjectId, required: true },
      source: {
        type: String,
        enum: ['app', 'website', 'unknown'],
        default: 'unknown',
      },
      requestedAt: { type: Date, default: Date.now },
      requestFingerprint: { type: String, default: null },
    },
    { timestamps: true, versionKey: false },
  );
}

const models = new Map<string, Model<RegistrationRecord>>();

/**
 * The model bound to one registration collection.
 *
 * Refuses a name outside the namespace BEFORE compiling anything, so a model
 * for `users` cannot exist in this process under this module's name however the
 * name arrived here.
 */
export function registrationModel(
  collection: string,
): Model<RegistrationRecord> {
  if (!isValidRegistrationCollection(collection)) {
    throw new RegistrationStoreMisconfigured(
      `"${collection}" is not a registration collection.`,
    );
  }
  const cached = models.get(collection);
  if (cached) return cached;
  const modelName = `RegistrationRecord__${collection}`;
  const model =
    (mongoose.models[modelName] as Model<RegistrationRecord> | undefined) ??
    mongoose.model<RegistrationRecord>(modelName, recordSchema(), collection);
  models.set(collection, model);
  return model;
}

/* ══════════════════════════════════════════════════════════════════════════
   Provisioning
   ══════════════════════════════════════════════════════════════════════════ */

/** MongoDB's answer when a shared tier has no room for another collection. */
function isCollectionCapError(err: unknown): boolean {
  const message = String(
    (err as { message?: string })?.message ?? '',
  ).toLowerCase();
  return (
    message.includes('cannot create a new collection') ||
    message.includes('too many collections')
  );
}

/**
 * Give an organization its registration collection, once.
 *
 * Idempotent: an organization that already has a valid store keeps it, and the
 * collection and its indexes are (re)ensured — cheap when they exist. The name
 * is claimed on the organization with a conditional update, so two concurrent
 * calls cannot assign two different names, and the unique index stops two
 * organizations claiming one.
 */
export async function provisionRegistrationStore(
  orgId: string,
): Promise<{ collection: string; created: boolean }> {
  const org = await withoutTenantScope(
    'registration:provision-load',
    async () => Org.findById(orgId).select('slug registrationStore').lean(),
  );
  if (!org)
    throw new RegistrationStoreMisconfigured(
      'That organization does not exist.',
    );

  let collection: string = org.registrationStore?.collection;
  let created = false;

  if (!isValidRegistrationCollection(collection)) {
    collection = registrationCollectionNameFor(org.slug);
    // Claim it only if nothing is claimed yet. A concurrent provisioner that
    // got there first wins, and this call adopts whatever it wrote.
    await withoutTenantScope('registration:provision-claim', async () =>
      Org.updateOne(
        { _id: orgId, 'registrationStore.collection': { $exists: false } },
        {
          $set: {
            registrationStore: {
              collection,
              accountStore: 'platform-users',
              provisionedAt: new Date(),
            },
          },
        },
      ),
    ).catch((err: { code?: number }) => {
      if (err?.code === 11000) {
        throw new RegistrationStoreMisconfigured(
          `The registration collection "${collection}" already belongs to another organization.`,
        );
      }
      throw err;
    });
    const reloaded = await withoutTenantScope(
      'registration:provision-reload',
      async () => Org.findById(orgId).select('registrationStore').lean(),
    );
    collection = reloaded?.registrationStore?.collection;
    if (!isValidRegistrationCollection(collection)) {
      throw new RegistrationStoreMisconfigured(
        'The registration collection could not be assigned.',
      );
    }
    created = true;
  }

  // Create the collection and its indexes OUTSIDE any transaction — index
  // builds cannot run inside one, and a registration must not be the first
  // write to a collection it is also creating.
  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error('No database connection.');
    const existing = await db
      .listCollections({ name: collection }, { nameOnly: true })
      .toArray();
    if (existing.length === 0) await db.createCollection(collection);
    const model = registrationModel(collection);
    // One registration per email per APPLICATION — the collection is the
    // application's, so this is exactly tenant-local uniqueness.
    await model.collection.createIndex(
      { email: 1 },
      { unique: true, name: 'email_unique' },
    );
    await model.collection.createIndex(
      { orgId: 1, requestedAt: -1 },
      { name: 'org_recent' },
    );
  } catch (err) {
    if (isCollectionCapError(err)) {
      throw new RegistrationStoreUnavailable(
        'The database cannot create another collection, so registration storage for this app could not be set up. ' +
          'Free collections on the cluster or move to a tier without the collection limit.',
        (err as Error).message,
      );
    }
    throw err;
  }

  return { collection, created };
}

/* ══════════════════════════════════════════════════════════════════════════
   Resolution — every registration goes through here
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The collection this organization's registrations must be written to.
 *
 * Checks, every time, that:
 *   · a store is assigned and its name is inside the namespace;
 *   · exactly ONE organization holds it, and it is this one.
 *
 * The second check is what the unique index already guarantees — repeated here
 * because this is the last line before a write, and an index that failed to
 * build (it happens: an existing duplicate blocks it) must not be the only
 * thing standing between two tenants.
 */
export async function resolveRegistrationStore(orgId: string): Promise<string> {
  const org = await withoutTenantScope('registration:resolve', async () =>
    Org.findById(orgId).select('registrationStore').lean(),
  );
  const collection = org?.registrationStore?.collection;
  if (!isValidRegistrationCollection(collection)) {
    throw new RegistrationStoreMisconfigured(
      'Registration storage is not set up for this app.',
    );
  }
  const owners = await withoutTenantScope(
    'registration:resolve-owners',
    async () =>
      Org.find({ 'registrationStore.collection': collection })
        .select('_id')
        .limit(2)
        .lean(),
  );
  if (owners.length !== 1 || String(owners[0]._id) !== String(orgId)) {
    throw new RegistrationStoreMisconfigured(
      'Registration storage for this app is ambiguous and has been refused.',
    );
  }
  return collection;
}

/**
 * A keyed fingerprint of where a request came from.
 *
 * HMAC rather than a plain hash: an unkeyed hash of an IPv4 address is
 * reversible by enumerating four billion inputs, which makes it a slow way of
 * storing the address. Keyed with the session secret, it groups requests from
 * one source without being a lookup table back to it.
 */
export function requestFingerprint(
  ip: string | undefined | null,
): string | null {
  if (!ip) return null;
  const key = process.env.JWT_SECRET || 'registration-fingerprint';
  return crypto
    .createHmac('sha256', key)
    .update(String(ip))
    .digest('hex')
    .slice(0, 32);
}
