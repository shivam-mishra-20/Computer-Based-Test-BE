/**
 * Push notifications for organization builds — what the build host has, and
 * what one organization's build gets.
 *
 * ── The model (decided 2026-10-16) ──────────────────────────────────────────
 * ONE Firebase project owned by the platform. Every organization's Android
 * package is registered in it as an app; the server keeps sending through the
 * Expo Push Service, as it does for the legacy app. Two things make a build's
 * push work, and they live in different places:
 *
 *   1. google-services.json — compiled INTO the app, so the device can get an
 *      FCM token. The build host holds the project's file (it lists every
 *      registered package); each build receives ONLY its own package's entry,
 *      so a workspace still describes exactly one organization.
 *   2. The project's FCM V1 service-account key — attached to the
 *      organization's EAS project, so Expo can deliver. This is a one-time
 *      `eas credentials` step per organization (the CLI has no
 *      non-interactive form). When it is missing Expo answers
 *      InvalidCredentials, which delivery records on the devices
 *      (services/pushDelivery) and readiness reports here.
 *
 * ── Configuration (build host environment, never the repository) ────────────
 *   PLATFORM_GOOGLE_SERVICES_PATH  path to the platform project's google-services.json
 *   PLATFORM_GOOGLE_SERVICES_JSON  …or its contents (for hosts without a disk path)
 *   PLATFORM_PUSH_REQUIRED=true    refuse to build an organization without push
 *
 * With none of them set, builds proceed WITHOUT push and readiness says so:
 * the app's inbox works either way, and an app that says "notifications are in
 * the app" is not silently broken.
 */

import { readFileSync } from 'fs';

export type PushState =
  | 'not-configured'
  | 'invalid-file'
  | 'package-missing'
  | 'ready';

export interface PushReadiness {
  state: PushState;
  /** Whether a missing or broken configuration should stop the build. */
  required: boolean;
  /** A sentence for an administrator; null when ready. */
  message: string | null;
}

interface GoogleServicesClient {
  client_info?: { android_client_info?: { package_name?: string } };
  [key: string]: unknown;
}

interface GoogleServicesFile {
  project_info?: Record<string, unknown>;
  client?: GoogleServicesClient[];
  configuration_version?: string;
}

export function pushRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    String(env.PLATFORM_PUSH_REQUIRED ?? '')
      .trim()
      .toLowerCase() === 'true'
  );
}

/** The platform project's file as the host has it: parsed, unreadable, or absent. */
export function platformGoogleServices(env: NodeJS.ProcessEnv = process.env): {
  file: GoogleServicesFile | null;
  error: string | null;
} {
  const inline = String(env.PLATFORM_GOOGLE_SERVICES_JSON ?? '').trim();
  const filePath = String(env.PLATFORM_GOOGLE_SERVICES_PATH ?? '').trim();
  if (!inline && !filePath) return { file: null, error: null };
  try {
    const text = inline || readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(text) as GoogleServicesFile;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray(parsed.client) ||
      !parsed.project_info
    ) {
      return {
        file: null,
        error: 'is not a google-services.json (no project_info / client list)',
      };
    }
    return { file: parsed, error: null };
  } catch (error) {
    return {
      file: null,
      error: inline
        ? 'PLATFORM_GOOGLE_SERVICES_JSON is not valid JSON'
        : `could not be read from ${filePath}: ${(error as Error).message}`,
    };
  }
}

/**
 * Pure: the google-services.json ONE organization's build compiles — the
 * project info and that package's client entry only — or null when the package
 * is not registered in the project.
 */
export function googleServicesFor(
  file: GoogleServicesFile,
  androidPackage: string,
): GoogleServicesFile | null {
  const wanted = String(androidPackage ?? '').trim();
  if (!wanted) return null;
  const client = (file.client ?? []).find(
    (c) => c?.client_info?.android_client_info?.package_name === wanted,
  );
  if (!client) return null;
  return {
    project_info: file.project_info,
    client: [client],
    ...(file.configuration_version
      ? { configuration_version: file.configuration_version }
      : {}),
  };
}

/** Pure: where push stands for one package, given what the host has. */
export function pushReadinessFor(
  host: { file: GoogleServicesFile | null; error: string | null },
  androidPackage: string,
  required: boolean,
): PushReadiness {
  if (host.error) {
    return {
      state: 'invalid-file',
      required: true,
      message: `Push notifications: the platform google-services.json ${host.error}. Fix the build host's PLATFORM_GOOGLE_SERVICES_PATH.`,
    };
  }
  if (!host.file) {
    return {
      state: 'not-configured',
      required,
      message: required
        ? 'Push notifications are required on this build host but no platform google-services.json is configured. A developer must set PLATFORM_GOOGLE_SERVICES_PATH.'
        : 'Push notifications are not configured on this build host: this build will have the in-app inbox only.',
    };
  }
  if (!googleServicesFor(host.file, androidPackage)) {
    return {
      state: 'package-missing',
      required: true,
      message:
        `Push notifications: ${androidPackage || 'this app'} is not registered in the platform Firebase project. ` +
        'Add it as an Android app in the Firebase console, download the updated google-services.json, and replace the file at PLATFORM_GOOGLE_SERVICES_PATH.',
    };
  }
  return { state: 'ready', required, message: null };
}

/** The same answer for the live host. */
export function pushReadiness(androidPackage: string): PushReadiness {
  return pushReadinessFor(
    platformGoogleServices(),
    androidPackage,
    pushRequired(),
  );
}
