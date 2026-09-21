/**
 * The five images a white-label build compiles in, and where they come from.
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 * `org.mobile.assetsReady` is a boolean a human ticks, because until now the
 * artwork lived only in `client-platform-app/assets/<slug>/` and this server
 * could not see it. That is fine for a workflow where a developer runs the
 * build on the machine holding those files. It is useless to a build worker,
 * which has no checkout and must be able to answer "do these exist" with
 * something better than somebody's word.
 *
 * So assets are UPLOADED to the organization and resolved from storage. The
 * repository remains a fallback, which is what keeps the existing manual
 * workflow and the organizations already set up that way working unchanged.
 *
 * ── Why exactly five ────────────────────────────────────────────────────────
 * Because `config/organizations/<slug>.js` references exactly five paths, and
 * `app.config.ts` fails the build if one is missing. Adding a sixth here
 * without adding it there produces an asset nothing reads; the reverse
 * produces a build that dies in `expo prebuild` with a path. The list is the
 * contract between the two repositories, and `safety:mobile-rules` is what
 * stops it drifting.
 */

import path from 'path';
import { promises as fs } from 'fs';
import { downloadUnchecked, putOrgNativeAsset } from '../storage/storageService';
import { withoutTenantScope } from '../tenancy/context';

/** The asset kinds, in the order the console shows them. */
export const NATIVE_ASSET_KINDS = [
  'icon',
  'adaptiveIcon',
  'splash',
  'logo',
  'onboarding',
] as const;
export type NativeAssetKind = (typeof NATIVE_ASSET_KINDS)[number];

/** Kind → the filename `config/organizations/<slug>.js` points at. */
export const NATIVE_ASSET_FILENAMES: Record<NativeAssetKind, string> = {
  icon: 'icon.png',
  adaptiveIcon: 'adaptive-icon.png',
  splash: 'splash.png',
  logo: 'logo.png',
  onboarding: 'onboarding.png',
};

/** What the console calls each one, and what a refusal names. */
export const NATIVE_ASSET_LABELS: Record<NativeAssetKind, string> = {
  icon: 'App icon',
  adaptiveIcon: 'Android adaptive icon',
  splash: 'Splash screen',
  logo: 'Logo',
  onboarding: 'Onboarding image',
};

export const MAX_NATIVE_ASSET_BYTES = 8 * 1024 * 1024;

export class NativeAssetRejected extends Error {
  readonly code = 'NATIVE_ASSET_REJECTED';
  constructor(message: string) {
    super(message);
    this.name = 'NativeAssetRejected';
  }
}

/** PNG only. Every one of these ends up in a native manifest that expects it. */
export function isPng(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  );
}

export interface StoredNativeAsset {
  kind: NativeAssetKind;
  storagePath: string;
  filename: string;
  bytes: number;
  uploadedAt: Date;
}

function model() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../models/Org').default;
}

async function loadOrg(orgId: string): Promise<Record<string, any> | null> {
  return withoutTenantScope('mobile-assets:load-org', async () => model().findById(orgId));
}

/**
 * Store one asset against an organization.
 *
 * The contents are sniffed rather than trusted: a JPEG renamed `icon.png` is
 * accepted by every upload form on earth and rejected by `expo prebuild`
 * forty minutes into a build.
 */
export async function saveNativeAsset(
  orgId: string,
  kind: NativeAssetKind,
  file: { buffer: Buffer; originalname: string },
): Promise<StoredNativeAsset> {
  if (!NATIVE_ASSET_KINDS.includes(kind)) {
    throw new NativeAssetRejected(`"${kind}" is not one of this app's five images.`);
  }
  if (!file?.buffer?.length) throw new NativeAssetRejected('The file was empty.');
  if (file.buffer.length > MAX_NATIVE_ASSET_BYTES) {
    throw new NativeAssetRejected(`Images must be under ${MAX_NATIVE_ASSET_BYTES / 1024 / 1024} MB.`);
  }
  if (!isPng(file.buffer)) {
    throw new NativeAssetRejected(
      'That is not a PNG. Native app icons and splash images must be PNG — the file contents are checked, not the name.',
    );
  }

  const org = await loadOrg(orgId);
  if (!org) throw new NativeAssetRejected('Organization not found.');

  const stored = await putOrgNativeAsset({
    buffer: file.buffer,
    orgId: String(org._id),
    fileName: NATIVE_ASSET_FILENAMES[kind],
    contentType: 'image/png',
    kind,
  });

  const entry: StoredNativeAsset = {
    kind,
    storagePath: stored.storagePath,
    filename: NATIVE_ASSET_FILENAMES[kind],
    bytes: stored.size,
    uploadedAt: new Date(),
  };

  const mobile = (org.mobile ?? {}) as Record<string, unknown>;
  const assets = ((mobile.nativeAssets ?? []) as StoredNativeAsset[]).filter((a) => a.kind !== kind);
  assets.push(entry);
  org.mobile = { ...mobile, nativeAssets: assets };
  org.markModified('mobile');
  await withoutTenantScope('mobile-assets:save', async () => org.save());

  await syncAssetsReady(orgId);
  return entry;
}

export interface NativeAssetState {
  kind: NativeAssetKind;
  label: string;
  filename: string;
  /** 'stored' — uploaded here. 'repository' — found in the app checkout. */
  source: 'stored' | 'repository' | null;
  present: boolean;
  bytes?: number;
  uploadedAt?: Date;
}

/** Where the app project lives on this host, if it is reachable at all. */
export function appProjectPath(): string | null {
  const configured = String(process.env.CLIENT_APP_PATH || '').trim();
  return configured || null;
}

async function repositoryAssetPath(slug: string, kind: NativeAssetKind): Promise<string | null> {
  const root = appProjectPath();
  if (!root || !slug) return null;
  const candidate = path.join(root, 'assets', slug, NATIVE_ASSET_FILENAMES[kind]);
  try {
    const stat = await fs.stat(candidate);
    return stat.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * What this organization has, and where each one came from.
 *
 * Stored wins over repository: an upload is the newer statement of intent, and
 * silently preferring a file in somebody's checkout would make the build
 * depend on which machine ran it — the exact class of bug this whole system
 * exists to remove.
 */
export async function nativeAssetState(orgId: string): Promise<NativeAssetState[]> {
  const org = await loadOrg(orgId);
  const mobile = (org?.mobile ?? {}) as Record<string, unknown>;
  const stored = (mobile.nativeAssets ?? []) as StoredNativeAsset[];
  const slug = String(org?.slug ?? '');

  return Promise.all(
    NATIVE_ASSET_KINDS.map(async (kind) => {
      const hit = stored.find((a) => a.kind === kind);
      if (hit) {
        return {
          kind,
          label: NATIVE_ASSET_LABELS[kind],
          filename: NATIVE_ASSET_FILENAMES[kind],
          source: 'stored' as const,
          present: true,
          bytes: hit.bytes,
          uploadedAt: hit.uploadedAt,
        };
      }
      const onDisk = await repositoryAssetPath(slug, kind);
      return {
        kind,
        label: NATIVE_ASSET_LABELS[kind],
        filename: NATIVE_ASSET_FILENAMES[kind],
        source: onDisk ? ('repository' as const) : null,
        present: Boolean(onDisk),
      };
    }),
  );
}

/**
 * Make `mobile.assetsReady` say what is actually true.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * That flag was a checkbox a human ticked, and it had to be: the artwork lived
 * in a repository this server could not see, so its own word was the only
 * evidence available. `validateMobileIdentity` still reads it, and so does the
 * Mobile app screen.
 *
 * Now the files are reachable, the honest value is computable, so it is
 * computed — on every upload and every readiness check. Leaving a human to
 * keep a checkbox in step with a storage bucket is how a console comes to
 * report READY for a build that has no icon.
 */
export async function syncAssetsReady(orgId: string): Promise<boolean> {
  const state = await nativeAssetState(orgId);
  const allPresent = state.length === NATIVE_ASSET_KINDS.length && state.every((a) => a.present);

  const org = await loadOrg(orgId);
  if (!org) return allPresent;

  const mobile = (org.mobile ?? {}) as Record<string, unknown>;
  if (mobile.assetsReady === allPresent) return allPresent;

  org.mobile = { ...mobile, assetsReady: allPresent };
  org.markModified('mobile');
  await withoutTenantScope('mobile-assets:sync-ready', async () => org.save());
  return allPresent;
}

/**
 * Put this organization's five images into a build workspace.
 *
 * Returns what it wrote, so the caller can record it. Refuses on the first
 * missing one rather than producing a workspace that fails later in `expo
 * prebuild`, where the message names a path instead of a person's next action.
 */
export async function materializeNativeAssets(
  orgId: string,
  slug: string,
  workspaceRoot: string,
): Promise<{ kind: NativeAssetKind; source: 'stored' | 'repository'; bytes: number }[]> {
  const org = await loadOrg(orgId);
  const mobile = (org?.mobile ?? {}) as Record<string, unknown>;
  const stored = (mobile.nativeAssets ?? []) as StoredNativeAsset[];

  const targetDir = path.join(workspaceRoot, 'assets', slug);
  await fs.mkdir(targetDir, { recursive: true });

  const written: { kind: NativeAssetKind; source: 'stored' | 'repository'; bytes: number }[] = [];

  for (const kind of NATIVE_ASSET_KINDS) {
    const target = path.join(targetDir, NATIVE_ASSET_FILENAMES[kind]);
    const hit = stored.find((a) => a.kind === kind);

    if (hit) {
      const bytes = await downloadUnchecked(hit.storagePath);
      await fs.writeFile(target, bytes);
      written.push({ kind, source: 'stored', bytes: bytes.length });
      continue;
    }

    const onDisk = await repositoryAssetPath(slug, kind);
    if (onDisk) {
      await fs.copyFile(onDisk, target);
      const stat = await fs.stat(target);
      written.push({ kind, source: 'repository', bytes: stat.size });
      continue;
    }

    throw new NativeAssetRejected(
      `Missing ${NATIVE_ASSET_LABELS[kind].toLowerCase()}: ${NATIVE_ASSET_FILENAMES[kind]}. ` +
        'Upload it under Mobile app → Native assets and start the build again.',
    );
  }

  return written;
}
