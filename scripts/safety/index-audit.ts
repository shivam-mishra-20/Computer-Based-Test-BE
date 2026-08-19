/**
 * Globally unique indexes on tenant-owned collections.
 *
 * ── The defect this hunts ───────────────────────────────────────────────────
 * A unique index on a business key alone makes that key unique across the
 * ENTIRE platform rather than within an organization. Two have already been
 * found the expensive way:
 *
 *   batches.name_1     two institutes both running a "NEET" batch — the second
 *                      silently failed to create, producing three batches out
 *                      of four during Org 002 onboarding.
 *   appsettings.key_1  two institutes cannot both hold MORNING_TIME_SLOTS, so
 *                      the second to save its timetable overwrote the first.
 *
 * Both were found by a person noticing something odd. This finds the rest by
 * reading the schemas, before a customer does.
 *
 * ── Reads schemas, not a database ───────────────────────────────────────────
 * It compiles the real models through the real import graph and inspects their
 * declared indexes. That means it runs in CI with no connection string, and it
 * describes what the code WILL build — which is what a review needs. What a
 * database currently HAS is a separate question, answered by
 * `drop-legacy-global-indexes.ts --target-env`.
 *
 *   npx ts-node --transpile-only scripts/safety/index-audit.ts
 */

process.env.TENANT_ENFORCEMENT = process.env.TENANT_ENFORCEMENT || 'warn';
process.env.ENABLE_CRON = 'false';
process.env.PPT_WORKER_EMBEDDED = 'false';
process.env.REDIS_ENABLED = 'false';

import mongoose from 'mongoose';
import { readdirSync } from 'fs';
import { join } from 'path';
import { registerTenancy } from '../../src/core/tenancy';

registerTenancy();

/**
 * Collections that are GLOBAL or PLATFORM-owned, where a globally unique index
 * is correct rather than a defect.
 *
 * These are the same collections the tenancy layer exempts from scoping: they
 * describe the platform itself, not any tenant's data.
 */
const NON_TENANT_MODELS = new Set([
  'Org',
  'Plan',
  'Subscription',
  'Entitlement',
  'UsageRecord',
  'PlatformUser',
  'PlatformAudit',
]);

/**
 * Unique indexes that are globally unique ON PURPOSE, with the reason.
 *
 * Each is a deliberate platform-wide constraint. A new one has to be added
 * here, which forces the same argument to be made out loud.
 */
const INTENTIONAL: Record<string, string> = {
  'User.email_1':
    'Retained deliberately. Email is the login identifier and login happens ' +
    'BEFORE any organization is known, so a globally unique address is what ' +
    'makes `User.findOne({ email })` unambiguous at the one moment no tenant ' +
    'context exists. The compound { orgId, email } index exists alongside it ' +
    'for the day the platform supports the same person at two institutes; ' +
    'dropping the global one is a deployment-gated decision, not a bug.',
  'User.firebaseUid_1':
    'Firebase UIDs are globally unique by construction — the identity provider ' +
    'issues them, not this platform.',
  'User.empCode_1':
    'Employee codes are Abhigyan-specific and sparse. Flagged for review before ' +
    'a second organization uses them; see the readiness report.',
};

interface Row {
  model: string;
  index: string;
  keys: string;
  tenantScoped: boolean;
  verdict: 'OK' | 'SAFE-BY-KEY' | 'INTENTIONAL' | 'NEEDS-SCOPING';
  note?: string;
}

/**
 * Is every key in this index a globally unique identifier?
 *
 * ── The distinction that separates noise from defects ───────────────────────
 * An ObjectId is unique across the whole deployment by construction, so a
 * unique index on one — or on several — CANNOT collide between organizations.
 * `Attempt { examId, userId }` is a correct constraint and always was.
 *
 * A unique index on a business VALUE is the opposite. `Holiday.date` means one
 * holiday per date for the entire platform; `AttendanceRule.role` means one
 * rule per role for every institute that will ever exist. Those are the ones
 * worth finding, and they are invisible in a list that also contains thirty
 * ObjectId compounds.
 */
/**
 * Paths declared as `String` that in fact hold a globally unique identifier.
 *
 * Each was read at its assignment site. A stringified ObjectId is exactly as
 * unique as an ObjectId; what matters is the VALUE, and Mongoose cannot tell us
 * that. Listing them here forces the reading rather than allowing a guess.
 */
const STRING_IDENTIFIERS = new Set([
  // `String(knowledgeGraphId || generationId)` — both ObjectIds.
  'RagChunk.scopeId',
  // A stringified user id.
  'EOD.teacherId',
  // Embeds the owner id and the document id, both ObjectIds.
  'FileMetadata.storagePath',
  // A generated public share token, unique by design — it is the URL.
  'ScholarshipTest.shareLink',
  // A generated attempt token, unique by design.
  'ScholarshipAttempt.attemptId',
  // A stringified test id.
  'ScholarshipAttempt.scholarshipTestId',
]);

function isIdentifier(model: string, schema: mongoose.Schema, key: string): boolean {
  if (STRING_IDENTIFIERS.has(`${model}.${key}`)) return true;
  const path = schema.path(key);
  if (!path) return false;
  return (path as unknown as { instance?: string }).instance === 'ObjectId';
}

/**
 * Does this index contain at least one globally unique key?
 *
 * ANY, not EVERY. A unique index on `{ studentId, courseId, lectureId }` cannot
 * collide across organizations the moment `studentId` is an ObjectId, whatever
 * the other keys are — one globally unique component is enough to make the
 * whole tuple globally unique.
 *
 * Requiring EVERY key to be an identifier flagged twenty correct indexes and
 * buried the four real defects among them, which is how an audit trains people
 * to ignore it.
 */
function containsIdentifier(
  model: string,
  schema: mongoose.Schema,
  keyNames: string[],
): boolean {
  return keyNames.some((key) => isIdentifier(model, schema, key));
}

let failures = 0;

function main() {
  // Compile every model through the real import graph.
  const modelsDir = join(process.cwd(), 'src', 'models');
  for (const file of readdirSync(modelsDir)) {
    if (!file.endsWith('.ts')) continue;
    try {
      require(join(modelsDir, file));
    } catch {
      // A model that cannot be imported standalone is covered by
      // verify-tenant-coverage, which loads the whole app.
    }
  }

  const rows: Row[] = [];

  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    const schema = model.schema;
    const isTenant = !NON_TENANT_MODELS.has(name);

    // `schema.indexes()` returns declared compound/secondary indexes. Unique
    // constraints declared inline on a path (`unique: true`) do not appear
    // there, so both sources are read.
    const declared: { keys: Record<string, unknown>; options: Record<string, unknown> }[] = (
      schema.indexes() as unknown as [Record<string, unknown>, Record<string, unknown>][]
    ).map(([keys, options]) => ({ keys, options: options ?? {} }));

    schema.eachPath((path, type) => {
      const options = (type as unknown as { options?: Record<string, unknown> }).options ?? {};
      if (options.unique) declared.push({ keys: { [path]: 1 }, options });
    });

    for (const entry of declared) {
      if (!entry.options.unique) continue;

      const keyNames = Object.keys(entry.keys);
      const indexName = `${name}.${keyNames.map((k) => `${k}_${entry.keys[k]}`).join('_')}`;
      const scoped = keyNames.includes('orgId');

      let verdict: Row['verdict'];
      let note: string | undefined;

      if (!isTenant) {
        verdict = 'OK';
        note = 'global/platform collection';
      } else if (scoped) {
        verdict = 'OK';
        note = 'compound with orgId';
      } else {
        // Match on the model + first key, the form the INTENTIONAL table uses.
        const lookup = `${name}.${keyNames[0]}_1`;
        if (INTENTIONAL[lookup]) {
          verdict = 'INTENTIONAL';
          note = INTENTIONAL[lookup];
        } else if (containsIdentifier(name, schema, keyNames)) {
          verdict = 'SAFE-BY-KEY';
          note = 'contains a globally unique key';
        } else {
          verdict = 'NEEDS-SCOPING';
          note = `keyed on a business value: ${keyNames.join(', ')}`;
          failures++;
        }
      }

      rows.push({
        model: name,
        index: indexName,
        keys: keyNames.join(', '),
        tenantScoped: scoped,
        verdict,
        note,
      });
    }
  }

  console.log(`Unique-index audit — ${mongoose.modelNames().length} models compiled\n`);

  const groups: Row['verdict'][] = ['NEEDS-SCOPING', 'INTENTIONAL', 'SAFE-BY-KEY', 'OK'];
  for (const verdict of groups) {
    const group = rows.filter((r) => r.verdict === verdict);
    if (!group.length) continue;
    console.log(`${verdict} (${group.length})`);
    for (const row of group) {
      console.log(`  ${row.index.padEnd(42)} [${row.keys}]`);
      if (row.note && verdict !== 'OK' && verdict !== 'SAFE-BY-KEY') {
        console.log(`      ${row.note.slice(0, 150)}${row.note.length > 150 ? '…' : ''}`);
      }
    }
    console.log('');
  }

  if (failures) {
    console.error(
      `INDEX AUDIT FAILED — ${failures} unique index(es) on tenant collections are not\n` +
        `scoped by orgId and not justified.\n\n` +
        `For each one, either:\n` +
        `  • add a compound { orgId, <key> } index to the model and register the\n` +
        `    legacy one in scripts/safety/drop-legacy-global-indexes.ts, or\n` +
        `  • add it to INTENTIONAL in this file with the reason it must stay global.\n\n` +
        `Do NOT drop a production index to make this pass. The migration order is\n` +
        `create replacement -> verify -> only then remove.`,
    );
    process.exit(1);
  }

  console.log(`Index audit passed — ${rows.length} unique indexes, none unscoped without reason.`);
  process.exit(0);
}

main();
