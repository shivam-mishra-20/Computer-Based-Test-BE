/**
 * Boots platform-core against a SCRATCH database, for driving the web clients
 * end to end.
 *
 *   P6_MODE=platform (default)  api-platform: claim mode, no ORG_ID — the
 *                               organization system.
 *   P6_MODE=legacy              the LEGACY system's configuration: no tenancy
 *                               variables at all, exactly as the production
 *                               legacy deployment runs today (pre-migration).
 *                               Used to stand in for that system — against a
 *                               scratch database, never the real one.
 *
 * Production credentials are inherited from `.env`; the database name, the
 * tenancy mode and the port are all overridden here, so no combination of
 * missing environment variables can point this at the live database.
 *
 *   P6_MONGO_URI=<scratch uri>  node scripts/safety/p6-fixture-server.js
 *   P6_MONGO_URI=<scratch uri>  P6_PORT=5000  node scripts/safety/p6-fixture-server.js
 *   P6_MONGO_URI=<scratch uri>  P6_MODE=legacy  P6_PORT=5072  node scripts/safety/p6-fixture-server.js
 *
 * `P6_MONGO_URI` wins; `.p6-uri` is the fallback for the common case of one
 * fixture database. The env var used to be ignored entirely, which meant a run
 * that thought it was pointed at the restore database was quietly serving the
 * fixture one — and the only symptom was an authentication failure that looked
 * like a token bug.
 */
require('./dns-preload.js');
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

function scratchUri() {
  if (process.env.P6_MONGO_URI && process.env.P6_MONGO_URI.trim()) {
    return process.env.P6_MONGO_URI.trim();
  }
  const file = path.join(__dirname, '..', '..', '.p6-uri');
  if (!fs.existsSync(file)) {
    throw new Error(`Set P6_MONGO_URI, or create ${file} naming the scratch database.`);
  }
  return fs.readFileSync(file, 'utf8').trim();
}

const uri = scratchUri();
const dbName = (uri.split('/').pop() || '').split('?')[0];
const productionDb = ((process.env.MONGO_URI || '').split('/').pop() || '').split('?')[0];
// The same rule as lib.ts `assertNotProduction`: production (`abhigyangurukul`)
// and the main database (`abhigyangurukul_console`) by name, whatever MONGO_URI
// says, and nothing that is not explicitly marked as scratch. This used to
// refuse only the `.env` database — so pointed at production itself, it served.
const PROTECTED = new Set(['abhigyangurukul', 'abhigyangurukul_console', productionDb.toLowerCase()]);
const isScratch = /(^|[_-])(scratch|restore|rehearsal|verify)([_-]|$)/i.test(dbName);
if (!dbName || PROTECTED.has(dbName.toLowerCase()) || !isScratch) {
  throw new Error(
    `Refusing to serve "${dbName}": this fixture server runs only against a scratch database ` +
      '(_scratch, _restore, _rehearsal, _verify), never the production or main database.',
  );
}

const mode = (process.env.P6_MODE || 'platform').trim().toLowerCase();
if (mode !== 'platform' && mode !== 'legacy') {
  throw new Error(`P6_MODE must be "platform" or "legacy", not "${mode}".`);
}

process.env.MONGO_URI = uri;
if (mode === 'legacy') {
  // Empty, not deleted: `.env` sets TENANT_MODE, and a later dotenv load would
  // restore a DELETED key — it never overwrites one that is present. Empty
  // strings read as "not configured": the pre-migration path.
  process.env.TENANT_MODE = '';
  process.env.TENANT_ENFORCEMENT = '';
  process.env.ORG_ID = '';
  process.env.LEGACY_DATA_ORG_ID = '';
} else {
  process.env.TENANT_MODE = 'claim';
  process.env.TENANT_ENFORCEMENT = process.env.TENANT_ENFORCEMENT || 'warn';
  delete process.env.ORG_ID;
}
// Unconditional: `.env` already put PORT=5000 into process.env above, so a
// `||` default would silently keep production's port.
process.env.PORT = process.env.P6_PORT || '5055';
process.env.ENABLE_CRON = 'false';
process.env.PPT_WORKER_EMBEDDED = 'false';
process.env.REDIS_ENABLED = 'false';

// A cluster at its collection cap (Atlas: 500 across every database) cannot
// take the collections Mongoose would create for models this scratch database
// has never used, and the boot fails part-way. Off, the server reads and writes
// the collections that already exist and creates none.
if (process.env.P6_AUTO_CREATE === 'false') {
  const mongoose = require('mongoose');
  mongoose.set('autoCreate', false);
  mongoose.set('autoIndex', false);
}

console.log(`[p6] serving ${dbName} on port ${process.env.PORT} (${mode === 'legacy' ? 'legacy, pre-migration' : 'TENANT_MODE=claim'})`);

process.on('unhandledRejection', (r) => console.warn('[p6] unhandled rejection:', r && r.message));

require('ts-node').register({ transpileOnly: true });
require('../../src/server.ts');
