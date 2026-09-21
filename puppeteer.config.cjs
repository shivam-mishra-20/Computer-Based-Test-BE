/**
 * Puppeteer configuration.
 *
 * This project depends on `puppeteer-core`, which ships no browser and
 * downloads nothing, so today this file changes no behaviour. It exists so
 * that the intent survives: `src/utils/launchBrowser.ts` falls back to the
 * full `puppeteer` package if it is ever installed, and without this that
 * install would pull a ~150 MB Chromium into every CI run and deploy image.
 *
 * This replaces `puppeteer_skip_chromium_download=true` in .npmrc, which npm
 * warned about on every command because it is not an npm setting — Puppeteer
 * dropped the npm-config route in v19 in favour of this file and the
 * PUPPETEER_SKIP_DOWNLOAD environment variable.
 */
module.exports = {
  skipDownload: true,
};
