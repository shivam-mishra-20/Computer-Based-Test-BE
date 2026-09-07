/**
 * Inventory every `$lookup` in the codebase and classify its tenant safety.
 *
 * ── Why this needs to be a standing check, not a one-off report ─────────────
 * The global Mongoose plugin scopes the collection an aggregation runs ON. It
 * cannot reach inside a `$lookup`, because the joined collection is read by the
 * server without passing through that collection's middleware. Today there are
 * four; the danger is the fifth, added months from now by someone who has never
 * read the tenancy docs. This fails the build on an unclassified `$lookup`.
 *
 * ── Classification ──────────────────────────────────────────────────────────
 *   SAFE-BY-KEY    The join key is an _id taken FROM an already-scoped source
 *                  document, so the joined row is reachable only via a row the
 *                  tenant already owns. Sound in practice, but it depends on
 *                  referential integrity rather than on an enforced filter,
 *                  which is why these still get an explicit constraint under
 *                  enforce as defence in depth.
 *   NEEDS-FILTER   The joined collection is tenant-scoped and the join is not
 *                  anchored to a scoped _id — a real cross-tenant read.
 *   EXEMPT-JOIN    The joined collection is global (Org, Plan, Module…).
 *   UNCLASSIFIED   Could not be determined. Fails the build.
 *
 *   npx ts-node scripts/safety/lookup-audit.ts
 *   npx ts-node scripts/safety/lookup-audit.ts --check
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(process.cwd(), 'src');

/** Collections that are global by design and never carry an orgId. */
const GLOBAL_COLLECTIONS = new Set(['orgs', 'plans', 'modules', 'platformusers']);

/** `tenantLookup(...)` emits a scoped join under enforce — already handled. */
const HELPER_NAME = 'tenantLookup';

interface LookupSite {
  file: string;
  line: number;
  from: string;
  localField?: string;
  foreignField?: string;
  usesHelper: boolean;
  hasPipeline: boolean;
  classification: 'SAFE-BY-KEY' | 'NEEDS-FILTER' | 'EXEMPT-JOIN' | 'HANDLED' | 'UNCLASSIFIED';
  note: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

function classify(site: Omit<LookupSite, 'classification' | 'note'>): {
  classification: LookupSite['classification'];
  note: string;
} {
  if (site.usesHelper) {
    return {
      classification: 'HANDLED',
      note: 'uses tenantLookup() — scoped automatically under enforce',
    };
  }
  if (GLOBAL_COLLECTIONS.has(site.from.toLowerCase())) {
    return { classification: 'EXEMPT-JOIN', note: `"${site.from}" is a global collection` };
  }
  if (site.hasPipeline) {
    return {
      classification: 'UNCLASSIFIED',
      note: 'pipeline-form $lookup — verify the sub-pipeline matches orgId by hand',
    };
  }
  if (site.foreignField === '_id') {
    return {
      classification: 'SAFE-BY-KEY',
      note: 'joins on _id taken from an already-scoped source document',
    };
  }
  return {
    classification: 'NEEDS-FILTER',
    note: `joins "${site.from}" on ${site.foreignField} — not anchored to a scoped _id`,
  };
}

function collect(): LookupSite[] {
  const sites: LookupSite[] = [];

  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('$lookup') && !source.includes(HELPER_NAME)) continue;

    const rel = relative(process.cwd(), file).replace(/\\/g, '/');

    // Skip the tenancy module's own documentation of the problem.
    if (rel.includes('core/tenancy/')) continue;

    for (const match of source.matchAll(/\$lookup\s*:\s*\{([\s\S]{0,400}?)\}/g)) {
      const body = match[1];
      const line = source.slice(0, match.index ?? 0).split('\n').length;

      // A comment mentioning $lookup is not a call site.
      const lineText = source.split('\n')[line - 1] || '';
      if (/^\s*(\*|\/\/)/.test(lineText)) continue;

      const from = body.match(/from\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] ?? '?';
      const localField = body.match(/localField\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
      const foreignField = body.match(/foreignField\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
      const hasPipeline = /pipeline\s*:/.test(body);

      const partial = { file: rel, line, from, localField, foreignField, usesHelper: false, hasPipeline };
      sites.push({ ...partial, ...classify(partial) });
    }

    // Calls through the helper.
    for (const match of source.matchAll(new RegExp(`${HELPER_NAME}\\s*\\(\\s*\\{([\\s\\S]{0,300}?)\\}`, 'g'))) {
      const body = match[1];
      const line = source.slice(0, match.index ?? 0).split('\n').length;
      const from = body.match(/from\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] ?? '?';
      const partial = {
        file: rel,
        line,
        from,
        localField: body.match(/localField\s*:\s*['"`]([^'"`]+)['"`]/)?.[1],
        foreignField: body.match(/foreignField\s*:\s*['"`]([^'"`]+)['"`]/)?.[1],
        usesHelper: true,
        hasPipeline: false,
      };
      sites.push({ ...partial, ...classify(partial) });
    }
  }

  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function main() {
  const sites = collect();
  const byClass = (c: LookupSite['classification']) => sites.filter((s) => s.classification === c);

  console.log('$lookup tenant-safety inventory\n');
  console.log(`  total call sites: ${sites.length}\n`);

  for (const site of sites) {
    const tag = site.classification.padEnd(13);
    console.log(`  ${tag} ${site.file}:${site.line}`);
    console.log(`                from: ${site.from}${site.localField ? `  ${site.localField} -> ${site.foreignField}` : ''}`);
    console.log(`                ${site.note}`);
  }

  const summary = {
    HANDLED: byClass('HANDLED').length,
    'SAFE-BY-KEY': byClass('SAFE-BY-KEY').length,
    'EXEMPT-JOIN': byClass('EXEMPT-JOIN').length,
    'NEEDS-FILTER': byClass('NEEDS-FILTER').length,
    UNCLASSIFIED: byClass('UNCLASSIFIED').length,
  };

  console.log('\n─── summary ───');
  for (const [key, value] of Object.entries(summary)) {
    console.log(`  ${key.padEnd(14)} ${value}`);
  }

  if (process.argv.includes('--check')) {
    const blocking = summary['NEEDS-FILTER'] + summary.UNCLASSIFIED;
    if (blocking > 0) {
      console.error(
        `\nFAILED — ${blocking} $lookup site(s) are not provably tenant-safe.\n` +
          `Convert them to tenantLookup(), or add an explicit orgId match to the\n` +
          `sub-pipeline and re-run this audit.`,
      );
      process.exit(1);
    }
    console.log('\nPASSED — every $lookup is handled, safe by key, or joins a global collection.');
  }
}

main();
