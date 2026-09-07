/**
 * P0 — the production-write guard is the last thing standing between a
 * mistyped restore target and an overwritten production database. It is worth
 * testing on its own, with no database and no network, so it can run on every
 * pull request in under a second.
 *
 * The cases below are chosen around the ways the guard could fail OPEN, which
 * is the only direction that matters. A guard that wrongly refuses a valid
 * scratch database is an annoyance; a guard that wrongly permits production is
 * the end of the company.
 *
 *   npx ts-node scripts/safety/guard.test.ts
 */

import { assertNotProduction, describeUri, redactUri } from './lib';

const PROD = 'mongodb+srv://user:secret@cluster.abc.mongodb.net/abhigyangurukul';

interface Case {
  label: string;
  uri: string;
  shouldAllow: boolean;
  why: string;
}

const cases: Case[] = [
  {
    label: 'exact production URI',
    uri: PROD,
    shouldAllow: false,
    why: 'the obvious mistake — pasting MONGO_URI as the target',
  },
  {
    label: 'production without credentials',
    uri: 'mongodb+srv://cluster.abc.mongodb.net/abhigyangurukul',
    shouldAllow: false,
    why: 'same host and database; credentials are irrelevant to identity',
  },
  {
    label: 'different database, no scratch marker',
    uri: 'mongodb+srv://user:secret@cluster.abc.mongodb.net/staging',
    shouldAllow: false,
    why: 'a real database that is not production is still not a scratch target',
  },
  {
    label: 'different host, production database name',
    uri: 'mongodb://localhost:27017/abhigyangurukul',
    shouldAllow: false,
    why: 'a local database named like production is a trap for the next operator',
  },
  {
    label: 'unparseable URI',
    uri: 'not-a-uri',
    shouldAllow: false,
    why: 'FAIL CLOSED — what cannot be proven safe is treated as production',
  },
  {
    label: 'no database name',
    uri: 'mongodb+srv://user:secret@cluster.abc.mongodb.net/',
    shouldAllow: false,
    why: 'an empty database name resolves to the driver default, not to nothing',
  },
  {
    label: 'scratch marker: _restore_',
    uri: 'mongodb+srv://user:secret@cluster.abc.mongodb.net/abhigyangurukul_restore_2026_08_17',
    shouldAllow: true,
    why: 'the sanctioned rehearsal target',
  },
  {
    label: 'scratch marker: _rehearsal',
    uri: 'mongodb://localhost:27017/ag_rehearsal',
    shouldAllow: true,
    why: 'local rehearsal is allowed',
  },
  {
    label: 'scratch marker: _scratch',
    uri: 'mongodb://localhost:27017/anything_scratch',
    shouldAllow: true,
    why: 'explicit operator intent',
  },
  {
    label: 'marker only as a substring',
    uri: 'mongodb://localhost:27017/restoration',
    shouldAllow: false,
    why: '"restoration" contains "restore" but is not a scratch marker — the '
      + 'boundary check must not match mid-word, or a real database called '
      + '"restorations" would be accepted as scratch',
  },
];

function main() {
  console.log('P0 production-write guard\n');
  let failures = 0;

  for (const testCase of cases) {
    let allowed = true;
    let message = '';
    try {
      assertNotProduction(testCase.uri, PROD);
    } catch (error) {
      allowed = false;
      message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    }

    const ok = allowed === testCase.shouldAllow;
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'} ${testCase.label}`);
    console.log(`      ${testCase.why}`);
    if (!ok) {
      console.log(`      EXPECTED allowed=${testCase.shouldAllow} GOT allowed=${allowed} ${message}`);
    }
  }

  // Credentials must never reach a log, a terminal recording or this document.
  const redacted = redactUri(PROD);
  const leaks = redacted.includes('secret');
  console.log(`\n  ${leaks ? '✗' : '✓'} redactUri strips credentials  →  ${redacted}`);
  if (leaks) failures++;

  const described = describeUri(PROD);
  const parsedOk = described?.db === 'abhigyangurukul';
  console.log(`  ${parsedOk ? '✓' : '✗'} describeUri extracts database name  →  ${described?.db}`);
  if (!parsedOk) failures++;

  console.log('');
  if (failures) {
    console.error(`GUARD TEST FAILED — ${failures} case(s). Do not run any restore tooling.`);
    process.exit(1);
  }
  console.log('All guard cases correct.');
}

main();
