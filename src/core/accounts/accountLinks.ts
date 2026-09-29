/**
 * One-time account links: invitations and password resets.
 *
 * ── Why links and not passwords ─────────────────────────────────────────────
 * Onboarding used to ask platform staff to TYPE the first administrator's
 * password and then hand it over by phone or chat; creating staff worked the
 * same way. A password that more than one person has seen is not a secret.
 * So an account is now created WITHOUT a usable password, and its holder sets
 * one through a link that:
 *
 *   · carries 32 random bytes (base64url) — unguessable, unlike a 6-digit code;
 *   · is stored only as its SHA-256, so a database read does not yield it;
 *   · expires (invites 7 days, resets 24 hours) and works once;
 *   · on use, bumps the user's tokenVersion, signing out every other session.
 *
 * ── Delivery ────────────────────────────────────────────────────────────────
 * The platform has no email or SMS provider. The link is therefore returned
 * ONCE to the administrator who created it, for them to pass on through
 * whatever channel their institute already uses. Automatic delivery needs an
 * email provider integrated here (`deliver()`), and the response says so
 * rather than pretending it was sent.
 */

import crypto from 'crypto';
import User from '../../models/User';
import { withoutTenantScope } from '../tenancy/context';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;

export type LinkKind = 'invite' | 'reset';

export interface IssuedLink {
  kind: LinkKind;
  /** The raw token. Shown once; never stored. */
  token: string;
  /** Absolute when TENANT_WEB_URL is configured, otherwise a path. */
  link: string;
  expiresAt: Date;
  delivery: 'manual';
}

function hash(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Where the holder sets their password. */
export function linkFor(kind: LinkKind, token: string): string {
  const base = (process.env.TENANT_WEB_URL || '').trim().replace(/\/+$/, '');
  const path = kind === 'invite' ? '/accept-invite' : '/reset-password';
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}

/** A password nobody knows, for an account whose holder has not chosen one yet. */
export function unusablePassword(): string {
  return `invite:${crypto.randomBytes(24).toString('base64url')}`;
}

export class LinkRefused extends Error {
  constructor(readonly httpStatus: number, message: string, readonly code: string) {
    super(message);
    this.name = 'LinkRefused';
  }
}

export function checkPassword(password: unknown): string {
  const value = typeof password === 'string' ? password : '';
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new LinkRefused(400, `Use at least ${MIN_PASSWORD_LENGTH} characters.`, 'WEAK_PASSWORD');
  }
  return value;
}

/** Attach a fresh invitation to an account (replacing any earlier one). */
export async function issueInvite(userId: unknown, invitedBy: string): Promise<IssuedLink> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await User.updateOne(
    { _id: userId },
    { $set: { inviteTokenHash: hash(token), inviteExpiresAt: expiresAt, invitedBy, invitedAt: new Date() } },
  );
  return { kind: 'invite', token, link: linkFor('invite', token), expiresAt, delivery: 'manual' };
}

/** Attach a password-reset link to an account. */
export async function issueResetLink(userId: unknown): Promise<IssuedLink> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await User.updateOne({ _id: userId }, { $set: { passwordResetToken: hash(token), passwordResetExpires: expiresAt } });
  return { kind: 'reset', token, link: linkFor('reset', token), expiresAt, delivery: 'manual' };
}

/**
 * Redeem a link: set the password, retire the link, sign out every session.
 *
 * Looked up by the token's hash alone, before any session exists, so it runs
 * unscoped — the 32-byte token is the authorization, and it names exactly one
 * account.
 */
export async function redeem(kind: LinkKind, token: unknown, password: unknown): Promise<{ email: string; orgId?: string }> {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (raw.length < 32) throw new LinkRefused(400, 'This link is not valid.', 'LINK_INVALID');
  const chosen = checkPassword(password);
  const digest = hash(raw);
  const now = new Date();

  return withoutTenantScope(`accounts:redeem-${kind}`, async () => {
    const filter =
      kind === 'invite'
        ? { inviteTokenHash: digest, inviteExpiresAt: { $gt: now } }
        : { passwordResetToken: digest, passwordResetExpires: { $gt: now } };
    const user = await User.findOne(filter);
    if (!user) throw new LinkRefused(400, 'This link has expired or was already used.', 'LINK_EXPIRED');
    if (user.status === 'rejected') throw new LinkRefused(400, 'This account is not active.', 'ACCOUNT_DISABLED');

    user.password = chosen; // hashed by the pre-save hook
    user.tokenVersion = (Number(user.tokenVersion) || 0) + 1;
    if (kind === 'invite') {
      user.inviteTokenHash = undefined;
      user.inviteExpiresAt = undefined;
    }
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();
    return { email: user.email, orgId: (user as { orgId?: string }).orgId };
  });
}

/**
 * Sign every session of a user out, everywhere. Used by "sign out everywhere"
 * and by administrators revoking a lost device.
 */
export async function revokeSessions(userId: unknown): Promise<void> {
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
}
