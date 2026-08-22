/**
 * Start api-platform against a NAMED scratch database, for manual testing.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Running the platform deployment by hand means setting seven environment
 * variables, and getting ONE of them wrong fails quietly in a way that looks
 * like a product bug. `TENANT_MODE` left at its default is the dangerous one:
 * the server starts, serves, and resolves every request to the wrong tenant
 * model, and you find out three screens later.
 *
 * So the configuration lives here, in one place, with the safety checks that
 * have to hold for it:
 *
 *   • the target database must be named, and must not be production
 *   • TENANT_MODE=claim — the tenant comes from the token's orgId claim
 *   • TENANT_ENFORCEMENT=warn — writes are stamped, reads are NOT filtered.
 *     Say it out loud at startup, because a leak in warn mode looks exactly
 *     like working software.
 *   • cron off, embedded workers off — a manual test session should not fire
 *     attendance syncs or end-of-day reminders
 *
 *   node scripts/safety/serve-platform.js p6_client_platform_web_scratch [port]
 */

const { spawnSync, spawn } = require('child_process');
const { join } = require('path');

const target = process.argv[2];
const port = process.argv[3] || '5055';

if (!target) {
  console.error('usage: node scripts/safety/serve-platform.js <scratch-db-name> [port]');
  process.exit(2);
}

// Reuse the guarded deriver rather than re-implementing the refusal. Two copies
// of a safety check is one copy of a safety check.
const derived = spawnSync(process.execPath, [join(__dirname, 'scratch-uri.js'), target], {
  encoding: 'utf8',
});
if (derived.status !== 0) {
  process.stderr.write(derived.stderr || 'could not derive a scratch URI\n');
  process.exit(derived.status || 2);
}

const uri = derived.stdout.trim();
const redacted = uri.replace(/:\/\/[^@]*@/, '://***@');

console.log('');
console.log('  api-platform (manual testing)');
console.log(`    database    ${redacted}`);
console.log(`    port        ${port}`);
console.log('    TENANT_MODE claim — tenant comes from the token, not from ORG_ID');
console.log('    ENFORCEMENT warn  — writes stamped, reads NOT filtered');
console.log('');

const child = spawn(
  process.execPath,
  [
    join(__dirname, '..', '..', 'node_modules', 'ts-node-dev', 'lib', 'bin.js'),
    '--transpile-only',
    '--no-notify',
    join(__dirname, '..', '..', 'src', 'server.ts'),
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      MONGO_URI: uri,
      PORT: port,
      TENANT_MODE: 'claim',
      TENANT_ENFORCEMENT: 'warn',
      ENABLE_CRON: 'false',
      REDIS_ENABLED: 'false',
      PPT_WORKER_EMBEDDED: 'false',
    },
  },
);

child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
