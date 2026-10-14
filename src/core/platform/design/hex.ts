/**
 * The one colour helper the mirrored design rules need on the server.
 *
 * `validate.ts` normalizes an organization's override colours. In
 * platform-client-core it takes `normalizeHex` from the package's own
 * `color.ts`; this server cannot import that package, so it keeps the same
 * function here. Same rule as the client: three or six hex digits, optional
 * `#`, normalized to lower-case `#rrggbb`, anything else is null.
 */

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normalizeHex(value: string | undefined | null): string | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!HEX.test(trimmed)) return null;
  const body = trimmed.replace('#', '');
  const full =
    body.length === 3
      ? body
          .split('')
          .map((c) => c + c)
          .join('')
      : body;
  return `#${full.toLowerCase()}`;
}
