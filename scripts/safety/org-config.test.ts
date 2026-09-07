/**
 * Per-organization configuration.
 *
 * Two properties carry this phase:
 *
 *   1. FALLBACK. No organization has configuration rows yet. If an empty result
 *      meant "no class levels", every picker in Abhigyan would blank on deploy.
 *      Absent configuration must mean "as before", never "nothing".
 *
 *   2. NON-NUMERIC CLASS LABELS. The old `normalizeClassValue()` matches
 *      /(\d{1,2})/ and returns null for anything else, so ABC Coaching's
 *      "Dropper" batch — a real and common Indian class label — fails
 *      validation silently. This is the single cheapest test of whether the
 *      class rework actually generalizes beyond Abhigyan's shape.
 *
 * Pure logic — no database.
 *
 *   npx ts-node --transpile-only scripts/safety/org-config.test.ts
 */

import {
  legacyClassLevels,
  legacySubjects,
  legacyRooms,
  resolveClassKey,
  type ResolvedClassLevel,
} from '../../src/core/config/orgConfig';
import { SUPPORTED_CLASS_VALUES } from '../../src/config/studentBatchConfig';
import { CURRICULUM_SUBJECTS } from '../../src/config/subjects';
import { ROOMS, ROOM_CAPACITY } from '../../src/models/RoomAllocation';
import {
  encryptSecret,
  decryptSecret,
  encryptionAvailable,
  EncryptionKeyMissing,
  describeSecret,
} from '../../src/core/config/secrets';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function main() {
  console.log('Per-organization configuration\n');

  // ── Fallback preserves today's behaviour EXACTLY ────────────────────────
  console.log('fallback to legacy constants (outage prevention)');
  {
    const levels = legacyClassLevels();
    check(
      `class levels fall back to the live constant (${SUPPORTED_CLASS_VALUES.length} levels)`,
      levels.length === SUPPORTED_CLASS_VALUES.length,
      `got ${levels.length}`,
    );
    check(
      'keys match SUPPORTED_CLASS_VALUES exactly',
      levels.map((l) => l.key).join(',') === SUPPORTED_CLASS_VALUES.join(','),
      levels.map((l) => l.key).join(','),
    );
    check(
      'labels keep the "Class N" spelling production uses',
      levels.every((l) => l.label === `Class ${l.key}`),
    );
    check(
      'aliases carry BOTH production spellings ("11" and "Class 11")',
      levels.every((l) => l.aliases.includes(l.key) && l.aliases.includes(`Class ${l.key}`)),
      'the split that forces normalization helpers into ~10 files',
    );

    const subjects = legacySubjects();
    check(
      `subjects fall back to the live constant (${CURRICULUM_SUBJECTS.length})`,
      subjects.length === CURRICULUM_SUBJECTS.length &&
        subjects.every((s, i) => s === CURRICULUM_SUBJECTS[i]),
    );

    const rooms = legacyRooms();
    check(`rooms fall back to the live constant (${ROOMS.length})`, rooms.length === ROOMS.length);
    check(
      'room capacities match ROOM_CAPACITY exactly',
      rooms.every((r) => r.capacity === ROOM_CAPACITY[r.name]),
      rooms.map((r) => `${r.name}=${r.capacity}`).join(' '),
    );
    check(
      'Room 10 keeps its capacity of 10 (the smallest, easiest to get wrong)',
      rooms.find((r) => r.name === 'Room 10')?.capacity === 10,
    );
  }

  // ── Abhigyan's own spellings still resolve ──────────────────────────────
  console.log('\nlegacy class resolution (Org 001 must be unaffected)');
  {
    const levels = legacyClassLevels();
    check('"11" resolves', resolveClassKey('11', levels) === '11');
    check('"Class 11" resolves', resolveClassKey('Class 11', levels) === '11');
    check('"class 11" resolves case-insensitively', resolveClassKey('class 11', levels) === '11');
    check('" 12 " tolerates whitespace', resolveClassKey(' 12 ', levels) === '12');
    check('"6" is rejected — not in Abhigyan\'s range', resolveClassKey('6', levels) === null);
    check('null input is null', resolveClassKey(null, levels) === null);
    check('empty string is null', resolveClassKey('', levels) === null);
  }

  // ── ABC Coaching — the Org 002 shape ────────────────────────────────────
  console.log('\nOrg 002 shape: non-numeric labels and a different range');
  {
    const abc: ResolvedClassLevel[] = [
      { key: '9', label: 'Class 9', aliases: ['9', 'Class 9'], order: 0 },
      { key: '10', label: 'Class 10', aliases: ['10', 'Class 10'], order: 1 },
      { key: '11', label: 'Class 11', aliases: ['11', 'Class 11'], order: 2 },
      { key: '12', label: 'Class 12', aliases: ['12', 'Class 12'], order: 3 },
      { key: 'dropper', label: 'Dropper', aliases: ['Dropper', 'Droppers', 'Repeater'], order: 4 },
    ];

    check(
      '"Dropper" RESOLVES — the case the old helper silently rejected',
      resolveClassKey('Dropper', abc) === 'dropper',
      'normalizeClassValue() matches /(\\d{1,2})/ and returns null here',
    );
    check('"dropper" resolves case-insensitively', resolveClassKey('dropper', abc) === 'dropper');
    check('"Repeater" resolves via alias', resolveClassKey('Repeater', abc) === 'dropper');
    check(
      '"7" is rejected — ABC does not teach Class 7, though Abhigyan does',
      resolveClassKey('7', abc) === null,
      'proves resolution is per-organization, not global',
    );
    check('ABC still resolves its numeric levels', resolveClassKey('Class 12', abc) === '12');
    check(
      'a digit inside a word does not leak through',
      resolveClassKey('Batch 11 Evening', abc) === null,
      'the old helper would extract "11" from this',
    );
  }

  // ── Credential sealing ──────────────────────────────────────────────────
  console.log('\nintegration credential sealing');
  {
    const saved = process.env.CONFIG_ENCRYPTION_KEY;

    delete process.env.CONFIG_ENCRYPTION_KEY;
    check('no key configured: encryptionAvailable() is false', encryptionAvailable() === false);
    let refused = false;
    try {
      encryptSecret('AbhigyanGurukul:secret');
    } catch (error) {
      refused = error instanceof EncryptionKeyMissing;
    }
    check(
      'no key configured: REFUSES rather than storing plaintext',
      refused,
      'storing a credential in the clear because a variable was unset is the ' +
        'exact outcome this module exists to prevent',
    );

    process.env.CONFIG_ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes of hex
    check('key configured: encryptionAvailable() is true', encryptionAvailable() === true);

    const plaintext = 'AbhigyanGurukul:AbhigyanGurukul:ABGU4698@:true';
    const sealed = encryptSecret(plaintext);
    check('round-trips exactly', decryptSecret(sealed) === plaintext);
    check(
      'ciphertext does not contain the plaintext',
      !sealed.data.includes('Abhigyan') && !Buffer.from(sealed.data, 'base64').toString('utf8').includes('Abhigyan'),
    );
    check('each encryption uses a fresh IV', encryptSecret(plaintext).iv !== sealed.iv);

    // GCM authenticates: a tampered ciphertext must not decrypt.
    const tampered = { ...sealed, data: Buffer.from('tampered-value').toString('base64') };
    let detected = false;
    try {
      decryptSecret(tampered);
    } catch {
      detected = true;
    }
    check(
      'tampering is DETECTED (this is why GCM, not CBC)',
      detected,
      'with CBC an attacker with database write access could flip bits unnoticed',
    );

    check('describeSecret never reveals content', !describeSecret(sealed).includes('Abhigyan'));

    if (saved === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
    else process.env.CONFIG_ENCRYPTION_KEY = saved;
  }

  console.log('');
  if (failures) {
    console.error(`ORG-CONFIG TESTS FAILED — ${failures} of ${checks}.`);
    process.exit(1);
  }
  console.log(`All ${checks} org-config checks passed.`);
}

main();
