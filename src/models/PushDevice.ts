/**
 * One app installation that can receive push notifications, and whose it is.
 *
 * ── Why not User.pushToken ──────────────────────────────────────────────────
 * The legacy institute app keeps ONE Expo token on the user. That stays as it
 * is. Organization apps register here instead, because a token has to be tied
 * to more than a user to be safe:
 *
 *   - the INSTALLATION (an id the app generates once per install), so a phone
 *     that signs out, or switches to another account or organization, can be
 *     detached precisely and only that phone;
 *   - the ORGANIZATION (stamped by the tenancy plugin), so a device is only
 *     ever found by queries running in its own organization;
 *   - the APP (Android package + EAS project), so a delivery failure can be
 *     traced to the organization build whose credentials are missing.
 *
 * A token is unique across the collection: one physical device can be bound to
 * one account at a time. Registering it for another account moves it rather
 * than duplicating it, which is what stops one person's notifications reaching
 * the next person who signs in on the same phone.
 */

import mongoose, { Document, Schema } from 'mongoose';

export interface IPushDevice extends Document {
  userId: mongoose.Types.ObjectId;
  installationId: string;
  /** An Expo push token (ExponentPushToken[…]). */
  token: string;
  platform: 'android' | 'ios';
  /** Android package / iOS bundle id of the build that registered it. */
  appId?: string;
  /** The EAS project the token was issued for. */
  projectId?: string;
  lastRegisteredAt: Date;
  /** The last delivery error Expo reported for this device, if any. */
  lastError?: string | null;
  lastErrorAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const pushDeviceSchema = new Schema<IPushDevice>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    installationId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128,
    },
    token: { type: String, required: true, trim: true, maxlength: 256 },
    platform: { type: String, enum: ['android', 'ios'], required: true },
    appId: { type: String, trim: true, maxlength: 256 },
    projectId: { type: String, trim: true, maxlength: 64 },
    lastRegisteredAt: { type: Date, required: true },
    lastError: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One device, one account, everywhere: a token or an installation never
// appears twice, in any organization.
pushDeviceSchema.index({ token: 1 }, { unique: true });
pushDeviceSchema.index({ installationId: 1 }, { unique: true });

export default mongoose.model<IPushDevice>('PushDevice', pushDeviceSchema);
