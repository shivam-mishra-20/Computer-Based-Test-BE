/**
 * The design-template rules, as this server holds them.
 *
 * Mirrored from platform-client-core/src/design (see each file's header):
 * the schema, the twenty templates, the selection validator and the
 * lifecycle. What the server does NOT need — the colour resolver, the
 * contrast audit, the renderers — stays in the clients; a selection is stored
 * as a reference plus overrides, never as tokens, so the server never has to
 * compute a colour.
 *
 *   npm run safety:design-rules   fails if this mirror drifts
 */

export * from './schema';
export * from './validate';
export * from './lifecycle';
export * from './catalogue';
export { normalizeHex } from './hex';
