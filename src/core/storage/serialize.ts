/**
 * Turning stored file references into URLs a client can actually fetch.
 *
 * ── Why a serializer rather than storing the URL ────────────────────────────
 * A private object has no permanent URL. The only URL that reads it is a signed
 * one, and a signed URL expires — so it cannot be stored in the document and
 * read back weeks later. What the document stores is the PATH; the URL is
 * minted on the way out, per request, for the caller who has just been
 * authorized.
 *
 * ── The compatibility rule ──────────────────────────────────────────────────
 * Every row written before this change stores a full public URL, and those
 * objects still carry a public ACL in the bucket. `resolveFileUrl` returns them
 * unchanged. That is not a shortcut — it is the truth about those objects, and
 * rewriting them into signed URLs would imply a privacy they do not have.
 *
 * The result: existing Abhigyan files keep working exactly as they do today,
 * and every NEW file is private from the moment it is written.
 */

import { currentOrgId } from '../tenancy';
import { resolveFileUrl } from './storageService';

export interface AttachmentLike {
  fileUrl?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  [key: string]: unknown;
}

/** One attachment, with `fileUrl` replaced by something fetchable. */
export async function signAttachment<T extends AttachmentLike>(
  attachment: T,
  orgId: string | null = currentOrgId(),
): Promise<T> {
  if (!attachment?.fileUrl) return attachment;
  const plain =
    typeof (attachment as { toObject?: () => T }).toObject === 'function'
      ? (attachment as unknown as { toObject: () => T }).toObject()
      : { ...attachment };
  try {
    const url = await resolveFileUrl(attachment.fileUrl, { orgId });
    return { ...plain, fileUrl: url ?? attachment.fileUrl };
  } catch {
    // A file the caller may not read is returned WITHOUT a usable URL rather
    // than failing the whole response — the rest of the record is still theirs.
    return { ...plain, fileUrl: '' };
  }
}

export async function signAttachments<T extends AttachmentLike>(
  attachments: T[] | undefined | null,
  orgId: string | null = currentOrgId(),
): Promise<T[]> {
  if (!attachments?.length) return [];
  return Promise.all(attachments.map((a) => signAttachment(a, orgId)));
}

/**
 * Sign the attachments on a homework document (or a list of them).
 *
 * Takes a lean object or a Mongoose document and returns a plain object, so it
 * is safe to hand straight to `res.json`.
 */
export async function signHomeworkFiles(
  homework: Record<string, unknown> | null | undefined,
  orgId: string | null = currentOrgId(),
): Promise<Record<string, unknown>> {
  if (!homework) return {} as Record<string, unknown>;
  const plain = (
    typeof (homework as { toObject?: () => unknown }).toObject === 'function'
      ? (homework as unknown as { toObject: () => unknown }).toObject()
      : { ...homework }
  ) as Record<string, unknown>;
  const attachments = plain.attachments as AttachmentLike[] | undefined;
  if (!attachments?.length) return plain;
  return { ...plain, attachments: await signAttachments(attachments, orgId) };
}

export async function signHomeworkList(
  list: unknown[] | undefined | null,
  orgId: string | null = currentOrgId(),
): Promise<Record<string, unknown>[]> {
  if (!list?.length) return [];
  return Promise.all(
    list.map((h) => signHomeworkFiles(h as Record<string, unknown>, orgId)),
  );
}
