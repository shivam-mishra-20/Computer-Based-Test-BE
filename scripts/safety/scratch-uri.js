/**
 * Print the connection URI for a NAMED scratch database.
 *
 * Manual testing needs a Mongo URI in the shell, and the obvious way to get one
 * is to paste it — which puts a production password into shell history, into
 * scrollback, and eventually into a screenshot. This derives the scratch URI
 * from `.env` instead, so the credential is never typed and never displayed
 * except as part of the URI the very next command consumes.
 *
 * It refuses to print the production database name. The whole point of a helper
 * that makes connecting easy is that it must not make connecting to the wrong
 * thing easy.
 *
 *   node scripts/safety/scratch-uri.js p6_client_platform_web_scratch
 */

require('dotenv/config');

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/safety/scratch-uri.js <scratch-db-name>');
  process.exit(2);
}

const production = process.env.MONGO_URI;
if (!production) {
  console.error('MONGO_URI is not set, so there is nothing to derive from.');
  process.exit(2);
}

const match = production.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/)([^?]*)(\?.*)?$/);
if (!match) {
  console.error('MONGO_URI could not be parsed.');
  process.exit(2);
}

const productionDb = match[2];
// Production is `abhigyangurukul`; `abhigyangurukul_console` is the main
// database .env points at. This used to refuse only the .env database, so it
// would print a working URI for production itself. Now it applies the same
// rule as assertNotProduction: protected names never, and nothing without a
// scratch marker.
const PROTECTED = new Set(['abhigyangurukul', 'abhigyangurukul_console', String(productionDb).toLowerCase()]);
const isScratch = /(^|[_-])(scratch|restore|rehearsal|verify)([_-]|$)/i.test(target);
if (PROTECTED.has(String(target).toLowerCase()) || !isScratch) {
  console.error(
    `Refusing to print a URI for "${target}". Only a scratch database (_scratch, _restore, _rehearsal,\n` +
      '_verify) — never the production or main database.',
  );
  process.exit(2);
}

process.stdout.write(`${match[1]}${target}${match[3] ?? ''}`);
