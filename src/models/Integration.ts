import mongoose, { Document, Schema } from 'mongoose';
import type { SealedSecret } from '../core/config/secrets';

/**
 * A third-party connector owned by one organization.
 *
 * The reason this exists: `EtimeService.ts:25` hardcodes Abhigyan's eTimeOffice
 * Basic-auth credential into the product. Every tenant would share it, which is
 * both wrong and impossible — each institute has its own eTimeOffice account.
 *
 * ── Credentials are sealed, never plaintext ─────────────────────────────────
 * `credentials` holds AES-256-GCM envelopes (see core/config/secrets.ts), so a
 * database dump does not hand over every customer's vendor accounts. The schema
 * type is Mixed because a sealed value is an opaque envelope, not a string.
 *
 * ── toJSON strips credentials ───────────────────────────────────────────────
 * An Integration document reaches an API response the moment someone writes a
 * list endpoint. Stripping at the model level means that endpoint cannot leak
 * them even if its author never thinks about it — the safe behaviour is the
 * default rather than something to remember.
 */

export type IntegrationType = 'etimeoffice' | 'attendance_webhook' | 'sms' | 'email' | 'other';

export interface IIntegration extends Document {
  orgId: string;
  branchId?: string | null;
  type: IntegrationType;
  name: string;
  isActive: boolean;
  /** Non-secret settings — endpoints, identifiers, toggles. */
  settings: Record<string, unknown>;
  /** Secret values, each an AES-256-GCM envelope. */
  credentials: Record<string, SealedSecret>;
  lastUsedAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const integrationSchema = new Schema<IIntegration>(
  {
    type: {
      type: String,
      enum: ['etimeoffice', 'attendance_webhook', 'sms', 'email', 'other'],
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: false },
    settings: { type: Schema.Types.Mixed, default: () => ({}) },
    credentials: { type: Schema.Types.Mixed, default: () => ({}) },
    lastUsedAt: { type: Date },
    lastError: { type: String },
  },
  { timestamps: true },
);

integrationSchema.index({ orgId: 1, type: 1 }, { unique: true });

// Defence in depth: even a sealed envelope should not travel to a client, and
// `lastError` can quote a provider message containing a credential.
integrationSchema.set('toJSON', {
  transform: (_doc, ret: Record<string, unknown>) => {
    if (ret.credentials) {
      ret.credentials = Object.fromEntries(
        Object.keys(ret.credentials as Record<string, unknown>).map((k) => [k, '<sealed>']),
      );
    }
    return ret;
  },
});

export default mongoose.model<IIntegration>('Integration', integrationSchema);
