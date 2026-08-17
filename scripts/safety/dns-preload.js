/**
 * DNS preload for scripts that call `mongoose.connect()` directly.
 *
 * `src/config/db.ts` overrides the DNS resolvers before connecting, because on
 * some networks — including this development machine — the default resolver
 * refuses SRV queries outright and every `mongodb+srv://` connection fails with
 * `querySrv ECONNREFUSED`.
 *
 * Several standalone verification scripts predate that helper and connect
 * directly, so they inherit the broken resolver. Rather than edit working
 * production tooling to fix an environment problem, preload this:
 *
 *   node -r ./scripts/safety/dns-preload.js -r ts-node/register/transpile-only \
 *        scripts/verify-learner-isolation.ts
 */
const dns = require('node:dns');

const raw = process.env.MONGO_DNS_SERVERS || '8.8.8.8,1.1.1.1';
const servers = raw.split(',').map((s) => s.trim()).filter(Boolean);

if (servers.length) {
  try {
    dns.setServers(servers);
  } catch {
    // Non-fatal: the connection attempt will report the real problem.
  }
}
