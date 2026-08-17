/**
 * Entitlement resolution and module gating.
 *
 * The highest-value check in this file is the FIRST one: an organization with
 * no Subscription must resolve to EVERY module. Today no organization has a
 * subscription — the collection is brand new — so a "no subscription means no
 * modules" default would make every `requireModule()` route start returning 403
 * the moment this shipped.
 *
 * That is the same failure as the defaulted-pinned 503 and the defaulted cron
 * disable, and it is the third time the pattern has appeared:
 *
 *     A safe default for COMMERCE is not a safe default for BEHAVIOUR.
 *
 * Pure logic — no database, no Redis.
 *
 *   npx ts-node --transpile-only scripts/safety/entitlements.test.ts
 */

import {
  MODULES,
  CORE_MODULE_KEYS,
  expandDependencies,
  validateRegistry,
  allModuleKeys,
  isCoreModule,
} from '../../src/core/entitlements/moduleRegistry';
import { computeModules, computeLimits } from '../../src/core/entitlements/resolve';

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
  console.log('Entitlements\n');

  // ── Registry integrity ───────────────────────────────────────────────────
  console.log('module registry');
  const validation = validateRegistry();
  check(
    `registry is structurally valid (${MODULES.length} modules)`,
    validation.ok,
    validation.errors.join('; '),
  );
  check('no duplicate keys', new Set(MODULES.map((m) => m.key)).size === MODULES.length);
  check(
    'every module has a description',
    MODULES.every((m) => m.description && m.description.length > 10),
  );
  check(
    'every module declares onDisable',
    MODULES.every((m) => m.onDisable === 'retain' || m.onDisable === 'archive'),
  );
  check(
    'disabling never destroys data — all modules retain',
    MODULES.every((m) => m.onDisable === 'retain'),
    'a customer who downgrades and loses their history tells everyone',
  );

  // ── Dependency expansion ────────────────────────────────────────────────
  console.log('\ndependency expansion');
  {
    const expanded = expandDependencies(['results']);
    check(
      'asking for Results pulls in Exams',
      expanded.includes('exams'),
      'Results without Exams is a packaging error that presents as a bug',
    );
    check('...and Classes, transitively', expanded.includes('classes'));
    check(
      'core modules are always included',
      CORE_MODULE_KEYS.every((k) => expanded.includes(k)),
    );
  }
  {
    const expanded = expandDependencies([]);
    check(
      'an empty plan still yields exactly the core modules',
      expanded.length === CORE_MODULE_KEYS.length,
      `got ${expanded.length}`,
    );
  }
  {
    const expanded = expandDependencies(['questionImport']);
    check(
      'questionImport pulls questionBank -> subjects -> classes -> students',
      ['questionBank', 'subjects', 'classes', 'students'].every((k) => expanded.includes(k)),
      expanded.join(','),
    );
  }
  {
    const expanded = expandDependencies(['nonexistent-module']);
    check(
      'an unknown key is dropped, not fatal',
      !expanded.includes('nonexistent-module') && expanded.length === CORE_MODULE_KEYS.length,
    );
  }

  // ── Composition order ───────────────────────────────────────────────────
  console.log('\ncomposition: plan ∪ addOns − removals, then overrides');
  {
    const modules = computeModules({
      planModules: ['exams', 'results'],
      addOns: ['attendance'],
      removals: [],
    });
    check('add-ons are included', modules.includes('attendance'));
  }
  {
    const modules = computeModules({
      planModules: ['exams', 'results', 'attendance'],
      removals: ['attendance'],
    });
    check('removals are applied', !modules.includes('attendance'));
  }
  {
    // The ordering rule that matters: a negotiated grant must survive a removal.
    const modules = computeModules({
      planModules: ['exams'],
      removals: ['ai'],
      overrideModules: ['ai'],
    });
    check(
      'overrides are applied LAST and beat removals',
      modules.includes('ai'),
      'an Enterprise grant must not need a bespoke plan to survive',
    );
  }
  {
    const modules = computeModules({ planModules: ['results'], removals: ['exams'] });
    check(
      'removing a dependency of a kept module re-adds it',
      modules.includes('exams'),
      'Results cannot function without Exams, so the removal is incoherent',
    );
  }

  // ── Limits ──────────────────────────────────────────────────────────────
  console.log('\nlimits');
  {
    const limits = computeLimits({ students: 300, storageGb: 50 }, { students: 1000 });
    check('override replaces the plan limit', limits.students === 1000);
    check('un-overridden plan limits survive', limits.storageGb === 50);
  }
  {
    const limits = computeLimits({ students: undefined }, {});
    check('undefined plan limits are dropped, not coerced to 0', limits.students === undefined);
  }

  // ── Core gating ─────────────────────────────────────────────────────────
  console.log('\ncore modules');
  check('auth is core', isCoreModule('auth'));
  check('exams is NOT core', !isCoreModule('exams'));
  check(
    'core modules appear in allModuleKeys',
    CORE_MODULE_KEYS.every((k) => allModuleKeys().includes(k)),
  );

  // ── THE DEFAULT THAT PREVENTS AN OUTAGE ─────────────────────────────────
  // Verified by reading the source, because resolveEntitlement() needs a
  // database. The unsubscribed path returns allModuleKeys().
  console.log('\nthe no-subscription default (outage prevention)');
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'src', 'core', 'entitlements', 'resolve.ts'),
      'utf8',
    ) as string;

    const unsubscribedFn = source.slice(
      source.indexOf('function unsubscribedEntitlement'),
      source.indexOf('export function computeModules'),
    );
    check(
      'an organization with NO subscription resolves to ALL modules',
      unsubscribedFn.includes('allModuleKeys()'),
      'returning [] here would 403 every gated route the moment this shipped — ' +
        'no organization has a Subscription yet',
    );
    check(
      'platform-owned organizations resolve to ALL modules (ADR-12)',
      source.includes('function platformOwnedEntitlement') &&
        source
          .slice(source.indexOf('function platformOwnedEntitlement'))
          .slice(0, 600)
          .includes('allModuleKeys()'),
      'Abhigyan is not a customer; billing must never disable its features',
    );
  }

  console.log('');
  if (failures) {
    console.error(`ENTITLEMENT TESTS FAILED — ${failures} of ${checks}.`);
    process.exit(1);
  }
  console.log(`All ${checks} entitlement checks passed.`);
}

main();
