/**
 * This server's public address, for a URL Cashfree calls back on (the
 * auto-pay return). PUBLIC_API_BASE_URL when set — it should be, in
 * production, as the HTTPS address the outside world uses (for example
 * https://api.example.com/platform-api). Otherwise derived from the request:
 * through the gateway (`/platform-api/X` → the runtime's `/api/X`, which sets
 * x-forwarded-host) the public path is /platform-api; standalone it is /api.
 */
export function publicApiBase(headers: Record<string, string | string[] | undefined>, protocol: string): string {
  const configured = String(process.env.PUBLIC_API_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const first = (v: string | string[] | undefined) => String(Array.isArray(v) ? v[0] : v ?? '').split(',')[0].trim();
  const forwardedHost = first(headers['x-forwarded-host']);
  const host = forwardedHost || first(headers.host);
  const proto = first(headers['x-forwarded-proto']) || protocol || 'https';
  return `${proto}://${host}${forwardedHost ? '/platform-api' : '/api'}`;
}
