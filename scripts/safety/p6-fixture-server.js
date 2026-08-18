/**
 * Boots platform-core in api-platform configuration — claim mode, no ORG_ID —
 * against a SCRATCH database, for driving client-platform-web through two
 * organizations.
 *
 * Production credentials are inherited from `.env`; the database name, the
 * tenancy mode and the port are all overridden here, so no combination of
 * missing environment variables can point this at the live database.
 *
 *   P6_MONGO_URI=<scratch uri>  node scripts/safety/p6-fixture-server.js
 *   P6_MONGO_URI=<scratch uri>  P6_PORT=5000  node scripts/safety/p6-fixture-server.js
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
if (!dbName || dbName === productionDb) {
  throw new Error(
    `Refusing to serve "${dbName}": this fixture server must run against a scratch database.`,
  );
}

process.env.MONGO_URI = uri;
process.env.TENANT_MODE = 'claim';
process.env.TENANT_ENFORCEMENT = process.env.TENANT_ENFORCEMENT || 'warn';
delete process.env.ORG_ID;
// Unconditional: `.env` already put PORT=5000 into process.env above, so a
// `||` default would silently keep production's port.
process.env.PORT = process.env.P6_PORT || '5055';
process.env.ENABLE_CRON = 'false';
process.env.PPT_WORKER_EMBEDDED = 'false';
process.env.REDIS_ENABLED = 'false';

console.log(`[p6] serving ${dbName} on port ${process.env.PORT} (TENANT_MODE=claim)`);

process.on('unhandledRejection', (r) => console.warn('[p6] unhandled rejection:', r && r.message));

require('ts-node').register({ transpileOnly: true });
require('../../src/server.ts');
