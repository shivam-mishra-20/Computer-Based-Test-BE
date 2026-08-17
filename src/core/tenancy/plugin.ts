/**
 * The global Mongoose tenant plugin.
 *
 * Applied to every schema in the process, so tenant scoping happens at the
 * driver layer rather than at 805 individual call sites. A developer cannot
 * forget it, because there is nothing for them to remember.
 *
 * ── Read/write asymmetry, and why it is the crux of the migration ───────────
 * Stamping a write is ADDITIVE: it sets a field on a document being created
 * anyway, and nothing reads that field until enforce mode.
 *
 * Filtering a read is SUBTRACTIVE: it removes documents from a result set.
 * During the warn period `orgId` has not been backfilled, so almost no document
 * carries it — adding `{ orgId: X }` to a read at that moment matches nothing
 * and every screen in production goes blank.
 *
 * Therefore: warn mode stamps writes and NEVER touches reads. That asymmetry is
 * what makes this deployable to a live system on day one.
 *
 * ── What this plugin cannot protect ─────────────────────────────────────────
 * `$lookup` inside an aggregation pipeline reaches into another collection
 * without going through that collection's middleware. The plugin scopes the
 * pipeline's own collection and cannot scope the joined one. Every `$lookup`
 * needs its own `orgId` match inside the sub-pipeline, and that is a permanent
 * code-review item rather than something enforced here.
 */

import type { Schema, Query, Aggregate, Document } from 'mongoose';
import { currentOrgId, getTenantContext, inUnscopedBlock, unscopedReason } from './context';
import {
  shouldFilterReads,
  shouldStampWrites,
  shouldThrowOnMissingContext,
  tenantEnforcement,
} from './config';
import { TenantContextMissing } from './errors';

/**
 * Query operations that READ or NARROW an existing set. These are the ones
 * that leak data across tenants when unscoped.
 */
const SCOPED_QUERY_OPS = [
  'count',
  'countDocuments',
  'deleteMany',
  'deleteOne',
  'distinct',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndRemove',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'update',
  'updateMany',
  'updateOne',
] as const;

/** Telemetry for the warn period. The "warn log clean for 7 days" gate needs
 *  something countable, not an impression from reading logs. */
export interface UnscopedEvent {
  model: string;
  operation: string;
  count: number;
  lastSeenAt: string;
  sampleStack?: string;
}

const unscopedEvents = new Map<string, UnscopedEvent>();

export function getUnscopedReport(): UnscopedEvent[] {
  return [...unscopedEvents.values()].sort((a, b) => b.count - a.count);
}

export function resetUnscopedReport(): void {
  unscopedEvents.clear();
}

const LOG_SAMPLE_LIMIT = 3;

function recordUnscoped(model: string, operation: string): void {
  const key = `${model}.${operation}`;
  const existing = unscopedEvents.get(key);

  if (existing) {
    existing.count++;
    existing.lastSeenAt = new Date().toISOString();
    // Log the first few only. An unscoped query inside a hot loop would
    // otherwise produce megabytes of identical lines and bury everything else.
    if (existing.count <= LOG_SAMPLE_LIMIT) {
      console.warn(`[tenancy:warn] unscoped ${key} (${existing.count})`);
    }
    return;
  }

  const stack = new Error().stack?.split('\n').slice(3, 8).join('\n');
  unscopedEvents.set(key, {
    model,
    operation,
    count: 1,
    lastSeenAt: new Date().toISOString(),
    sampleStack: stack,
  });
  console.warn(`[tenancy:warn] unscoped ${key}\n${stack ?? '  (no stack)'}`);
}

/**
 * Should this schema participate in tenant scoping?
 *
 * A handful of collections are legitimately global: the organization registry
 * itself, platform staff, and the plan/module catalogue. They opt out with
 * `new Schema({...}, { tenantScoped: false })`.
 */
function isTenantScoped(schema: Schema): boolean {
  return (schema.options as Record<string, unknown>).tenantScoped !== false;
}

function modelNameOf(thing: { model?: { modelName?: string }; modelName?: string }): string {
  return thing?.model?.modelName || thing?.modelName || 'UnknownModel';
}

export function tenantPlugin(schema: Schema): void {
  if (!isTenantScoped(schema)) return;
  if ((schema as unknown as { __tenantPluginApplied?: boolean }).__tenantPluginApplied) return;
  (schema as unknown as { __tenantPluginApplied?: boolean }).__tenantPluginApplied = true;

  // ── Schema fields ────────────────────────────────────────────────────────
  // OPTIONAL in P1. Making it required before the backfill completes would
  // reject every write from the moment this ships. It becomes required in a
  // later, separate migration once no document is missing it.
  schema.add({
    orgId: {
      type: String,
      index: true,
      required: false,
    },
    // Schema-only in P1: no branch UI, no branch filtering, no branch pricing.
    // Added now because a second nullable key costs almost nothing during a
    // migration that already rewrites every model, and retrofitting it later
    // means a second full pass and a second production cutover.
    branchId: {
      type: String,
      index: true,
      required: false,
      default: null,
    },
  });

  // ── Reads and narrowing operations ───────────────────────────────────────
  // Registered one op at a time: mongoose's typings accept a single hook name
  // or a RegExp, not an array of names.
  const scopeQuery = function (this: Query<unknown, unknown>) {
    const model = modelNameOf(this as never);
    const operation = (this as unknown as { op?: string }).op || 'query';

    if (tenantEnforcement() === 'off') return;

    // An explicit opt-out. Nothing to do — the caller has taken responsibility
    // and named a reason that shows up in a grep audit.
    if (inUnscopedBlock()) return;

    const orgId = currentOrgId();

    if (!orgId) {
      if (shouldThrowOnMissingContext()) {
        throw new TenantContextMissing(model, operation);
      }
      recordUnscoped(model, operation);
      return;
    }

    // See the header comment: warn mode observes, it does not subtract.
    if (!shouldFilterReads()) return;

    this.where({ orgId });
  };

  for (const op of SCOPED_QUERY_OPS) {
    schema.pre(op as never, scopeQuery);
  }

  // ── Aggregations ─────────────────────────────────────────────────────────
  schema.pre('aggregate', function (this: Aggregate<unknown[]>) {
    const model = modelNameOf(this as never);
    if (tenantEnforcement() === 'off') return;
    if (inUnscopedBlock()) return;

    const orgId = currentOrgId();
    if (!orgId) {
      if (shouldThrowOnMissingContext()) {
        throw new TenantContextMissing(model, 'aggregate');
      }
      recordUnscoped(model, 'aggregate');
      return;
    }
    if (!shouldFilterReads()) return;

    // Prepended, not appended: a $match placed after a $group or a $limit
    // filters the wrong thing — or nothing, because the tenant field no longer
    // exists in the shape by that point.
    this.pipeline().unshift({ $match: { orgId } });
  });

  // ── Document creation ────────────────────────────────────────────────────
  schema.pre('save', function (this: Document & { orgId?: string }) {
    if (!shouldStampWrites()) return;
    if (inUnscopedBlock()) return;
    if (this.orgId) return; // already attributed — respect an explicit value

    const context = getTenantContext();
    if (!context) {
      if (shouldThrowOnMissingContext()) {
        throw new TenantContextMissing(this.constructor.name ?? 'Document', 'save');
      }
      return;
    }
    this.orgId = context.orgId;
    if (context.branchId !== undefined) {
      (this as { branchId?: string | null }).branchId = context.branchId ?? null;
    }
  });

  // ── Bulk inserts ─────────────────────────────────────────────────────────
  // insertMany bypasses `save` entirely, so it needs its own hook. Import
  // pipelines and the backfill both use it heavily; without this, bulk-created
  // documents would be the one category that silently never gets an orgId.
  schema.pre('insertMany', function (next: (err?: Error) => void, docs: unknown) {
    if (!shouldStampWrites() || inUnscopedBlock() || !Array.isArray(docs)) return next();

    const context = getTenantContext();
    if (!context) {
      if (shouldThrowOnMissingContext()) {
        return next(new TenantContextMissing(modelNameOf(this as never), 'insertMany'));
      }
      return next();
    }

    for (const doc of docs as Record<string, unknown>[]) {
      if (doc && typeof doc === 'object' && !doc.orgId) {
        doc.orgId = context.orgId;
        if (context.branchId !== undefined && doc.branchId === undefined) {
          doc.branchId = context.branchId ?? null;
        }
      }
    }
    next();
  });

  // ── Upserts ──────────────────────────────────────────────────────────────
  // An upsert that misses becomes an INSERT, and that insert does not pass
  // through `save`. Without stamping the update payload, an upsert is a second
  // silent route to an unattributed document.
  const stampUpsert = function (this: Query<unknown, unknown>) {
    if (!shouldStampWrites() || inUnscopedBlock()) return;
    if (!(this.getOptions() || {}).upsert) return;

    const context = getTenantContext();
    if (!context) return;

    const update = (this.getUpdate() || {}) as Record<string, unknown>;
    const setOnInsert = (update.$setOnInsert || {}) as Record<string, unknown>;
    if (!setOnInsert.orgId) {
      setOnInsert.orgId = context.orgId;
      update.$setOnInsert = setOnInsert;
      this.setUpdate(update);
    }
  };

  for (const op of ['findOneAndUpdate', 'updateOne', 'updateMany'] as const) {
    schema.pre(op as never, stampUpsert);
  }
}

/** For diagnostics: is the active configuration observing or enforcing? */
export function tenancyStatus(): { enforcement: string; unscopedOperations: number } {
  return {
    enforcement: tenantEnforcement(),
    unscopedOperations: [...unscopedEvents.values()].reduce((sum, e) => sum + e.count, 0),
  };
}

/** Present for symmetry with the docs; the reason is logged on entry. */
export { unscopedReason };
