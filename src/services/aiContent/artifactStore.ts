/**
 * Persists rendered artifacts (.pptx/.pdf) to Firebase Storage and returns a
 * public URL, reusing the shared `bucket` from config/firebase. Same upload
 * pattern as fileController (createWriteStream + makePublic).
 */
import { bucket } from '../../config/firebase';

export interface StoredArtifact {
  url: string;
  storagePath: string;
}

export async function uploadArtifact(
  buffer: Buffer,
  storagePath: string,
  contentType: string,
  metadata: Record<string, string> = {},
): Promise<StoredArtifact> {
  const blob = bucket.file(storagePath);
  const blobStream = blob.createWriteStream({
    metadata: { contentType, metadata },
    resumable: false,
  });

  await new Promise<void>((resolve, reject) => {
    blobStream.on('error', reject);
    blobStream.on('finish', resolve);
    blobStream.end(buffer);
  });

  await blob.makePublic();
  const url = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
  return { url, storagePath };
}

/** Best-effort delete; never throws (history delete should still succeed). */
export async function deleteArtifact(storagePath?: string): Promise<void> {
  if (!storagePath) return;
  try {
    await bucket.file(storagePath).delete({ ignoreNotFound: true });
  } catch (err) {
    console.warn('[aiContent] Failed to delete artifact:', storagePath, err);
  }
}
