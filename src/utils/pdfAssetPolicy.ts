/**
 * What a server-side PDF render may load.
 *
 * Every HTML→PDF export runs a headless Chromium inside our network. The HTML
 * carries URLs that users control — a question's diagram URL (a teacher can
 * post any structured paper to /papers/temp/export), an organization's logo
 * URL — so without a policy, rendering a paper made the server fetch any
 * address: localhost services, private hosts, the cloud metadata endpoint.
 *
 * The policy is an allowlist of URL PREFIXES, checked for every request the
 * page makes — including each hop of a redirect, which Chromium reports as a
 * new intercepted request:
 *   - this app's own storage bucket (both URL forms Google serves it under),
 *   - the one pinned KaTeX stylesheet/font path the slide renderer links,
 *   - anything listed in PDF_ASSET_ALLOWED_PREFIXES (https only),
 *   - inline `data:` / `about:blank`, which never reach the network.
 * Anything else is aborted. On top of the allowlist, a host that is an IP
 * literal, a local/internal name, or that RESOLVES to a private, loopback,
 * link-local or metadata address is refused even if listed — so a
 * misconfigured prefix or a DNS answer cannot point the renderer inward.
 *
 * Pages also render with JavaScript off: no export needs it (math is rendered
 * on the server), and script is what turns an injected attribute into a fetch.
 */
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const KATEX_CDN_PREFIX = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/';

/** The storage bucket's names: the configured one and its sibling form for the same project. */
function bucketNames(): string[] {
  const configured = (process.env.FIREBASE_STORAGE_BUCKET || '').trim();
  if (!configured) return [];
  const project = configured.replace(/\.(firebasestorage\.app|appspot\.com)$/i, '');
  const names = new Set([configured]);
  if (project !== configured) {
    names.add(`${project}.firebasestorage.app`);
    names.add(`${project}.appspot.com`);
  }
  return [...names];
}

/** The allowed URL prefixes (https). Read per call so tests and config changes apply. */
export function allowedAssetPrefixes(): string[] {
  const prefixes: string[] = [KATEX_CDN_PREFIX];
  for (const bucket of bucketNames()) {
    prefixes.push(`https://storage.googleapis.com/${bucket}/`);
    prefixes.push(`https://firebasestorage.googleapis.com/v0/b/${bucket}/`);
  }
  for (const extra of (process.env.PDF_ASSET_ALLOWED_PREFIXES || '').split(',')) {
    const prefix = extra.trim();
    // A prefix must name a full https origin and end in "/" — "https://cdn.x"
    // would otherwise also match "https://cdn.x.attacker.example".
    if (/^https:\/\/[^/\s]+\/\S*$/i.test(prefix) && prefix.endsWith('/')) prefixes.push(prefix);
  }
  return prefixes;
}

const LOCAL_NAMES = /^(localhost|localhost\.localdomain|ip6-localhost|ip6-loopback)$|\.(localhost|local|internal|intranet|lan|home|corp)$/i;
const METADATA_NAMES = new Set(['metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal']);

/** True for loopback, private, link-local (incl. 169.254.169.254), CGNAT, multicast, unspecified, ULA … */
export function isNonPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '');
  const kind = net.isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) || // 192.0.0.0/24, 192.0.2.0/24
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast + reserved + broadcast
    );
  }
  if (kind === 6) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isNonPublicAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v); // ULA, link-local, multicast
  }
  return false;
}

export type AssetVerdict = { allowed: true } | { allowed: false; reason: string };

/** The URL-only part of the policy (no DNS): scheme, host shape, allowlist. */
export function checkAssetUrl(raw: string, prefixes: string[] = allowedAssetPrefixes()): AssetVerdict {
  if (raw === 'about:blank' || /^data:/i.test(raw)) return { allowed: true };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: 'not a URL' };
  }
  if (url.protocol !== 'https:') return { allowed: false, reason: `scheme ${url.protocol}` };
  if (url.username || url.password) return { allowed: false, reason: 'credentials in URL' };
  const host = url.hostname.toLowerCase();
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) return { allowed: false, reason: 'IP-literal host' };
  if (LOCAL_NAMES.test(host) || METADATA_NAMES.has(host)) return { allowed: false, reason: 'local or metadata host' };
  if (url.port && url.port !== '443') return { allowed: false, reason: `port ${url.port}` };
  // Compare on the normalized form so "%2e%2e" tricks resolve before matching.
  const normalized = `${url.protocol}//${host}${url.pathname}`;
  if (!prefixes.some((p) => normalized.startsWith(p))) return { allowed: false, reason: 'host not allowlisted' };
  return { allowed: true };
}

/** Resolve a host and refuse it if any address it maps to is not public. */
async function resolvesPublic(host: string, cache: Map<string, Promise<boolean>>): Promise<boolean> {
  let pending = cache.get(host);
  if (!pending) {
    pending = dns.promises
      .lookup(host, { all: true, verbatim: true })
      .then((addresses) => addresses.length > 0 && addresses.every((a) => !isNonPublicAddress(a.address)))
      .catch(() => false);
    cache.set(host, pending);
  }
  return pending;
}

export interface AssetPolicy {
  prefixes: string[];
  /** Resolve hosts and refuse non-public answers. Always on in production. */
  requirePublicDns: boolean;
}

export const defaultAssetPolicy = (): AssetPolicy => ({ prefixes: allowedAssetPrefixes(), requirePublicDns: true });

/** For logs: never the query (signed URLs carry credentials there). */
const describe = (raw: string) => {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 160);
  } catch {
    return raw.slice(0, 60);
  }
};

/**
 * Lock a puppeteer page to the policy: JavaScript off, every request —
 * documents, images, styles, fonts, redirect hops — checked before it leaves.
 * Returns the list of blocked URLs (for logging/tests). Call BEFORE setContent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function lockRenderPage(page: any, policy: AssetPolicy = defaultAssetPolicy()): Promise<string[]> {
  const blocked: string[] = [];
  const dnsCache = new Map<string, Promise<boolean>>();
  await page.setJavaScriptEnabled(false);
  await page.setRequestInterception(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page.on('request', async (request: any) => {
    if (request.isInterceptResolutionHandled?.()) return;
    const url: string = request.url();
    let verdict: AssetVerdict = checkAssetUrl(url, policy.prefixes);
    if (verdict.allowed && policy.requirePublicDns && /^https:/i.test(url)) {
      const host = new URL(url).hostname;
      if (!(await resolvesPublic(host, dnsCache))) verdict = { allowed: false, reason: 'resolves to a non-public address' };
    }
    try {
      if (verdict.allowed) {
        await request.continue();
      } else {
        blocked.push(url);
        const reason = 'reason' in verdict ? verdict.reason : 'not allowed';
        console.warn(`[pdf-render] blocked ${describe(url)} (${reason})${request.redirectChain?.().length ? ' — redirect hop' : ''}`);
        await request.abort('blockedbyclient');
      }
    } catch {
      /* the page may already be closing */
    }
  });
  return blocked;
}

const MAX_IMAGE_BYTES = () => Number(process.env.DOCUMENT_IMAGE_MAX_BYTES || 10 * 1024 * 1024);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

/**
 * An image for a document the SERVER builds itself (the Word export), under
 * the same policy as the PDF renderer: an inline data URI, a file inside this
 * server's `uploads/` folder, or an allowlisted https URL — fetched with every
 * redirect hop checked again, a timeout, a size cap and an image content type.
 * Anything else is null. The Word export used to fetch any URL (following
 * redirects) and read any other value as a path on disk, so a diagram "URL"
 * of `/etc/passwd` or the server's `.env` came back inside the .docx.
 */
export async function loadDocumentImage(raw: unknown, policy: AssetPolicy = defaultAssetPolicy()): Promise<Buffer | null> {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const max = MAX_IMAGE_BYTES();

  const inline = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(value);
  if (inline) {
    const buffer = Buffer.from(inline[1], 'base64');
    return buffer.length > 0 && buffer.length <= max ? buffer : null;
  }

  if (value.startsWith('/uploads/')) {
    const uploadsDir = path.resolve(process.cwd(), 'uploads');
    const abs = path.resolve(process.cwd(), value.replace(/^\//, '').split(/[?#]/)[0]);
    if (!abs.startsWith(uploadsDir + path.sep) || !IMAGE_EXT.test(abs)) return null;
    try {
      const stat = fs.statSync(abs);
      return stat.isFile() && stat.size <= max ? fs.readFileSync(abs) : null;
    } catch {
      return null;
    }
  }

  let current = value;
  const dnsCache = new Map<string, Promise<boolean>>();
  for (let hop = 0; hop <= 3; hop++) {
    const verdict = checkAssetUrl(current, policy.prefixes);
    if (!verdict.allowed || /^(data:|about:)/i.test(current)) {
      if (!verdict.allowed) console.warn(`[document-image] blocked ${describe(current)} (${'reason' in verdict ? verdict.reason : ''})${hop ? ' — redirect hop' : ''}`);
      return null;
    }
    if (policy.requirePublicDns && !(await resolvesPublic(new URL(current).hostname, dnsCache))) {
      console.warn(`[document-image] blocked ${describe(current)} (resolves to a non-public address)`);
      return null;
    }
    let response: Response;
    try {
      response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    } catch {
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok || !/^image\//i.test(response.headers.get('content-type') || '')) return null;
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > max) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length <= max ? buffer : null;
  }
  return null;
}
