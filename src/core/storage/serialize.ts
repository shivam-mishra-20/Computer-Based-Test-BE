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

/**
 * Doubt-chat attachments, made fetchable.
 *
 * ── The bug this fixes ──────────────────────────────────────────────────────
 * A doubt attachment stores its reference in `url` (not `fileUrl`, which is
 * what `signAttachment` above keys on), and every doubts read path returned
 * that value untouched. Since `putTenantFile` began storing a PATH, the client
 * received `legacy/doubts/…` or `organizations/…` and put it straight into an
 * <Image> — which of course rendered nothing. The upload had worked perfectly;
 * only the read was broken, which is why it looked like an upload bug.
 *
 * The socket path was worse than untouched. It rewrote the path into
 * `https://storage.googleapis.com/<bucket>/<path>` — a URL that was correct
 * when every object carried a public ACL, and which now 403s, because
 * `putTenantFile` writes PRIVATE objects. A fabricated public URL for a private
 * object is not a fallback; it is a link that cannot ever work.
 *
 * `resolveFileUrl` already knows the right answer for each kind of stored
 * value — a legacy absolute URL passes through, a private path is signed, a
 * pre-tenant bare path keeps its public URL — so this is only a matter of
 * calling it, on the field doubts actually use.
 *
 * Mutates in place: these are `.lean()` documents already being walked by the
 * callers, and rebuilding a populated doubt just to replace one string per
 * attachment would be a lot of copying for no gain.
 */
export async function signDoubtMessageAttachments(
  messages: unknown,
  orgId: string | null = currentOrgId(),
): Promise<void> {
  if (!Array.isArray(messages)) return;

  const pending: Array<Promise<void>> = [];
  for (const message of messages) {
    const attachments = (message as { attachments?: unknown })?.attachments;
    if (!Array.isArray(attachments)) continue;

    for (const attachment of attachments) {
      const a = attachment as { url?: unknown; storagePath?: unknown };
      // `storagePath` is authoritative when present; `url` is what older rows
      // carry, and on those it is already a real (public) URL.
      const stored =
        typeof a?.storagePath === 'string' && a.storagePath
          ? a.storagePath
          : typeof a?.url === 'string'
            ? a.url
            : '';
      if (!stored) continue;

      pending.push(
        resolveFileUrl(stored, { orgId })
          .then((url) => {
            a.url = url ?? '';
          })
          .catch(() => {
            // A file this caller may not read loses its URL rather than
            // failing the whole conversation — every other message still
            // renders, and a missing image is visibly missing.
            a.url = '';
          }),
      );
    }
  }

  await Promise.all(pending);
}

/** The same, for one doubt document (or null). Returns it for convenience. */
export async function signDoubtAttachments<T>(
  doubt: T,
  orgId: string | null = currentOrgId(),
): Promise<T> {
  if (doubt && typeof doubt === 'object') {
    await signDoubtMessageAttachments(
      (doubt as { messages?: unknown }).messages,
      orgId,
    );
  }
  return doubt;
}

/** And for a list of doubts, which is what every inbox query returns. */
export async function signDoubtListAttachments<T>(
  doubts: T[] | undefined | null,
  orgId: string | null = currentOrgId(),
): Promise<T[]> {
  if (!doubts?.length) return doubts ?? [];
  await Promise.all(doubts.map((d) => signDoubtAttachments(d, orgId)));
  return doubts;
}
