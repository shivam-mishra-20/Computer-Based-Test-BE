/**
 * What the schedule extractor actually hands to the vision model.
 *
 * ── Why this moved out of the route ─────────────────────────────────────────
 * "Only one class was extracted" was diagnosed three times from the model's
 * response alone, and each time the answer was a prompt change. It was never
 * possible to answer the prior question — did the model receive the whole
 * image, at a size it could read? — because the preprocessing lived inside a
 * 2,600-line route module that cannot be imported without a Redis connection
 * and a Mongo handle.
 *
 * It is a pure function of a Buffer. It belongs where it can be run, measured
 * and asserted on its own, which is what `schedule-extraction.test.ts` does.
 *
 * ── What it does NOT do, deliberately ───────────────────────────────────────
 * No cropping, no region detection, no splitting into tiles, no thresholding.
 * The FULL frame is sent, once. A timetable photograph can hold several
 * stacked grids (the reported failure had two), and any crop or tile boundary
 * is a chance to cut one in half or drop it entirely. Sizing is the only
 * transformation, and `describeImage` records both ends of it so a future
 * report can be answered with measurements instead of a guess.
 */

import sharp from 'sharp';

export interface ImageFacts {
  format: string;
  width: number;
  height: number;
  bytes: number;
  /** Orientation as recorded by the camera; 1 (or absent) means upright. */
  exifOrientation: number | null;
}

export interface PreparedVisionImage {
  buffer: Buffer;
  mimeType: string;
  /** Measurements of the bytes as uploaded. */
  source: ImageFacts;
  /** Measurements of the bytes actually sent to the model. */
  sent: ImageFacts;
  /** Set when sharp could not read the image and the original bytes are passed through. */
  normalizeError: string | null;
}

/** Measure a buffer without altering it. Never throws — unreadable is a fact too. */
export async function describeImage(buffer: Buffer): Promise<ImageFacts> {
  try {
    const meta = await sharp(buffer).metadata();
    return {
      format: meta.format || 'unknown',
      width: meta.width || 0,
      height: meta.height || 0,
      bytes: buffer.length,
      exifOrientation:
        typeof meta.orientation === 'number' ? meta.orientation : null,
    };
  } catch {
    return {
      format: 'unreadable',
      width: 0,
      height: 0,
      bytes: buffer.length,
      exifOrientation: null,
    };
  }
}

/**
 * Minimum width we will hand a dense timetable.
 *
 * A 900px-wide grid downsamples to unreadable glyphs inside the model's own
 * patching, and `withoutEnlargement` meant we never gave it more pixels to
 * work with.
 */
export const MIN_WIDTH = 1400;
/** Ceiling for large photographs. Unchanged from the original implementation. */
export const MAX_WIDTH = 2500;

/**
 * Normalize an uploaded schedule photo for the vision model.
 *
 * `.rotate()` FIRST, and it is not optional: sharp does not auto-apply EXIF
 * orientation and `resize()` ignores it entirely, so a phone photo saved with
 * Orientation 6 or 8 — every iPhone and most Androids held in portrait —
 * reached the model rotated 90 degrees, where a timetable grid is unreadable.
 * Called with no argument, `rotate()` means "apply the EXIF orientation and
 * strip it".
 */
export async function prepareScheduleImageForVision(
  buffer: Buffer,
): Promise<PreparedVisionImage> {
  const source = await describeImage(buffer);

  try {
    const width = source.width;
    const targetWidth =
      width > 0 && width < MIN_WIDTH
        ? Math.min(MIN_WIDTH, width * 2)
        : MAX_WIDTH;
    const pipeline = () =>
      sharp(buffer)
        .rotate()
        .resize({ width: targetWidth, withoutEnlargement: false });

    let out: Buffer;
    let mimeType: string;
    if (
      source.format === 'jpeg' ||
      source.format === 'png' ||
      source.format === 'webp'
    ) {
      out = await pipeline().toBuffer();
      mimeType =
        source.format === 'jpeg' ? 'image/jpeg' : `image/${source.format}`;
    } else {
      // heic/bmp/gif/tiff/unknown → re-encode to PNG (mirrors aiService.ts's
      // OCR normalize step).
      out = await pipeline().png().toBuffer();
      mimeType = 'image/png';
    }

    return {
      buffer: out,
      mimeType,
      source,
      sent: await describeImage(out),
      normalizeError: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      '[schedule/extract-image] image normalize failed, sending original bytes:',
      message,
    );
    return {
      buffer,
      mimeType: 'image/png',
      source,
      sent: source,
      normalizeError: message,
    };
  }
}

/**
 * One log line proving what the model was given.
 *
 * Dimensions, bytes and format only — never the pixels, never base64, never
 * anything that could put a photograph of a real timetable into a log
 * aggregator. `fullFrame` is the claim being evidenced: the sent image has the
 * same aspect ratio as the source, so nothing was cropped away.
 */
export function visionImageDiagnostics(prepared: PreparedVisionImage) {
  const ratio = (f: ImageFacts) => (f.height > 0 ? f.width / f.height : 0);
  const sourceRatio = ratio(prepared.source);
  const sentRatio = ratio(prepared.sent);
  return {
    sourceFormat: prepared.source.format,
    sourceSize: `${prepared.source.width}x${prepared.source.height}`,
    sourceBytes: prepared.source.bytes,
    exifOrientation: prepared.source.exifOrientation,
    sentMimeType: prepared.mimeType,
    sentSize: `${prepared.sent.width}x${prepared.sent.height}`,
    sentBytes: prepared.sent.bytes,
    scale:
      prepared.source.width > 0
        ? +(prepared.sent.width / prepared.source.width).toFixed(3)
        : null,
    // Aspect preserved to within a rounding pixel means no crop and no tiling.
    fullFrame: sourceRatio > 0 && Math.abs(sentRatio - sourceRatio) < 0.01,
    normalizeError: prepared.normalizeError,
  };
}
